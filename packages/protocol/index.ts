import { Schema } from "effect";

/** Inference tasks a worker can route to a backend. Mirrors the `task` field
 *  on the `infer` server-to-worker message. */
export const ModelTask = Schema.Literals(["chat", "embedding", "image", "tts"]);
export type ModelTask = typeof ModelTask.Type;

/** Primary modality of a model. One-to-one with the inference tasks the server
 *  dispatches; a chat request must land on a `purpose: "chat"` model, etc. */
export const ModelPurpose = Schema.Literals(["chat", "embedding", "image", "tts"]);
export type ModelPurpose = typeof ModelPurpose.Type;

/** Feature flags that ride on top of a purpose. Open-by-convention but locked
 *  to a normalized vocabulary at the protocol layer so the server and UI work
 *  against one stable set of strings. Add a value here when a new backend
 *  capability becomes routable or display-worthy. */
export const ModelCapability = Schema.Literals(["tools", "vision", "thinking"]);
export type ModelCapability = typeof ModelCapability.Type;

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
export const WorkerModel = Schema.Struct({
	id: Schema.String,
	// Primary modality. Absent = unknown.
	purpose: Schema.optionalKey(ModelPurpose),
	// Feature flags applicable to the purpose. Absent = unknown;
	// present-but-empty = advertised as supporting no flags.
	capabilities: Schema.optionalKey(Schema.Array(ModelCapability)),
});
export type WorkerModel = typeof WorkerModel.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const FinishReason = Schema.Literals(["stop", "length", "tool_calls"]);
export type FinishReason = typeof FinishReason.Type;

export const Usage = Schema.Struct({
	promptTokens: NonNegativeInt,
	completionTokens: NonNegativeInt,
});
export type Usage = typeof Usage.Type;

export const ToolCallDelta = Schema.Struct({
	index: NonNegativeInt,
	id: Schema.optionalKey(Schema.String),
	name: Schema.optionalKey(Schema.String),
	arguments: Schema.optionalKey(Schema.String),
});
export type ToolCallDelta = typeof ToolCallDelta.Type;

export const GeneratedImage = Schema.Struct({
	b64: Schema.optionalKey(Schema.String),
	url: Schema.optionalKey(Schema.String),
	revisedPrompt: Schema.optionalKey(Schema.String),
});
export type GeneratedImage = typeof GeneratedImage.Type;

// --- Worker → Server messages ---

// Worker identity is assigned by the server at register time and never sent
// from the worker — server uses the authenticated peer binding for all
// subsequent messages, so a worker cannot reference another worker's id.
export const WorkerMessage = Schema.Union([
	// First-time registration: server assigns workerId and returns a per-worker
	// secret that the worker persists for later `register_resume` calls.
	// `name`, if provided, becomes the worker's friendly name; omit to leave
	// the name unset (operator can set it from the dashboard later).
	Schema.Struct({
		type: Schema.tag("register_new"),
		maxConcurrent: PositiveInt,
		name: Schema.optionalKey(Schema.String),
	}),
	// Reconnect with stored credentials. Server validates `secret` against the
	// hashed value on the worker row, scoped to the org from API key auth.
	// `name`, if provided, overwrites the stored name on every resume — i.e.
	// the worker's `--name` flag is authoritative when set, and a UI rename
	// only sticks until the operator restarts the worker with `--name` again.
	// Omit `name` to preserve whatever is in the DB.
	Schema.Struct({
		type: Schema.tag("register_resume"),
		workerId: Schema.String,
		secret: Schema.String,
		maxConcurrent: PositiveInt,
		name: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		type: Schema.tag("stats"),
		// Models the worker's backends report as currently resident, deduplicated
		// across backends. Empty when no model is loaded (e.g. an Ollama box that
		// hasn't served anything yet, or every model has aged out of VRAM). Used
		// by the server's pickWorker for warm-vs-cold routing decisions.
		loadedModels: Schema.Array(Schema.String),
		jobsCompleted: Schema.Number,
		uptimeMs: Schema.Number,
	}),
	Schema.Struct({
		type: Schema.tag("model_ready"),
		jobId: Schema.String,
		model: Schema.String,
	}),
	// Streaming chunk. `content` carries text fragments; `toolCalls` carries
	// function-call fragments where `arguments` is a JSON string slice that must
	// be concatenated by index across successive deltas.
	Schema.Struct({
		type: Schema.tag("delta"),
		jobId: Schema.String,
		content: Schema.optionalKey(Schema.String),
		toolCalls: Schema.optionalKey(Schema.Array(ToolCallDelta)),
	}),
	// Single embedding vector for embedding tasks.
	Schema.Struct({
		type: Schema.tag("embedding"),
		jobId: Schema.String,
		vector: Schema.Array(Schema.Number),
	}),
	// Image generation results. `b64` carries a base64-encoded image body when the
	// caller asked for b64_json; `url` carries a backend-issued URL when the
	// caller asked for url (some backends only support one form). `revisedPrompt`
	// is the prompt the backend actually rendered (DALL·E 3 rewrites prompts).
	Schema.Struct({
		type: Schema.tag("image"),
		jobId: Schema.String,
		images: Schema.Array(GeneratedImage),
	}),
	// TTS results. The backend returns raw audio bytes; the worker base64-encodes
	// them so they fit in the JSON-only protocol. `mimeType` is taken from the
	// backend's Content-Type when present, or derived from the requested format.
	Schema.Struct({
		type: Schema.tag("audio"),
		jobId: Schema.String,
		b64: Schema.String,
		mimeType: Schema.String,
	}),
	Schema.Struct({
		type: Schema.tag("done"),
		jobId: Schema.String,
		finishReason: FinishReason,
		// Token usage, if the backend reported it (Ollama / vLLM / llama.cpp
		// expose this when stream_options.include_usage is set, or always for
		// non-streaming responses). Absent if the backend didn't report usage.
		usage: Schema.optionalKey(Usage),
	}),
	Schema.Struct({
		type: Schema.tag("error"),
		jobId: Schema.String,
		message: Schema.String,
	}),
	Schema.Struct({
		type: Schema.tag("models"),
		// Either the legacy `string[]` (old workers) or the new object form with
		// optional purpose/capabilities (current workers). A given worker build
		// only ever sends one form, so this is a union of two array shapes rather
		// than an array of a union — the wire payload is never mixed.
		// TODO(remove-legacy-models): drop the string variant once all workers
		// have shipped with the object form.
		models: Schema.Union([
			Schema.Array(Schema.String),
			Schema.Array(WorkerModel),
		]),
	}),
	Schema.Struct({ type: Schema.tag("pong") }),
]);
export type WorkerMessage = typeof WorkerMessage.Type;

