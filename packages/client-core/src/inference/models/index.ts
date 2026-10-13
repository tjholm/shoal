import type { WorkerModel } from "@shoal/protocol";
import { Context, Effect, Layer, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { getJson } from "../backend";
import type { BackendError } from "../errors";
import {
	fetchLemonadeLoadedModels,
	isLemonadeResponse,
	normalizeLemonadeModels,
	unloadLemonadeModel,
} from "./lemonade";
import { normalizeLlamaCppModels, probeLlamaCppServer } from "./llamacpp";
import {
	fetchLlamaSwapLoadedModels,
	isLlamaSwapResponse,
	normalizeLlamaSwapModels,
	unloadLlamaSwapModel,
} from "./llamaswap";
import {
	fetchLMStudioLoadedModels,
	isLMStudioResponse,
	normalizeLMStudioModels,
	unloadLMStudioModel,
} from "./lmstudio";
import {
	fetchOllamaLoadedModels,
	probeOllamaCapabilities,
	unloadOllamaModel,
} from "./ollama";
import { ModelsResponse } from "./types";
import { isVLLMResponse, normalizeVLLMModels } from "./vllm";

/** Which backend dialect a URL speaks. Captured by `available` and fed back
 *  into `loaded` so we don't redo dialect detection on the residency hot
 *  path. */
export type BackendDialect =
	| "lemonade"
	| "lmstudio"
	| "vllm"
	| "llamaswap"
	| "llamacpp"
	| "ollama";

/** The backend keeps one model loaded for its whole lifetime (vLLM,
 *  single-model llama-server), so there's nothing to unload short of
 *  stopping it. */
export class UnloadUnsupported extends Schema.TaggedError<UnloadUnsupported>()(
	"UnloadUnsupported",
	{ url: Schema.String, dialect: Schema.String },
) {
	get message(): string {
		return `${this.url} (${this.dialect}) can't unload models; stop that server to free its memory.`;
	}
}

/** Whether `unload` can evict models from a backend of this dialect. */
export const canUnload = (dialect: BackendDialect) =>
	dialect !== "vllm" && dialect !== "llamacpp";

export class ModelDiscovery extends Context.Service<
	ModelDiscovery,
	{
		/**
		 * Discover the models a backend serves, plus per-model purpose /
		 * capabilities where the backend advertises them, and the detected
		 * dialect so the caller can dispatch residency probes without re-running
		 * detection.
		 *
		 * Dialect detection runs in this order:
		 *   1. **Lemonade** — `labels` / `max_context_window` on entries.
		 *   2. **LM Studio** — `type` / `arch` / `state` on entries.
		 *   3. **vLLM** — `owned_by === "vllm"`, or `permission` + `max_model_len`.
		 *   4. **llama-swap** — `owned_by === "llama-swap"` on entries. Must run
		 *      before the llama.cpp probe: llama-swap proxies `/props` through to
		 *      its active upstream, so the llama.cpp probe would otherwise
		 *      misidentify it as a plain llama-server and assume "always loaded"
		 *      for every alias.
		 *   5. **llama.cpp llama-server** — probes `GET /props` (one extra call
		 *      per backend, memoized).
		 *   6. **Ollama** — fallback. Probes `POST /api/show` per model, which
		 *      404s cleanly on non-Ollama OpenAI-compat backends and falls back to
		 *      bare ids with capabilities undefined.
		 *
		 * "Undefined purpose" is always a valid outcome — the server's
		 * permit-unknown contract keeps the model routable. The dialect modules
		 * exist to give us *more* information when we can, not to gatekeep.
		 *
		 * Adding a new backend = write a module exposing detection + normalize,
		 * then insert a branch in `available`.
		 */
		available(
			backendUrl: string,
		): Effect.Effect<
			{ models: ReadonlyArray<WorkerModel>; dialect: BackendDialect },
			BackendError
		>;
		/**
		 * Currently-resident models on a backend, so `pickWorker` can route
		 * warm-vs-cold on real residency rather than the last model the worker
		 * happened to drive.
		 *
		 * Stateless backends (vllm, llama-server) keep their single configured
		 * model loaded for the lifetime of the process, so they return
		 * `advertised` as-is. Stateful backends (ollama, lmstudio, llama-swap,
		 * lemonade) call out to a residency endpoint.
		 */
		loaded(
			backendUrl: string,
			dialect: BackendDialect,
			advertised: ReadonlyArray<string>,
		): Effect.Effect<ReadonlyArray<string>, BackendError>;
		/** Evict `model` from a backend's memory. */
		unload(
			backendUrl: string,
			dialect: BackendDialect,
			model: string,
		): Effect.Effect<void, BackendError | UnloadUnsupported>;
	}
>()("@shoal/client-core/inference/models/ModelDiscovery") {
	static readonly layer: Layer.Layer<
		ModelDiscovery,
		never,
		HttpClient.HttpClient
	> = Layer.effect(
		ModelDiscovery,
		Effect.gen(function* () {
			const context = yield* Effect.context<HttpClient.HttpClient>();

			// Per-backend memos. Once we know a backend is/isn't llama-server, or
			// does/doesn't answer Ollama's /api/show, the answer is stable for the
			// lifetime of the process — re-probing every refresh would just waste
			// round-trips.
			const llamaCppDetected = new Map<string, boolean>();
			const ollamaShowUnavailable = new Set<string>();
			// Without this we'd log the same unknown recipe on every refresh.
			const warnedRecipes = new Set<string>();

			const isLlamaCpp = Effect.fnUntraced(function* (backendUrl: string) {
				const cached = llamaCppDetected.get(backendUrl);
				if (cached !== undefined) return cached;
				const detected = yield* probeLlamaCppServer(backendUrl);
				llamaCppDetected.set(backendUrl, detected);
				return detected;
			});

			const probeOllama = Effect.fnUntraced(function* (
				backendUrl: string,
				ids: ReadonlyArray<string>,
			) {
				if (ids.length === 0 || ollamaShowUnavailable.has(backendUrl)) {
					return ids.map((id): WorkerModel => ({ id }));
				}
				const { models, answered } = yield* probeOllamaCapabilities(
					backendUrl,
					ids,
				);
				if (!answered) {
					ollamaShowUnavailable.add(backendUrl);
					yield* Effect.logWarning(
						`backend ${backendUrl} did not respond to /api/show; ` +
							`model capabilities will be reported as unknown and the server will ` +
							`route to it permissively.`,
					);
				}
				return models;
			});

			const available = Effect.fn("ModelDiscovery.available")(function* (
				backendUrl: string,
			) {
				const { data } = yield* getJson(
					`${backendUrl}/v1/models`,
					ModelsResponse,
				);

				if (isLemonadeResponse(data)) {
					const { models, unknownRecipes } = normalizeLemonadeModels(data);
					for (const { model, recipe } of unknownRecipes) {
						if (warnedRecipes.has(recipe)) continue;
						warnedRecipes.add(recipe);
						yield* Effect.logWarning(
							`lemonade reported model "${model}" with unknown recipe "${recipe}"; ` +
								`purpose will be reported as unknown. Extend LEMONADE_RECIPE_PURPOSE to map it.`,
						);
					}
					return { models, dialect: "lemonade" as const };
				}
				if (isLMStudioResponse(data)) {
					return {
						models: normalizeLMStudioModels(data),
						dialect: "lmstudio" as const,
					};
				}
				if (isVLLMResponse(data)) {
					return { models: normalizeVLLMModels(data), dialect: "vllm" as const };
				}
				if (isLlamaSwapResponse(data)) {
					return {
						models: normalizeLlamaSwapModels(data),
						dialect: "llamaswap" as const,
					};
				}
				if (yield* isLlamaCpp(backendUrl)) {
					return {
						models: normalizeLlamaCppModels(data),
						dialect: "llamacpp" as const,
					};
				}
				return {
					models: yield* probeOllama(
						backendUrl,
						data.map((m) => m.id),
					),
					dialect: "ollama" as const,
				};
			}, Effect.provideContext(context));

			const loaded = (
				backendUrl: string,
				dialect: BackendDialect,
				advertised: ReadonlyArray<string>,
			) =>
				fetchLoadedModels(backendUrl, dialect, advertised).pipe(
					Effect.provideContext(context),
				);

			const unload = (
				backendUrl: string,
				dialect: BackendDialect,
				model: string,
			) =>
				unloadModel(backendUrl, dialect, model).pipe(
					Effect.provideContext(context),
				);

			return ModelDiscovery.of({ available, loaded, unload });
		}),
	);
}

const fetchLoadedModels = (
	backendUrl: string,
	dialect: BackendDialect,
	advertised: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, BackendError, HttpClient.HttpClient> => {
	switch (dialect) {
		case "ollama":
			return fetchOllamaLoadedModels(backendUrl);
		case "lmstudio":
			return fetchLMStudioLoadedModels(backendUrl);
		case "llamaswap":
			return fetchLlamaSwapLoadedModels(backendUrl);
		case "lemonade":
			return fetchLemonadeLoadedModels(backendUrl);
		case "vllm":
		case "llamacpp":
			return Effect.succeed(advertised);
	}
};

const unloadModel = (
	backendUrl: string,
	dialect: BackendDialect,
	model: string,
): Effect.Effect<void, BackendError | UnloadUnsupported, HttpClient.HttpClient> => {
	switch (dialect) {
		case "ollama":
			return unloadOllamaModel(backendUrl, model);
		case "lmstudio":
			return unloadLMStudioModel(backendUrl, model);
		case "llamaswap":
			return unloadLlamaSwapModel(backendUrl, model);
		case "lemonade":
			return unloadLemonadeModel(backendUrl, model);
		case "vllm":
		case "llamacpp":
			return new UnloadUnsupported({ url: backendUrl, dialect });
	}
};
