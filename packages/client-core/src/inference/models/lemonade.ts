import type {
	ModelCapability,
	ModelPurpose,
	WorkerModel,
} from "@shoal/protocol";
import { Effect, Schema } from "effect";
import { getJson, post } from "../backend";
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

const LABEL_CAPABILITY: ReadonlyArray<readonly [string, ModelCapability]> = [
	["tool-calling", "tools"],
	["vision", "vision"],
	["reasoning", "thinking"],
];

/** True when the `/v1/models` response carries Lemonade's enriched fields.
 *  Vanilla OpenAI / Ollama responses do not, so this acts as a dialect probe. */
export function isLemonadeResponse(
	data: ReadonlyArray<RawModelEntry>,
): boolean {
	return data.some(
		(m) => m.labels !== undefined || m.max_context_window !== undefined,
	);
}

/** Normalized models, plus each model whose `recipe` has no known purpose so
 *  the caller can warn about it. */
export function normalizeLemonadeModels(data: ReadonlyArray<RawModelEntry>): {
	models: WorkerModel[];
	unknownRecipes: ReadonlyArray<{ model: string; recipe: string }>;
} {
	const unknownRecipes: Array<{ model: string; recipe: string }> = [];
	const models = data.map((m): WorkerModel => {
		const purpose =
			m.recipe !== undefined ? LEMONADE_RECIPE_PURPOSE[m.recipe] : undefined;
		if (m.recipe !== undefined && purpose === undefined) {
			unknownRecipes.push({ model: m.id, recipe: m.recipe });
		}
		const labels = m.labels ?? [];
		const capabilities = LABEL_CAPABILITY.filter(([label]) =>
			labels.includes(label),
		).map(([, capability]) => capability);
		return {
			id: m.id,
			...(purpose !== undefined ? { purpose } : {}),
			...(capabilities.length > 0 ? { capabilities } : {}),
		};
	});
	return { models, unknownRecipes };
}

const HealthResponse = Schema.Struct({
	all_models_loaded: Schema.optionalKey(
		Schema.Array(Schema.Struct({ model_name: Schema.optionalKey(Schema.String) })),
	),
});

/** Currently-resident models per Lemonade's `/api/v1/health`. Each entry in
 *  `all_models_loaded` carries the canonical `model_name` (matches what
 *  `/v1/models` advertises). Lemonade can have one model loaded per modality
 *  simultaneously, so this can return multiple ids. */
export const fetchLemonadeLoadedModels = (backendUrl: string) =>
	getJson(`${backendUrl}/api/v1/health`, HealthResponse).pipe(
		Effect.map((body) =>
			(body.all_models_loaded ?? []).flatMap((m) =>
				m.model_name !== undefined ? [m.model_name] : [],
			),
		),
	);

/** Unloads one model. The body must always name it: Lemonade treats a missing
 *  or unparseable body as "unload everything".
 *  Reference: https://github.com/lemonade-sdk/lemonade/blob/main/docs/api/lemonade.md */
export const unloadLemonadeModel = (backendUrl: string, model: string) =>
	post(`${backendUrl}/api/v1/unload`, { model_name: model });
