import type { VerifiedKey } from "./auth.ts";
import {
  dispatchJob,
  type JobResult,
  ServiceUnavailableError,
  type StreamEvent,
} from "./dispatch.ts";
import { availableModels } from "./workers.ts";

const encoder = new TextEncoder();

/** POST /v1/chat/completions */
export async function handleChatCompletions(req: Request, key: VerifiedKey): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const model = body.model as string;
  if (!model) return jsonError("Missing 'model' field", 400);

  const messages = body.messages;
  if (!Array.isArray(messages)) return jsonError("Missing 'messages' array", 400);

  const streaming = body.stream === true;
  const maxTokens = (body.max_tokens as number) ?? undefined;
  const temperature = (body.temperature as number) ?? undefined;
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : undefined;
  const toolChoice = body.tool_choice;
  const streamOptions = body.stream_options as { include_usage?: boolean } | undefined;
  const includeUsage = streamOptions?.include_usage === true;

  try {
    const result = dispatchJob({
      organizationId: key.organizationId,
      task: "chat",
      model,
      input: messages,
      streaming,
      maxTokens,
      temperature,
      tools,
      toolChoice,
    });

    if ("stream" in result) {
      const sseStream = openAIStreamToSSE(result.stream, result.jobId, model, includeUsage);
      return new Response(sseStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    const jobResult: JobResult = await result.promise;

    const message: Record<string, unknown> = {
      role: "assistant",
      content: jobResult.content || null,
    };
    if (jobResult.toolCalls.length > 0) {
      message.tool_calls = jobResult.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }

    const promptTokens = jobResult.usage?.promptTokens ?? 0;
    const completionTokens = jobResult.usage?.completionTokens ?? 0;
    return Response.json({
      id: `chatcmpl-${result.jobId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: jobResult.finishReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  } catch (err) {
    if (err instanceof ServiceUnavailableError) {
      return jsonError(err.message, 503);
    }
    return jsonError((err as Error).message ?? "Internal error", 500);
  }
}

/** Translate raw stream events to OpenAI chat.completion.chunk SSE bytes. */
function openAIStreamToSSE(
  source: ReadableStream<StreamEvent>,
  jobId: string,
  model: string,
  includeUsage: boolean,
): ReadableStream<Uint8Array> {
  const created = Math.floor(Date.now() / 1000);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      const writeData = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const writeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
        writeData({
          id: `chatcmpl-${jobId}`,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
      };

      // Keep the connection alive across cold-start model loads (which can
      // take 30s+ before the worker sends its first delta). SSE comments are
      // spec-valid and ignored by parsers, but they push bytes through so
      // proxies and client fetch implementations don't idle-time out the
      // stream. Interval is set below Bun's default 10s socket idleTimeout —
      // longer gaps cause Bun to close the TCP socket without sending the
      // chunked-encoding terminator, which upstream proxies (e.g. Envoy) see
      // as upstream_cx_protocol_error and translate to an HTTP/2 RST_STREAM
      // with INTERNAL_ERROR.
      controller.enqueue(encoder.encode(`:ok\n\n`));
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`:ping\n\n`));
        } catch {
          // Stream already closed — interval will be cleared in `finally`.
        }
      }, 5000);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.type === "delta") {
            const delta: Record<string, unknown> = {};
            if (value.content) delta.content = value.content;
            if (value.toolCalls && value.toolCalls.length > 0) {
              delta.tool_calls = value.toolCalls.map((tc) => ({
                index: tc.index,
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: tc.arguments,
                },
              }));
            }
            if (Object.keys(delta).length > 0) writeChunk(delta);
          } else if (value.type === "done") {
            writeChunk({}, value.finishReason);
            // Per OpenAI spec, when stream_options.include_usage is set, emit
            // a final chunk with empty choices and a usage object.
            if (includeUsage) {
              const promptTokens = value.usage?.promptTokens ?? 0;
              const completionTokens = value.usage?.completionTokens ?? 0;
              writeData({
                id: `chatcmpl-${jobId}`,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [],
                usage: {
                  prompt_tokens: promptTokens,
                  completion_tokens: completionTokens,
                  total_tokens: promptTokens + completionTokens,
                },
              });
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } else if (value.type === "error") {
            const err = `data: ${JSON.stringify({ error: { message: value.message, type: "server_error" } })}\n\n`;
            controller.enqueue(encoder.encode(err));
          }
        }
      } catch (err) {
        const errEvent = `data: ${JSON.stringify({ error: { message: (err as Error).message, type: "server_error" } })}\n\n`;
        controller.enqueue(encoder.encode(errEvent));
      } finally {
        clearInterval(keepalive);
        controller.close();
      }
    },
  });
}

/** POST /v1/embeddings */
export async function handleEmbeddings(req: Request, key: VerifiedKey): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const model = body.model as string;
  if (!model) return jsonError("Missing 'model' field", 400);

  const input = body.input;
  if (input === undefined) return jsonError("Missing 'input' field", 400);

  try {
    const result = dispatchJob({
      organizationId: key.organizationId,
      task: "embedding",
      model,
      input,
      streaming: false,
    });

    if (!("promise" in result)) {
      return jsonError("Unexpected streaming result for embeddings", 500);
    }

    const jobResult: JobResult = await result.promise;
    if (!jobResult.embedding) {
      return jsonError("Worker did not return an embedding", 500);
    }

    return Response.json({
      object: "list",
      data: [
        {
          object: "embedding",
          index: 0,
          embedding: jobResult.embedding,
        },
      ],
      model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    if (err instanceof ServiceUnavailableError) {
      return jsonError(err.message, 503);
    }
    return jsonError((err as Error).message ?? "Internal error", 500);
  }
}

/** POST /v1/images/generations */
export async function handleImageGenerations(req: Request, key: VerifiedKey): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const model = body.model;
  if (typeof model !== "string" || model.length === 0) {
    return jsonError("Missing 'model' field", 400);
  }

  const prompt = body.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) {
    return jsonError("Missing 'prompt' field", 400);
  }

  const size = typeof body.size === "string" ? body.size : undefined;
  const n = typeof body.n === "number" ? body.n : undefined;
  const quality = typeof body.quality === "string" ? body.quality : undefined;
  const style = typeof body.style === "string" ? body.style : undefined;
  const responseFormatRaw = body.response_format;
  const responseFormat =
    responseFormatRaw === "url" || responseFormatRaw === "b64_json"
      ? responseFormatRaw
      : undefined;
  const streaming = body.stream === true;

  try {
    const result = dispatchJob({
      organizationId: key.organizationId,
      task: "image",
      model,
      input: prompt,
      streaming: false,
      image: { size, n, quality, style, responseFormat },
    });

    if (!("promise" in result)) {
      return jsonError("Unexpected streaming result for images", 500);
    }

    if (streaming) {
      return streamImageJobAsSSE(result.promise, { size, quality });
    }

    const jobResult: JobResult = await result.promise;
    if (!jobResult.images || jobResult.images.length === 0) {
      return jsonError("Worker did not return any images", 500);
    }

    return Response.json({
      created: Math.floor(Date.now() / 1000),
      data: jobResult.images.map((img) => {
        const out: Record<string, unknown> = {};
        if (img.url !== undefined) out.url = img.url;
        if (img.b64 !== undefined) out.b64_json = img.b64;
        if (img.revisedPrompt !== undefined) out.revised_prompt = img.revisedPrompt;
        return out;
      }),
    });
  } catch (err) {
    if (err instanceof ServiceUnavailableError) {
      return jsonError(err.message, 503);
    }
    return jsonError((err as Error).message ?? "Internal error", 500);
  }
}

/**
 * Wrap a pending image-generation job as an OpenAI-compatible SSE stream.
 *
 * The stream flushes response headers immediately (so Cloudflare and any
 * other reverse proxy with a request-to-headers idle timeout don't 524 on us
 * during a long generation — Lemonade alone warns "~4-5 min per image" on
 * CPU), keeps the connection warm with `:hb` SSE comments every 5s while the
 * worker is busy, then emits one `image_generation.completed` event per
 * returned image followed by the OpenAI `[DONE]` sentinel.
 *
 * We do not emit `image_generation.partial_image` events: the worker protocol
 * delivers a single completed image and the upstream backends shoal supports
 * today don't expose progressive renders on /v1/images/generations. OpenAI's
 * spec permits zero partials when the client requested some — matches their
 * own behavior on models that don't support intermediates — so this is still
 * a compliant stream.
 */
function streamImageJobAsSSE(
  promise: Promise<JobResult>,
  meta: { size?: string; quality?: string },
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writeData = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller already closed (client disconnected) — nothing to do
        }
      };
      const writeComment = (text: string) => {
        try {
          controller.enqueue(encoder.encode(`: ${text}\n\n`));
        } catch {
          // see writeData
        }
      };

      // Flush headers and start the body immediately. Without this the
      // response sits buffered until the first real event, defeating the
      // whole point of streaming for proxy-timeout purposes.
      writeComment("ok");
      // Heartbeat cadence must stay under any reverse-proxy idle timeout in
      // the path. Cloudflare's free-tier proxy times the origin out at 100s
      // of silence; 5s gives a comfortable margin and matches the SSE
      // keepalive cadence used elsewhere in shoal.
      const heartbeat = setInterval(() => writeComment("hb"), 5_000);

      try {
        const jobResult = await promise;
        if (!jobResult.images || jobResult.images.length === 0) {
          writeData({
            type: "error",
            error: { message: "Worker did not return any images" },
          });
        } else {
          const createdAt = Math.floor(Date.now() / 1000);
          for (const img of jobResult.images) {
            const event: Record<string, unknown> = {
              type: "image_generation.completed",
              created_at: createdAt,
            };
            if (img.b64 !== undefined) event.b64_json = img.b64;
            if (img.url !== undefined) event.url = img.url;
            if (img.revisedPrompt !== undefined) {
              event.revised_prompt = img.revisedPrompt;
            }
            if (meta.size !== undefined) event.size = meta.size;
            if (meta.quality !== undefined) event.quality = meta.quality;
            writeData(event);
          }
        }
      } catch (err) {
        const message =
          err instanceof ServiceUnavailableError
            ? err.message
            : ((err as Error).message ?? "Internal error");
        writeData({ type: "error", error: { message } });
      } finally {
        clearInterval(heartbeat);
        // OpenAI's SSE convention: a final `[DONE]` sentinel after the last
        // event. Their own SDKs treat the stream as terminated either by
        // this or by socket close; sending both is the safe default.
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** POST /v1/audio/speech */
export async function handleSpeech(req: Request, key: VerifiedKey): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const model = body.model;
  if (typeof model !== "string" || model.length === 0) {
    return jsonError("Missing 'model' field", 400);
  }

  const input = body.input;
  if (typeof input !== "string" || input.length === 0) {
    return jsonError("Missing 'input' field", 400);
  }

  const voice = typeof body.voice === "string" ? body.voice : undefined;
  const responseFormat = typeof body.response_format === "string" ? body.response_format : undefined;
  const speed = typeof body.speed === "number" ? body.speed : undefined;
  const instructions = typeof body.instructions === "string" ? body.instructions : undefined;

  try {
    const result = dispatchJob({
      organizationId: key.organizationId,
      task: "tts",
      model,
      input,
      streaming: false,
      tts: { voice, responseFormat, speed, instructions },
    });

    if (!("promise" in result)) {
      return jsonError("Unexpected streaming result for tts", 500);
    }

    const jobResult: JobResult = await result.promise;
    if (!jobResult.audio) {
      return jsonError("Worker did not return audio", 500);
    }

    const bytes = Buffer.from(jobResult.audio.b64, "base64");
    return new Response(bytes, {
      headers: {
        "Content-Type": jobResult.audio.mimeType,
        "Content-Length": String(bytes.byteLength),
      },
    });
  } catch (err) {
    if (err instanceof ServiceUnavailableError) {
      return jsonError(err.message, 503);
    }
    return jsonError((err as Error).message ?? "Internal error", 500);
  }
}

/** GET /v1/models */
export function handleModels(key: VerifiedKey): Response {
  const models = availableModels(key.organizationId).map((id) => ({
    id,
    object: "model",
    created: 0,
    owned_by: "worker",
  }));

  return Response.json({
    object: "list",
    data: models,
  });
}

function jsonError(message: string, status: number): Response {
  return Response.json(
    { error: { message, type: "error", code: status } },
    { status },
  );
}
