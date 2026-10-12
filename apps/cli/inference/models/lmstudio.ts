import type {
	ModelCapability,
	ModelPurpose,
	WorkerModel,
} from "@shoal/protocol";
import { Effect } from "effect";
import { getJson } from "../backend";
import { ModelsResponse, type RawModelEntry } from "./types";

/**
 * LM Studio's `/v1/models` returns extended fields beyond the OpenAI spec:
 * `type` (llm / vlm / embeddings), `arch`, `state`, `quantization`,
 * `max_context_length`. We rely on `type` for purpose and treat `vlm` as a
 * chat model with the `vision` capability.
 *
 * Reference: https://lmstudio.ai/docs/developer/rest/endpoints
 */

/** True when the response carries LM Studio's enriched fields. We require
 *  *two* of (type, arch, state) so a backend that happens to attach a single
 *  `type` field doesn't get mistaken for LM Studio. */
export function isLMStudioResponse(
	data: ReadonlyArray<RawModelEntry>,
): boolean {
	return data.some(
		(m) => [m.type, m.arch, m.state].filter((f) => f !== undefined).length >= 2,
	);
}

export function normalizeLMStudioModels(
	data: ReadonlyArray<RawModelEntry>,
): WorkerModel[] {
	return data.map(normalizeOne);
}

/** LM Studio reports residency inline on every `/v1/models` entry via `state:
 *  "loaded" | "not-loaded"`. We re-fetch rather than reusing the cached
 *  available-models list so a model unload between ticks shows up promptly. */
export const fetchLMStudioLoadedModels = (backendUrl: string) =>
	getJson(`${backendUrl}/v1/models`, ModelsResponse).pipe(
		Effect.map((body) =>
			body.data.filter((m) => m.state === "loaded").map((m) => m.id),
		),
	);

const TYPE_MODEL: Record<
	string,
	{ purpose: ModelPurpose; capabilities?: ModelCapability[] }
> = {
	llm: { purpose: "chat" },
	vlm: { purpose: "chat", capabilities: ["vision"] },
	embeddings: { purpose: "embedding" },
};

// Other types (or absent type) leave purpose undefined; the server's
// permit-unknown contract keeps the model routable.
function normalizeOne(m: RawModelEntry): WorkerModel {
	const known = m.type !== undefined ? TYPE_MODEL[m.type] : undefined;
	return { id: m.id, ...known };
}
