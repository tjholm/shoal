import type { VerifiedKey } from "./auth.ts";
import {
  dispatchJob,
  type JobResult,
  ServiceUnavailableError,
  type StreamEvent,
} from "./dispatch.ts";

const encoder = new TextEncoder();

// --- Anthropic <-> OpenAI shape translation ---

interface AnthropicTextBlock { type: "text"; text: string }
interface AnthropicToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | { type: "text"; text: string }[];
  is_error?: boolean;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function systemToOpenAIMessages(system: unknown): OpenAIMessage[] {
  if (!system) return [];
  if (typeof system === "string") {
    return system.length > 0 ? [{ role: "system", content: system }] : [];
  }
  if (Array.isArray(system)) {
    const text = system
      .filter((b): b is AnthropicTextBlock => typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
      .map((b) => b.text)
      .join("");
    return text.length > 0 ? [{ role: "system", content: text }] : [];
  }
  return [];
}

function anthropicToOpenAIMessages(messages: AnthropicMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === "user") {
      // User turn: split tool_result blocks into separate `tool` messages,
      // collapse text blocks into a single `user` message.
      const textParts: string[] = [];
      const toolMessages: OpenAIMessage[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : block.content.map((c) => c.text).join("");
          toolMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content,
          });
        }
      }
      if (textParts.length > 0) {
        out.push({ role: "user", content: textParts.join("") });
      }
      out.push(...toolMessages);
      continue;
    }

    // Assistant turn: text -> content, tool_use -> tool_calls.
    const textParts: string[] = [];
    const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }
    const assistantMsg: OpenAIMessage = {
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("") : null,
    };
    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
    out.push(assistantMsg);
  }

  return out;
}

