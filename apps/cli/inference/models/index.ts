import type { WorkerModel } from "@shoal/protocol";
import { isLemonadeResponse, normalizeLemonadeModels } from "./lemonade";
import { probeOllamaCapabilities } from "./ollama";
import type { RawModelEntry } from "./types";

/**
 * Discover the models a backend serves, plus per-model purpose / capabilities
 * where the backend advertises them. The orchestrator fetches `/v1/models`
 * once and then routes the response to the appropriate backend module:
 *
 *   - Lemonade carries metadata inline on `/v1/models` — a single fetch is
 *     enough; see `./lemonade`.
 *   - Ollama only returns ids on `/v1/models`; capabilities come from a
 *     follow-up `POST /api/show` per model; see `./ollama`.
 *
 * Backends we don't recognize (vanilla OpenAI-compatible, etc.) fall through
 * the Ollama probe — which 404s harmlessly and returns the bare id list with
 * `purpose`/`capabilities` undefined, preserving the server's permit-unknown
 * routing contract.
 *
 * Adding a new backend is two steps: write a module that exports a detector
 * and a normalizer (or probe), then add a branch below. Detection lives in
 * the backend module so the orchestrator stays a thin dispatcher.
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

  return probeOllamaCapabilities(
    backendUrl,
    json.data.map((m) => m.id),
  );
}