/** Required model purpose for a given inference task. The server consults this
 *  when picking a worker so a chat job is never dispatched to a TTS-only model. */
export const TASK_PURPOSE: Record<ModelTask, ModelPurpose> = {
	chat: "chat",
	embedding: "embedding",
	image: "image",
	tts: "tts",
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

	const capSets = entries.flatMap((e) =>
		e.capabilities === undefined ? [] : [e.capabilities],
	);
	const capabilities =
		capSets.length > 0
			? capSets[0].filter((c) => capSets.every((caps) => caps.includes(c)))
			: undefined;

	return {
		id,
		...(purpose !== undefined ? { purpose } : {}),
		...(capabilities !== undefined ? { capabilities } : {}),
	};
}

type WireModels = Extract<WorkerMessage, { type: "models" }>["models"];

/**
 * Collapse the legacy `string[]` and new object wire forms into
 * `WorkerModel[]`. Returns the normalized list plus a `legacy` flag so the
 * caller can log a one-time deprecation notice per message.
 * TODO(remove-legacy-models): drop the string branch and the `legacy` flag.
 */
export function normalizeWorkerModels(models: WireModels): {
	models: ReadonlyArray<WorkerModel>;
	legacy: boolean;
} {
	if (models.length === 0) return { models: [], legacy: false };
	if (isStringArray(models)) {
		return { models: models.map((id) => ({ id })), legacy: true };
	}
	return { models, legacy: false };
}

function isStringArray(
	models: WireModels,
): models is ReadonlyArray<string> {
	return typeof models[0] === "string";
}

// --- Server → Worker messages ---

export const ImageOptions = Schema.Struct({
	size: Schema.optionalKey(Schema.String),
	n: Schema.optionalKey(PositiveInt),
	quality: Schema.optionalKey(Schema.String),
	style: Schema.optionalKey(Schema.String),
	responseFormat: Schema.optionalKey(Schema.Literals(["url", "b64_json"])),
});
export type ImageOptions = typeof ImageOptions.Type;

// `responseFormat` is left as a free string because backends accept formats
// beyond the OpenAI set (e.g. mp3/opus/aac/flac/wav/pcm).
export const SpeechOptions = Schema.Struct({
	voice: Schema.optionalKey(Schema.String),
	responseFormat: Schema.optionalKey(Schema.String),
	speed: Schema.optionalKey(Schema.Number),
	instructions: Schema.optionalKey(Schema.String),
});
export type SpeechOptions = typeof SpeechOptions.Type;

export const InferOptions = Schema.Struct({
	maxTokens: Schema.optionalKey(Schema.Number),
	temperature: Schema.optionalKey(Schema.Number),
	// Tools and tool_choice are passed to the backend in OpenAI shape.
	tools: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	toolChoice: Schema.optionalKey(Schema.Unknown),
	// Forwarded to the backend's /v1/images/generations in OpenAI shape.
	// Absent for chat/embedding.
	image: Schema.optionalKey(ImageOptions),
	// Forwarded to /v1/audio/speech in OpenAI shape.
	tts: Schema.optionalKey(SpeechOptions),
});
export type InferOptions = typeof InferOptions.Type;

export const ServerMessage = Schema.Union([
	// `secret` is only present in response to register_new; on resume the worker
	// already has its credentials.
	Schema.Struct({
		type: Schema.tag("registered"),
		workerId: Schema.String,
		secret: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		type: Schema.tag("infer"),
		jobId: Schema.String,
		task: ModelTask,
		model: Schema.String,
		input: Schema.Unknown,
		options: Schema.optionalKey(InferOptions),
	}),
	// Server-initiated cancellation of an in-flight job. Sent when the
	// consumer of a streaming response disconnects (browser closes tab,
	// upstream proxy resets the stream, etc.), so the worker can abort the
	// underlying inference and free its capacity instead of running to
	// completion for a response nobody is listening to.
	Schema.Struct({
		type: Schema.tag("cancel"),
		jobId: Schema.String,
	}),
	Schema.Struct({ type: Schema.tag("ping") }),
]);
export type ServerMessage = typeof ServerMessage.Type;

/** JSON-text codecs for each direction of the worker socket. */
export const WorkerMessageJson = Schema.fromJsonString(WorkerMessage);
export const ServerMessageJson = Schema.fromJsonString(ServerMessage);

/** Decode a worker frame for callers outside Effect. Fails with the schema
 *  issue when the frame is not valid JSON or does not match the protocol. */
export const decodeWorkerMessageResult = Schema.decodeUnknownResult(WorkerMessageJson);
