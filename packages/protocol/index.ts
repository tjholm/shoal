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
		// Models the worker's backends report as currently resident, deduplicated
		// across backends. Empty when no model is loaded (e.g. an Ollama box that
		// hasn't served anything yet, or every model has aged out of VRAM). Used
		// by the server's pickWorker for warm-vs-cold routing decisions.
		loadedModels: z.array(z.string()),
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
	// Image generation results. `b64` carries a base64-encoded image body when the
	// caller asked for b64_json; `url` carries a backend-issued URL when the
	// caller asked for url (some backends only support one form). `revisedPrompt`
	// is the prompt the backend actually rendered (DALL·E 3 rewrites prompts).
	z.object({
		type: z.literal("image"),
		jobId: z.string(),
		images: z.array(
			z.object({
				b64: z.string().optional(),
				url: z.string().optional(),
				revisedPrompt: z.string().optional(),
			}),
		),
	}),
	// TTS results. The backend returns raw audio bytes; the worker base64-encodes
	// them so they fit in the JSON-only protocol. `mimeType` is taken from the
	// backend's Content-Type when present, or derived from the requested format.
	z.object({
		type: z.literal("audio"),
		jobId: z.string(),
		b64: z.string(),
		mimeType: z.string(),
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
		// Either the legacy `string[]` (old workers) or the new object form with
		// optional purpose/capabilities (current workers). A given worker build
		// only ever sends one form, so this is a union of two array shapes rather
		// than an array of a union — the wire payload is never mixed.
		// TODO(remove-legacy-models): drop the string variant once all workers
		// have shipped with the object form.
		models: z.union([
			z.array(z.string()),
			z.array(
				z.object({
					id: z.string(),
					// Primary modality (see WorkerModel docs). Absent = unknown.
					purpose: z.enum(["chat", "embedding", "image", "tts"]).optional(),
					// Feature flags applicable to the purpose (see WorkerModel docs).
					// Absent = unknown; present-but-empty = advertised as supporting
					// no flags.
					capabilities: z
						.array(z.enum(["tools", "vision", "thinking"]))
						.optional(),
				}),
			),
		]),
	}),
	z.object({ type: z.literal("pong") }),
]);
export type WorkerMessage = z.infer<typeof WorkerMessage>;

/** Inference tasks a worker can route to a backend. Mirrors the `task` field
 *  on the `infer` server-to-worker message. */
export type ModelTask = "chat" | "embedding" | "image" | "tts";

/** Primary modality of a model. One-to-one with the inference tasks the server
 *  dispatches; a chat request must land on a `purpose: "chat"` model, etc. */
export type ModelPurpose = "chat" | "embedding" | "image" | "tts";

/** Feature flags that ride on top of a purpose. Open-by-convention but locked
 *  to a normalized vocabulary at the protocol layer so the server and UI work
 *  against one stable set of strings. Add a value here when a new backend
 *  capability becomes routable or display-worthy. */
export type ModelCapability = "tools" | "vision" | "thinking";

/** Required model purpose for a given inference task. The server consults this
 *  when picking a worker so a chat job is never dispatched to a TTS-only model. */
export const TASK_PURPOSE: Record<ModelTask, ModelPurpose> = {
	chat: "chat",
	embedding: "embedding",
	image: "image",
	tts: "tts",
};

/**
 * Canonical, normalized form of a model entry as stored on the server and
 * surfaced through the API/UI. Workers send either a bare string (deprecated)
 * or this object on the wire — `normalizeWorkerModels` collapses both into
 * this shape.
 *
 * `purpose` and `capabilities` use a deliberate three-state convention:
 *   - `undefined` → the worker could not determine the field (backend doesn't
 *                   advertise capability metadata). Server-side enforcement
 *                   MUST treat this as "permit" so unsupported backends stay
 *                   usable.
 *   - present     → use the value verbatim. A populated `purpose` that doesn't
 *                   match the requested task is an explicit mismatch and
 *                   dispatch refuses the worker.
 */