function anthropicToOpenAITools(tools: AnthropicTool[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function mapToolChoice(tc: unknown): unknown {
  if (!tc || typeof tc !== "object") return undefined;
  const t = (tc as { type?: string }).type;
  if (t === "auto") return "auto";
  if (t === "any") return "required";
  if (t === "none") return "none";
  if (t === "tool") {
    const name = (tc as { name?: string }).name;
    if (name) return { type: "function", function: { name } };
  }
  return undefined;
}

function mapStopReason(reason: "stop" | "length" | "tool_calls"): string {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  return "end_turn";
}

// --- Request handlers ---

/** POST /v1/messages */
export async function handleMessages(req: Request, key: VerifiedKey): Promise<Response> {
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
  const maxTokens = body.max_tokens as number | undefined;
  const temperature = body.temperature as number | undefined;

  const openaiMessages = [
    ...systemToOpenAIMessages(body.system),
    ...anthropicToOpenAIMessages(messages as AnthropicMessage[]),
  ];

  const tools =
    Array.isArray(body.tools) && body.tools.length > 0
      ? anthropicToOpenAITools(body.tools as AnthropicTool[])
      : undefined;
  const toolChoice = mapToolChoice(body.tool_choice);

  try {
    const result = dispatchJob({
      organizationId: key.organizationId,
      task: "chat",
      model,
      input: openaiMessages,
      streaming,
      maxTokens,
      temperature,
      tools,
      toolChoice,
    });

    if ("stream" in result) {
      const sseStream = openAIStreamToAnthropicSSE(result.stream, result.jobId, model);
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
    return Response.json(buildAnthropicMessage(result.jobId, model, jobResult));
  } catch (err) {
    if (err instanceof ServiceUnavailableError) {
      return jsonError(err.message, 503);
    }
    return jsonError((err as Error).message ?? "Internal error", 500);
  }
}

function buildAnthropicMessage(jobId: string, model: string, r: JobResult) {
  const content: unknown[] = [];
  if (r.content.length > 0) content.push({ type: "text", text: r.content });
  for (const tc of r.toolCalls) {
    let input: unknown = {};
    try {
      input = tc.arguments ? JSON.parse(tc.arguments) : {};
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }

  return {
    id: `msg_${jobId}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(r.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: r.usage?.promptTokens ?? 0,
      output_tokens: r.usage?.completionTokens ?? 0,
    },
  };
}

// --- Streaming translator ---

interface ToolCallStreamState {
  /** Anthropic content_block index assigned to this tool call. */
  blockIndex: number;
  id: string;
  name: string;
  /** Buffered arguments fragments not yet emitted (waiting on id+name). */
  pendingArgs: string;
  started: boolean;
}

/**
 * Translate the dispatch's raw event stream into an Anthropic SSE event stream.
 *
 * Anthropic uses ordered content blocks. We emit:
 *   message_start
 *   content_block_start (text, index 0)  -- only once we see actual text
 *   content_block_delta (text_delta) ... for each content fragment
 *   content_block_stop
 *   for each tool call (in order seen):
 *     content_block_start (tool_use)
 *     content_block_delta (input_json_delta)*
 *     content_block_stop
 *   message_delta (with stop_reason)
 *   message_stop
 *
 * OpenAI tool_call deltas can interleave with text and arrive in arg fragments;
 * we buffer them by index and emit Anthropic's input_json_delta as new bytes
 * accumulate, so partial JSON streams to the client.
 */
function openAIStreamToAnthropicSSE(
  source: ReadableStream<StreamEvent>,
  jobId: string,
  model: string,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();

      const emit = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // Keep the connection alive during cold-start model loads. Interval is
      // set below Bun's default 10s socket idleTimeout — longer gaps cause
      // Bun to close the TCP socket without sending the chunked-encoding
      // terminator, which upstream proxies (e.g. Envoy) see as
      // upstream_cx_protocol_error and translate to an HTTP/2 RST_STREAM with
      // INTERNAL_ERROR.
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`:ping\n\n`));
        } catch {
          // Stream already closed — interval will be cleared in `finally`.
        }
      }, 5000);

      emit("message_start", {
        type: "message_start",
        message: {
          id: `msg_${jobId}`,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      let textBlockOpen = false;
      let nextBlockIndex = 0;
      let textBlockIndex = -1;
      // Keyed by the upstream call index (stable across all fragments of the
      // same call). Block index is assigned in first-seen order.
      const toolStates = new Map<number, ToolCallStreamState>();
      let stopReason: "stop" | "length" | "tool_calls" = "stop";
      let usage: { promptTokens: number; completionTokens: number } | undefined;
      let errored = false;

      const closeTextBlock = () => {
        if (textBlockOpen) {
          emit("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
          textBlockOpen = false;
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value.type === "delta") {
            if (value.content) {
              if (!textBlockOpen) {
                textBlockIndex = nextBlockIndex++;
                emit("content_block_start", {
                  type: "content_block_start",
                  index: textBlockIndex,
                  content_block: { type: "text", text: "" },
                });
                textBlockOpen = true;
              }
              emit("content_block_delta", {
                type: "content_block_delta",
                index: textBlockIndex,
                delta: { type: "text_delta", text: value.content },
              });
            }

            if (value.toolCalls) {
              // Once a tool call appears, the text block (if any) is finalized.
              closeTextBlock();
              for (const tc of value.toolCalls) {
                let state = toolStates.get(tc.index);
                if (!state) {
                  state = {
                    blockIndex: nextBlockIndex++,
                    id: tc.id ?? "",
                    name: tc.name ?? "",
                    pendingArgs: "",
                    started: false,
                  };
                  toolStates.set(tc.index, state);
                } else {
                  if (tc.id) state.id = tc.id;
                  if (tc.name) state.name = tc.name;
                }

                if (!state.started && state.id && state.name) {
                  emit("content_block_start", {
                    type: "content_block_start",
                    index: state.blockIndex,
                    content_block: {
                      type: "tool_use",
                      id: state.id,
                      name: state.name,
                      input: {},
                    },
                  });
                  state.started = true;
                  // Flush any args buffered before id/name arrived.
                  if (state.pendingArgs.length > 0) {
                    emit("content_block_delta", {
                      type: "content_block_delta",
                      index: state.blockIndex,
                      delta: { type: "input_json_delta", partial_json: state.pendingArgs },
                    });
                    state.pendingArgs = "";
                  }
                }

                if (tc.arguments) {
                  if (state.started) {
                    emit("content_block_delta", {
                      type: "content_block_delta",
                      index: state.blockIndex,
                      delta: { type: "input_json_delta", partial_json: tc.arguments },
                    });
                  } else {
                    state.pendingArgs += tc.arguments;
                  }
                }
              }
            }
          } else if (value.type === "done") {
            stopReason = value.finishReason;
            usage = value.usage;
            break;
          } else if (value.type === "error") {
            errored = true;
            emit("error", {
              type: "error",
              error: { type: "api_error", message: value.message },
            });
            break;
          }
        }

        if (!errored) {
          closeTextBlock();
          for (const state of toolStates.values()) {
            if (!state.started) {
              // id/name never arrived — fall back so the client still gets a
              // well-formed block. Should not happen with a sane backend.
              emit("content_block_start", {
                type: "content_block_start",
                index: state.blockIndex,
                content_block: {
                  type: "tool_use",
                  id: state.id || `toolu_${state.blockIndex}`,
                  name: state.name || "unknown",
                  input: {},
                },
              });
              if (state.pendingArgs.length > 0) {
                emit("content_block_delta", {
                  type: "content_block_delta",
                  index: state.blockIndex,
                  delta: { type: "input_json_delta", partial_json: state.pendingArgs },
                });
              }
              state.started = true;
            }
            emit("content_block_stop", { type: "content_block_stop", index: state.blockIndex });
          }

          emit("message_delta", {
            type: "message_delta",
            delta: { stop_reason: mapStopReason(stopReason), stop_sequence: null },
            // Anthropic's message_delta carries cumulative output_tokens.
            // input_tokens are conventionally on message_start; we don't have
            // them until the stream ends, so we surface them here too — a
            // benign extension that real Anthropic clients ignore on delta.
            usage: {
              input_tokens: usage?.promptTokens ?? 0,
              output_tokens: usage?.completionTokens ?? 0,
            },
          });
          emit("message_stop", { type: "message_stop" });
        }
      } catch (err) {
        emit("error", {
          type: "error",
          error: { type: "api_error", message: (err as Error).message },
        });
      } finally {
        clearInterval(keepalive);
        controller.close();
      }
    },
  });
}

function jsonError(message: string, status: number): Response {
  return Response.json(
    { type: "error", error: { type: "invalid_request_error", message } },
    { status },
  );
}
