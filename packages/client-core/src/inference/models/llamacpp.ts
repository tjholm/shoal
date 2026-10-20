import type { WorkerModel } from "@shoal/protocol";
import { Effect, Schema } from "effect";
import { getJson, post } from "../backend";
import { ModelsResponse, type RawModelEntry } from "./types";

/**
 * llama.cpp's `llama-server` exposes a sparse `/v1/models` (just the model
 * path as id) plus a richer `GET /props` endpoint. We probe `/props` once
 * per backend to confirm we're talking to a llama-server, and on success
 * treat every model as `purpose: chat`.
 *
 * Single-model-per-process is the typical llama-server deployment. Running
 * it in embedding-only mode is technically possible (`llama-server --embedding`
 * disables generation), but there's no field on `/props` or `/v1/models` that
 * lets us distinguish — so we always tag chat. Users running an embedding-only
 * llama-server should expose a different backend URL to the worker (and
 * accept the slight mis-tag; the server's permit rule still routes by id).
 *
 * Started without `--model`, llama-server runs as a *router*: it spawns one
 * child process per model on demand, and `/v1/models` lists every model it
 * knows with a `status.value` of downloading, loaded, unloaded and so on. A
 * router behaves like Ollama for residency, so it gets its own dialect.
 *
 * Reference: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 *            (router routes: tools/server/server.cpp, server-models.cpp)
 */

const Props = Schema.Struct({
	// "router" when started without a model; absent on single-model servers.
	role: Schema.optionalKey(Schema.String),
	// Present on every llama-server build we care about. Older builds also
	// expose `default_generation_settings` and `total_slots`; any one of the
	// three confirms the dialect.
	chat_template: Schema.optionalKey(Schema.Unknown),
	default_generation_settings: Schema.optionalKey(Schema.Unknown),
	total_slots: Schema.optionalKey(Schema.Unknown),
});

export type LlamaCppRole = "server" | "router";

/** How `backendUrl` answers `/props`: as a single-model llama-server, a
 *  router, or (null) not like llama-server at all. Any failure to fetch or
 *  decode means "not llama-server". */
export const probeLlamaCppServer = (backendUrl: string) =>
	getJson(`${backendUrl}/props`, Props).pipe(
		Effect.map((body): LlamaCppRole | null =>
			body.role === "router"
				? "router"
				: "chat_template" in body ||
						"default_generation_settings" in body ||
						"total_slots" in body
					? "server"
					: null,
		),
		Effect.orElseSucceed(() => null),
	);

export function normalizeLlamaCppModels(
	data: ReadonlyArray<RawModelEntry>,
): WorkerModel[] {
	return data.map((m) => ({ id: m.id, purpose: "chat" }));
}

/** Router entries that can serve a request. Downloads in progress or
 *  abandoned are listed too, but would fail if routed to. */
const SERVABLE = new Set(["downloaded", "unloaded", "loading", "loaded", "sleeping"]);

export function normalizeLlamaCppRouterModels(
	data: ReadonlyArray<RawModelEntry>,
): WorkerModel[] {
	return normalizeLlamaCppModels(
		data.filter((m) => m.status !== undefined && SERVABLE.has(m.status.value)),
	);
}

/** A sleeping child has freed its weights and pays a reload on the next
 *  request, so only `loaded` counts as warm. */
export const fetchLlamaCppRouterLoadedModels = (backendUrl: string) =>
	getJson(`${backendUrl}/v1/models`, ModelsResponse).pipe(
		Effect.map((body) =>
			body.data.filter((m) => m.status?.value === "loaded").map((m) => m.id),
		),
	);

export const unloadLlamaCppRouterModel = (backendUrl: string, model: string) =>
	post(`${backendUrl}/models/unload`, { model });