export interface WorkerModel {
	id: string;
	purpose?: ModelPurpose;
	capabilities?: ModelCapability[];
}

type WireModel =
	| string
	| {
			id: string;
			purpose?: ModelPurpose;
			capabilities?: ModelCapability[];
	  };

/**
 * Collapse the per-worker views of the same model id into one display entry.
 * Conservative merge — only surface metadata every advertising worker agrees
 * on:
 *   - `purpose` populated only when all defined values agree (workers that
 *     left it undefined abstain).
 *   - `capabilities` is the intersection across every worker that reported
 *     capabilities; workers with undefined capabilities abstain.
 *
 * The result is "what we can confidently say is true everywhere this model
 * runs", which is the right surface for a server-wide listing.
 */
export function mergeModelViews(
	entries: ReadonlyArray<WorkerModel>,
): WorkerModel {
	const id = entries[0].id;

	const purposes = new Set<ModelPurpose>();
	for (const e of entries) if (e.purpose !== undefined) purposes.add(e.purpose);
	const purpose = purposes.size === 1 ? [...purposes][0] : undefined;

	const capContributors = entries.filter((e) => e.capabilities !== undefined);
	let capabilities: ModelCapability[] | undefined;
	if (capContributors.length > 0) {
		const first = capContributors[0].capabilities as ModelCapability[];
		capabilities = first.filter((c) =>
			capContributors.every((e) =>
				(e.capabilities as ModelCapability[]).includes(c),
			),
		);
	}

	const out: WorkerModel = { id };
	if (purpose !== undefined) out.purpose = purpose;
	if (capabilities !== undefined) out.capabilities = capabilities;
	return out;
}

/**
 * Collapse the legacy `string[]` and new object wire forms into
 * `WorkerModel[]`. Returns the normalized list plus a `legacy` flag so the
 * caller can log a one-time deprecation notice per message.
 * TODO(remove-legacy-models): drop the string branch and the `legacy` flag.
 */
export function normalizeWorkerModels(models: ReadonlyArray<WireModel>): {
	models: WorkerModel[];
	legacy: boolean;
} {
	if (models.length === 0) return { models: [], legacy: false };
	if (typeof models[0] === "string") {
		return {
			models: (models as ReadonlyArray<string>).map((id) => ({ id })),
			legacy: true,
		};
	}
	const objs = models as ReadonlyArray<Exclude<WireModel, string>>;
	return {
		models: objs.map((m) => {
			const out: WorkerModel = { id: m.id };
			if (m.purpose !== undefined) out.purpose = m.purpose;
			if (m.capabilities !== undefined) out.capabilities = m.capabilities;
			return out;
		}),
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
		task: z.enum(["chat", "embedding", "image", "tts"]),
		model: z.string(),
		input: z.unknown(),
		options: z
			.object({
				maxTokens: z.number().optional(),
				temperature: z.number().optional(),
				// Tools and tool_choice are passed to the backend in OpenAI shape.
				tools: z.array(z.unknown()).optional(),
				toolChoice: z.unknown().optional(),
				// Image-generation parameters. Forwarded to the backend's
				// /v1/images/generations in OpenAI shape. Absent for chat/embedding.
				image: z
					.object({
						size: z.string().optional(),
						n: z.number().int().positive().optional(),
						quality: z.string().optional(),
						style: z.string().optional(),
						responseFormat: z.enum(["url", "b64_json"]).optional(),
					})
					.optional(),
				// TTS parameters. Forwarded to /v1/audio/speech in OpenAI shape.
				// `responseFormat` is left as a free string because backends accept
				// formats beyond the OpenAI set (e.g. mp3/opus/aac/flac/wav/pcm).
				tts: z
					.object({
						voice: z.string().optional(),
						responseFormat: z.string().optional(),
						speed: z.number().optional(),
						instructions: z.string().optional(),
					})
					.optional(),
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
