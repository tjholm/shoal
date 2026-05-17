import type { WorkerModel } from "@shoal/protocol";
import {
  fetchLemonadeLoadedModels,
  isLemonadeResponse,
  normalizeLemonadeModels,
} from "./lemonade";
import { isLlamaCppServer, normalizeLlamaCppModels } from "./llamacpp";
import {
	fetchLlamaSwapLoadedModels,
	isLlamaSwapResponse,
	normalizeLlamaSwapModels,
} from "./llamaswap";
import {
	fetchLMStudioLoadedModels,
	isLMStudioResponse,
	normalizeLMStudioModels,
} from "./lmstudio";
import { fetchOllamaLoadedModels, probeOllamaCapabilities } from "./ollama";
import type { RawModelEntry } from "./types";
import { isVLLMResponse, normalizeVLLMModels } from "./vllm";

/** Which backend dialect a URL speaks. Captured by `fetchAvailableModels` and
 *  fed back into `fetchLoadedModels` so we don't redo dialect detection on the
 *  residency hot path. */
export type BackendDialect =
	| "lemonade"
	| "lmstudio"
	| "vllm"
	| "llamaswap"
	| "llamacpp"
	| "ollama";

/**
 * Discover the models a backend serves, plus per-model purpose / capabilities
 * where the backend advertises them. The orchestrator fetches `/v1/models`
 * once and routes the response to the appropriate backend module. Returns the
 * detected dialect alongside the models so the caller can dispatch residency
 * probes without re-running detection.
 *
 * Dialect detection runs in this order:
 *   1. **Lemonade** — `labels` / `max_context_window` on entries.
 *   2. **LM Studio** — `type` / `arch` / `state` on entries.
 *   3. **vLLM** — `owned_by === "vllm"`, or `permission` + `max_model_len`.
 *   4. **llama-swap** — `owned_by === "llama-swap"` on entries. Must run
 *      before the llama.cpp probe: llama-swap proxies `/props` through to its
 *      active upstream, so the llama.cpp probe would otherwise misidentify it
 *      as a plain llama-server and assume "always loaded" for every alias.
 *   5. **llama.cpp llama-server** — probes `GET /props` (async, one extra
 *      call per backend per refresh, memoized).
 *   6. **Ollama** — fallback. Probes `POST /api/show` per model, which 404s
 *      cleanly on non-Ollama OpenAI-compat backends and falls back to bare
 *      ids with capabilities undefined.
 *
 * "Undefined purpose" is always a valid outcome — the server's
 * permit-unknown contract keeps the model routable. The dialect modules
 * exist to give us *more* information when we can, not to gatekeep.
 *
 * Adding a new backend = write a module exposing detection + normalize, then
 * insert a branch below.
 */
export async function fetchAvailableModels(
	backendUrl: string,
): Promise<{ models: WorkerModel[]; dialect: BackendDialect }> {
	const res = await fetch(`${backendUrl}/v1/models`);
	if (!res.ok) {
		throw new Error(`Backend returned ${res.status} from /v1/models`);
	}
	const json = (await res.json()) as { data: Array<RawModelEntry> };

	if (isLemonadeResponse(json.data)) {
		return { models: normalizeLemonadeModels(json.data), dialect: "lemonade" };
	}
	if (isLMStudioResponse(json.data)) {
		return { models: normalizeLMStudioModels(json.data), dialect: "lmstudio" };
	}
	if (isVLLMResponse(json.data)) {
		return { models: normalizeVLLMModels(json.data), dialect: "vllm" };
	}
	if (isLlamaSwapResponse(json.data)) {
		return {
			models: normalizeLlamaSwapModels(json.data),
			dialect: "llamaswap",
		};
	}
	if (await isLlamaCppServer(backendUrl)) {
		return { models: normalizeLlamaCppModels(json.data), dialect: "llamacpp" };
	}

	return {
		models: await probeOllamaCapabilities(
			backendUrl,
			json.data.map((m) => m.id),
		),
		dialect: "ollama",
	};
}

/**
 * Currently-resident models on a backend. Used by the worker to report a
 * truthful "what's actually loaded" set to the server, so `pickWorker` can
 * route warm-vs-cold based on real residency rather than the last model the
 * worker happened to drive.
 *
 * Stateless backends (vllm, llama-server) keep their single configured model
 * loaded for the lifetime of the process, so they return `advertised` as-is.
 * Stateful backends (ollama, lmstudio, llama-swap, lemonade) call out to a
 * residency endpoint.
 */
export async function fetchLoadedModels(
	backendUrl: string,
	dialect: BackendDialect,
	advertised: string[],
): Promise<string[]> {
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
			return advertised;
	}
}
