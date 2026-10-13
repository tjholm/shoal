import type { WorkerModel } from "@shoal/protocol";
import { Effect, Schema } from "effect";
import { getJson, post } from "../backend";
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

export function isLlamaSwapResponse(
	data: ReadonlyArray<RawModelEntry>,
): boolean {
	return data.some((m) => m.owned_by === "llama-swap");
}

export function normalizeLlamaSwapModels(
	data: ReadonlyArray<RawModelEntry>,
): WorkerModel[] {
	// llama-swap proxies arbitrary upstreams (llama.cpp, vllm, kokoro, ...) so
	// we can't infer purpose from the proxy itself. Leave purpose undefined and
	// rely on the server's permit-unknown contract.
	return data.map((m) => ({ id: m.id }));
}

const RunningResponse = Schema.Struct({
	running: Schema.Array(
		Schema.Struct({ model: Schema.String, state: Schema.String }),
	),
});

/** Currently-resident models, per `GET /running`. Filters to `state: "ready"`
 *  because a process in `starting` is mid-load and not yet serving — routing
 *  to it would queue, which from pickWorker's perspective is still "cold". */
export const fetchLlamaSwapLoadedModels = (backendUrl: string) =>
	getJson(`${backendUrl}/running`, RunningResponse).pipe(
		Effect.map((body) =>
			body.running.filter((p) => p.state === "ready").map((p) => p.model),
		),
	);

/** Stops the upstream serving `model` (an id or alias from `/v1/models`).
 *  Reference: https://github.com/mostlygeek/llama-swap (internal/server/server.go) */
export const unloadLlamaSwapModel = (backendUrl: string, model: string) =>
	post(`${backendUrl}/api/models/unload/${encodeURIComponent(model)}`);
