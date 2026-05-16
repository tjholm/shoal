import type { WorkerModel } from "@shoal/protocol";
import { isLemonadeResponse, normalizeLemonadeModels } from "./lemonade";
import { isLlamaCppServer, normalizeLlamaCppModels } from "./llamacpp";
import { isLMStudioResponse, normalizeLMStudioModels } from "./lmstudio";
import { probeOllamaCapabilities } from "./ollama";
import type { RawModelEntry } from "./types";
import { isVLLMResponse, normalizeVLLMModels } from "./vllm";

/**
 * Discover the models a backend serves, plus per-model purpose / capabilities
 * where the backend advertises them. The orchestrator fetches `/v1/models`
 * once and routes the response to the appropriate backend module.
 *
 * Dialect detection runs in this order:
 *   1. **Lemonade** — `labels` / `max_context_window` on entries.
 *   2. **LM Studio** — `type` / `arch` / `state` on entries.
 *   3. **vLLM** — `owned_by === "vllm"`, or `permission` + `max_model_len`.
 *   4. **llama.cpp llama-server** — probes `GET /props` (async, one extra
 *      call per backend per refresh, memoized).
 *   5. **Ollama** — fallback. Probes `POST /api/show` per model, which 404s
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
export async function fetchAvailableModels(backendUrl: string): Promise<WorkerModel[]> {
  const res = await fetch(`${backendUrl}/v1/models`);
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status} from /v1/models`);
  }
  const json = (await res.json()) as { data: Array<RawModelEntry> };

  if (isLemonadeResponse(json.data)) {
    return normalizeLemonadeModels(json.data);
  }
  if (isLMStudioResponse(json.data)) {
    return normalizeLMStudioModels(json.data);
  }
  if (isVLLMResponse(json.data)) {
    return normalizeVLLMModels(json.data);
  }
  if (await isLlamaCppServer(backendUrl)) {
    return normalizeLlamaCppModels(json.data);
  }

  return probeOllamaCapabilities(
    backendUrl,
    json.data.map((m) => m.id),
  );
}
