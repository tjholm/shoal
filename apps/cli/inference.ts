/**
 * Inference engine that proxies to a local OpenAI-compatible endpoint (e.g. Ollama).
 *
 * The worker doesn't run inference itself — it forwards requests to whatever
 * is running on the configured backend URL and streams chunks back.
 */

let currentModel: string | null = null;
let backendUrl = "http://localhost:11434"; // Ollama default

export function setBackendUrl(url: string): void {
  backendUrl = url.replace(/\/+$/, "");
}

export async function fetchAvailableModels(): Promise<string[]> {
  const res = await fetch(`${backendUrl}/v1/models`);
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status} from /v1/models`);
  }
  const json = (await res.json()) as { data: Array<{ id: string }> };
  return json.data.map((m) => m.id);
}

export function getLoadedModel(): string | null {
  return currentModel;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export type ChatChunk =
  | { content?: string; toolCalls?: ToolCallDelta[] }
  | { done: true; finishReason: "stop" | "length" | "tool_calls"; usage?: Usage };

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  tools?: unknown[];
  toolChoice?: unknown;
}

/**
 * Run chat inference via the backend. Yields OpenAI-shaped delta fragments
 * (content text and/or tool_call slices) as they stream in.
 */
export async function* chatInference(
  model: string,
  messages: unknown[],
  options?: ChatOptions,
  signal?: AbortSignal,
): AsyncGenerator<ChatChunk> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    // Ask the backend to emit a final usage chunk. Supported by Ollama's
    // OpenAI shim, vLLM, llama.cpp server, OpenAI itself. Backends that
    // don't recognize it ignore the field, and we report no usage.
    stream_options: { include_usage: true },
    max_tokens: options?.maxTokens ?? 512,
    temperature: options?.temperature ?? 1.0,
  };
  if (options?.tools && options.tools.length > 0) body.tools = options.tools;
  if (options?.toolChoice !== undefined) body.tool_choice = options.toolChoice;

  const res = await fetch(`${backendUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Backend returned ${res.status}: ${errBody}`);
  }

  currentModel = model;

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finishReason: "stop" | "length" | "tool_calls" = "stop";
  let usage: Usage | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);

        // Terminal usage chunk: choices is empty/absent, usage is set.
        if (parsed.usage && typeof parsed.usage === "object") {
          const u = parsed.usage as { prompt_tokens?: number; completion_tokens?: number };
          if (typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") {
            usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens };
          }
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason === "length") finishReason = "length";
        else if (choice.finish_reason === "tool_calls") finishReason = "tool_calls";
        else if (choice.finish_reason === "stop") finishReason = "stop";

        const delta = choice.delta;
        if (!delta) continue;

        const out: { content?: string; toolCalls?: ToolCallDelta[] } = {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          out.content = delta.content;
        }
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          out.toolCalls = delta.tool_calls.map((tc: {
            index: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }) => ({
            index: tc.index,
            id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments,
          }));
        }
        if (out.content !== undefined || out.toolCalls !== undefined) {
          yield out;
        }
      } catch {
        // Malformed SSE chunk, skip.
      }
    }
  }

  yield { done: true, finishReason, usage };
}

export async function embeddingInference(
  model: string,
  input: string | string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const res = await fetch(`${backendUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Backend returned ${res.status}: ${body}`);
  }

  currentModel = model;

  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data.map((d) => d.embedding);
}
