import { z } from "zod";

// --- Worker → Server messages ---

// Worker identity is assigned by the server at register time and never sent
// from the worker — server uses the authenticated peer binding for all
// subsequent messages, so a worker cannot reference another worker's id.
export const WorkerMessage = z.discriminatedUnion("type", [
  // First-time registration: server assigns workerId and returns a per-worker
  // secret that the worker persists for later `register_resume` calls.
  // `name`, if provided, becomes the worker's friendly name; omit to leave
  // the name unset (operator can set it from the dashboard later).
  z.object({
    type: z.literal("register_new"),
    maxConcurrent: z.number().int().positive(),
    name: z.string().optional(),
  }),
  // Reconnect with stored credentials. Server validates `secret` against the
  // hashed value on the worker row, scoped to the org from API key auth.
  // `name`, if provided, overwrites the stored name on every resume — i.e.
  // the worker's `--name` flag is authoritative when set, and a UI rename
  // only sticks until the operator restarts the worker with `--name` again.
  // Omit `name` to preserve whatever is in the DB.
  z.object({
    type: z.literal("register_resume"),
    workerId: z.string(),
    secret: z.string(),
    maxConcurrent: z.number().int().positive(),
    name: z.string().optional(),
  }),
  z.object({
    type: z.literal("stats"),
    loadedModel: z.string().nullable(),
    jobsCompleted: z.number(),
    uptimeMs: z.number(),
  }),
  z.object({
    type: z.literal("model_ready"),
    jobId: z.string(),
    model: z.string(),
  }),
  // Streaming chunk. `content` carries text fragments; `toolCalls` carries
  // function-call fragments where `arguments` is a JSON string slice that must
  // be concatenated by index across successive deltas.
  z.object({
    type: z.literal("delta"),
    jobId: z.string(),
    content: z.string().optional(),
    toolCalls: z
      .array(
        z.object({
          index: z.number().int().nonnegative(),
          id: z.string().optional(),
          name: z.string().optional(),
          arguments: z.string().optional(),
        }),
      )
      .optional(),
  }),
  // Single embedding vector for embedding tasks.
  z.object({
    type: z.literal("embedding"),
    jobId: z.string(),
    vector: z.array(z.number()),
  }),
  z.object({
    type: z.literal("done"),
    jobId: z.string(),
    finishReason: z.enum(["stop", "length", "tool_calls"]),
    // Token usage, if the backend reported it (Ollama / vLLM / llama.cpp
    // expose this when stream_options.include_usage is set, or always for
    // non-streaming responses). Absent if the backend didn't report usage.
    usage: z
      .object({
        promptTokens: z.number().int().nonnegative(),
        completionTokens: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("error"),
    jobId: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("models"),
    // Either the legacy `string[]` (old workers) or the new `{ id }[]` (current
    // workers). A given worker build only ever sends one form, so this is a
    // union of two array shapes rather than an array of a union — the wire
    // payload is never mixed. TODO(remove-legacy-models): drop the string
    // variant once all workers have shipped with the object form.
    models: z.union([
      z.array(z.string()),
      z.array(z.object({ id: z.string() })),
    ]),
  }),
  z.object({ type: z.literal("pong") }),
]);
export type WorkerMessage = z.infer<typeof WorkerMessage>;

/**
 * Canonical, normalized form of a model entry as stored on the server and
 * surfaced through the API/UI. Workers send either a bare string (deprecated)
 * or this object on the wire — `normalizeWorkerModels` collapses both into
 * this shape. Future capability fields (context window, family, etc.) will be
 * added here as optional properties.
 */
export interface WorkerModel {
  id: string;
}

/**
 * Collapse the legacy `string[]` and new `{ id }[]` wire forms into
 * `WorkerModel[]`. Returns the normalized list plus a `legacy` flag so the
 * caller can log a one-time deprecation notice per message.
 * TODO(remove-legacy-models): drop the string branch and the `legacy` flag.
 */
export function normalizeWorkerModels(
  models: ReadonlyArray<string> | ReadonlyArray<{ id: string }>,
): { models: WorkerModel[]; legacy: boolean } {
  if (models.length === 0) return { models: [], legacy: false };
  if (typeof models[0] === "string") {
    return {
      models: (models as ReadonlyArray<string>).map((id) => ({ id })),
      legacy: true,
    };
  }
  return {
    models: (models as ReadonlyArray<{ id: string }>).map((m) => ({ id: m.id })),
    legacy: false,
  };
}

// --- Server → Worker messages ---

export const ServerMessage = z.discriminatedUnion("type", [
  // `secret` is only present in response to register_new; on resume the worker
  // already has its credentials.
  z.object({
    type: z.literal("registered"),
    workerId: z.string(),
    secret: z.string().optional(),
  }),
  z.object({
    type: z.literal("infer"),
    jobId: z.string(),
    task: z.enum(["chat", "embedding"]),
    model: z.string(),
    input: z.unknown(),
    options: z
      .object({
        maxTokens: z.number().optional(),
        temperature: z.number().optional(),
        // Tools and tool_choice are passed to the backend in OpenAI shape.
        tools: z.array(z.unknown()).optional(),
        toolChoice: z.unknown().optional(),
      })
      .optional(),
  }),
  // Server-initiated cancellation of an in-flight job. Sent when the
  // consumer of a streaming response disconnects (browser closes tab,
  // upstream proxy resets the stream, etc.), so the worker can abort the
  // underlying inference and free its capacity instead of running to
  // completion for a response nobody is listening to.
  z.object({
    type: z.literal("cancel"),
    jobId: z.string(),
  }),
  z.object({ type: z.literal("ping") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// --- Helpers ---

export function parseIncoming<T extends z.ZodType>(
  schema: T,
  raw: string | ArrayBuffer,
): z.infer<T> | null {
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    return schema.parse(JSON.parse(text));
  } catch (err) {
    console.error("invalid message", err);
    return null;
  }
}
