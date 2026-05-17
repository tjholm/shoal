import type {
  ModelCapability,
  ModelPurpose,
  WorkerModel,
} from "@shoal/protocol";
import type { RawModelEntry } from "./types";

/**
 * Lemonade exposes per-model metadata directly on `/v1/models`, so detection
 * and normalization both look at the entry shape — no second HTTP call. The
 * fields we care about: `recipe` (primary modality) and `labels` (modifier
 * capabilities).
 */

/** Lemonade's `recipe` field names the backend that serves a model and is the
 *  reliable signal for its primary modality. Labels are unreliable for this —
 *  e.g. a chat model can carry `"transcription"` alongside `"tool-calling"`,
 *  which describes input modalities rather than what endpoint actually runs.
 *  Extend this map when lemonade adds new recipes (the worker logs unknown
 *  recipes on first sighting so we notice). */
const LEMONADE_RECIPE_PURPOSE: Record<string, ModelPurpose> = {
  "sd-cpp": "image",
  kokoro: "tts",
  flm: "chat",
  llamacpp: "chat",
  ryzenai: "chat",
};

/** Recipes we've already warned about, scoped per process. Without this we'd
 *  spam the log every 30s when listModels refreshes. */
const warnedRecipes = new Set<string>();

interface LemonadeEntry extends RawModelEntry {
  recipe?: string;
  labels?: string[];
  max_context_window?: number;
}

/** True when the `/v1/models` response carries Lemonade's enriched fields.
 *  Vanilla OpenAI / Ollama responses do not, so this acts as a dialect probe. */
export function isLemonadeResponse(data: ReadonlyArray<RawModelEntry>): boolean {
  return data.some(
    (m) =>
      Array.isArray((m as LemonadeEntry).labels) ||
      typeof (m as LemonadeEntry).max_context_window === "number",
  );
}

export function normalizeLemonadeModels(
  data: ReadonlyArray<RawModelEntry>,
): WorkerModel[] {
  return data.map((m) => normalizeOne(m as LemonadeEntry));
}

interface LemonadeHealthResponse {
	all_models_loaded?: Array<{ model_name?: string }>;
}

/** Currently-resident models per Lemonade's `/api/v1/health`. Each entry in
 *  `all_models_loaded` carries the canonical `model_name` (matches what
 *  `/v1/models` advertises). Lemonade can have one model loaded per modality
 *  simultaneously, so this can return multiple ids. */
export async function fetchLemonadeLoadedModels(
	backendUrl: string,
): Promise<string[]> {
	const res = await fetch(`${backendUrl}/api/v1/health`);
	if (!res.ok) {
		throw new Error(`Lemonade /api/v1/health returned ${res.status}`);
	}
	const body = (await res.json()) as LemonadeHealthResponse;
	const ids: string[] = [];
	for (const m of body.all_models_loaded ?? []) {
		if (typeof m.model_name === "string") ids.push(m.model_name);
	}
	return ids;
}

function normalizeOne(m: LemonadeEntry): WorkerModel {
  const labels = m.labels ?? [];

  let purpose: ModelPurpose | undefined;
  if (m.recipe !== undefined) {
    purpose = LEMONADE_RECIPE_PURPOSE[m.recipe];
    if (purpose === undefined && !warnedRecipes.has(m.recipe)) {
      warnedRecipes.add(m.recipe);
      console.warn(
        `[worker] lemonade reported model "${m.id}" with unknown recipe "${m.recipe}"; ` +
          `purpose will be reported as unknown. Extend LEMONADE_RECIPE_PURPOSE to map it.`,
      );
    }
  }

  const capabilities: ModelCapability[] = [];
  if (labels.includes("tool-calling")) capabilities.push("tools");
  if (labels.includes("vision")) capabilities.push("vision");
  if (labels.includes("reasoning")) capabilities.push("thinking");

  const out: WorkerModel = { id: m.id };
  if (purpose !== undefined) out.purpose = purpose;
  if (capabilities.length > 0) out.capabilities = capabilities;
  return out;
}
