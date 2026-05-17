import type { WorkerModel } from "@shoal/protocol";
import type { RawModelEntry } from "./types";

/**
 * llama-swap is a hot-swapping proxy that sits in front of one or more
 * inference servers (llama.cpp, vllm, etc.). Its `/v1/models` advertises every
 * configured model alias, but only a subset is actually resident at any moment
 * — switching models pays a real cold-start cost on the underlying upstream.
 * So from shoal's residency standpoint llama-swap behaves like Ollama, not
 * like the always-loaded llama-server it fronts.
 *
 * Detection is structural: llama-swap stamps `owned_by: "llama-swap"` on every
 * `/v1/models` entry. Residency comes from `GET /running`, which returns the
 * currently-loaded upstreams.
 *
 * Reference: https://github.com/mostlygeek/llama-swap
 */

interface LlamaSwapEntry extends RawModelEntry {
	owned_by?: string;
}

export function isLlamaSwapResponse(
	data: ReadonlyArray<RawModelEntry>,
): boolean {
	return data.some((m) => (m as LlamaSwapEntry).owned_by === "llama-swap");
}

export function normalizeLlamaSwapModels(
	data: ReadonlyArray<RawModelEntry>,
): WorkerModel[] {
	// llama-swap proxies arbitrary upstreams (llama.cpp, vllm, kokoro, ...) so
	// we can't infer purpose from the proxy itself. Leave purpose undefined and
	// rely on the server's permit-unknown contract.
	return data.map((m) => ({ id: m.id }));
}

interface LlamaSwapRunningEntry {
	model: string;
	state: string;
}

interface LlamaSwapRunningResponse {
	running: LlamaSwapRunningEntry[];
}

/** Currently-resident models, per `GET /running`. Filters to `state: "ready"`
 *  because a process in `starting` is mid-load and not yet serving — routing
 *  to it would queue, which from pickWorker's perspective is still "cold". */
export async function fetchLlamaSwapLoadedModels(
	backendUrl: string,
): Promise<string[]> {
	const res = await fetch(`${backendUrl}/running`);
	if (!res.ok) {
		throw new Error(`llama-swap /running returned ${res.status}`);
	}
	const body = (await res.json()) as LlamaSwapRunningResponse;
	return body.running.filter((p) => p.state === "ready").map((p) => p.model);
}
