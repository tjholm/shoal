import type { WorkerModel } from "@shoal/protocol";
import type { RawModelEntry } from "./types";

/**
 * vLLM's `/v1/models` returns each entry with `owned_by: "vllm"`, a
 * `permission` array, and a numeric `max_model_len`. None of these reveal
 * purpose — a vLLM instance can serve either chat or embedding models
 * depending on how it was started (`vllm serve --task generate|embed`), and
 * the wire response is identical in both cases.
 *
 * So this module is essentially a no-op normalizer: it exists to recognize
 * vLLM up front so the orchestrator doesn't fall through to the Ollama probe
 * and emit a spurious "did not respond to /api/show" warning. Purpose stays
 * undefined; the server's permit-unknown contract keeps the model routable.
 *
 * Reference: https://docs.vllm.ai/en/latest/serving/openai_compatible_server/
 */

export function isVLLMResponse(data: ReadonlyArray<RawModelEntry>): boolean {
	return data.some(
		(m) =>
			m.owned_by === "vllm" ||
			// `permission` + `max_model_len` together are vLLM-specific: OpenAI's
			// legacy permission shape is long gone from /v1/models on openai.com,
			// and max_model_len is vLLM's invention.
			(m.permission !== undefined && m.max_model_len !== undefined),
	);
}

export function normalizeVLLMModels(
	data: ReadonlyArray<RawModelEntry>,
): WorkerModel[] {
	return data.map((m) => ({ id: m.id }));
}
