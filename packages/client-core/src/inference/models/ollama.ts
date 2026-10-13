import type {
	ModelCapability,
	ModelPurpose,
	WorkerModel,
} from "@shoal/protocol";
import { Effect, Option, Schema } from "effect";
import { getJson, post, postJson } from "../backend";

/**
 * Ollama's `/v1/models` only returns ids, so we follow up with one
 * `POST /api/show` per model to read its capabilities. Non-Ollama
 * OpenAI-compatible backends 404 on /api/show; we treat that as "capabilities
 * unknown" and surface the model anyway, with `purpose`/`capabilities` left
 * undefined so the server's permit-unknown rule applies.
 *
 * Probes fan out with a small concurrency cap — Ollama is local so individual
 * calls are cheap, but 50 sequential round-trips on first boot would still be
 * noticeably slow.
 */

const OLLAMA_PROBE_CONCURRENCY = 4;

const ShowResponse = Schema.Struct({
	capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
});

const PsResponse = Schema.Struct({
	models: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				model: Schema.optionalKey(Schema.String),
				name: Schema.optionalKey(Schema.String),
			}),
		),
	),
});

const CAPABILITY: ReadonlyArray<readonly [string, ModelCapability]> = [
	["tools", "tools"],
	["vision", "vision"],
	["thinking", "thinking"],
];

/** Probe `/api/show` for every id. `answered` is false when no probe
 *  succeeded, i.e. the backend doesn't speak Ollama's API. */
export const probeOllamaCapabilities = Effect.fnUntraced(function* (
	backendUrl: string,
	ids: ReadonlyArray<string>,
) {
	const probes = yield* Effect.forEach(
		ids,
		(id) => fetchOllamaCapabilities(backendUrl, id),
		{ concurrency: OLLAMA_PROBE_CONCURRENCY },
	);
	return {
		models: probes.map((probe, i) =>
			Option.getOrElse(probe, (): WorkerModel => ({ id: ids[i] })),
		),
		answered: probes.some(Option.isSome),
	};
});

/** Currently-resident models, per Ollama's `GET /api/ps`. Each entry carries
 *  both `model` (the id used in /v1 requests) and `name`; we prefer `model`
 *  for the residency set so the strings match what shoal routes against. */
export const fetchOllamaLoadedModels = (backendUrl: string) =>
	getJson(`${backendUrl}/api/ps`, PsResponse).pipe(
		Effect.map((body) =>
			(body.models ?? []).flatMap((m) => {
				const id = m.model ?? m.name;
				return id !== undefined ? [id] : [];
			}),
		),
	);

const fetchOllamaCapabilities = (backendUrl: string, model: string) =>
	postJson(`${backendUrl}/api/show`, { name: model }, ShowResponse).pipe(
		Effect.map((body): WorkerModel => {
			const caps = body.capabilities ?? [];
			// Ollama uses `completion` for chat-style generation and `embedding`
			// for embedding models — these are mutually exclusive in practice.
			// Image/TTS aren't served from Ollama, so we don't try to detect them.
			const purpose: ModelPurpose | undefined = caps.includes("completion")
				? "chat"
				: caps.includes("embedding")
					? "embedding"
					: undefined;
			const capabilities = CAPABILITY.filter(([c]) => caps.includes(c)).map(
				([, capability]) => capability,
			);
			return {
				id: model,
				...(purpose !== undefined ? { purpose } : {}),
				...(capabilities.length > 0 ? { capabilities } : {}),
			};
		}),
		Effect.option,
	);

/** Ollama has no unload endpoint; a request with `keep_alive: 0` and no
 *  prompt evicts the model immediately.
 *  Reference: https://github.com/ollama/ollama/blob/main/docs/api.md#unload-a-model */
export const unloadOllamaModel = (backendUrl: string, model: string) =>
	post(`${backendUrl}/api/generate`, { model, keep_alive: 0 });
