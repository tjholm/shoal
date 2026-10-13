import type { WorkerModel } from "@shoal/protocol";
import { Effect, Schema } from "effect";
import { getJson } from "../backend";
import type { RawModelEntry } from "./types";

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
 * Reference: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 */

const Props = Schema.Struct({
	// Present on every llama-server build we care about. Older builds also
	// expose `default_generation_settings` and `total_slots`; any one of the
	// three confirms the dialect.
	chat_template: Schema.optionalKey(Schema.Unknown),
	default_generation_settings: Schema.optionalKey(Schema.Unknown),
	total_slots: Schema.optionalKey(Schema.Unknown),
});

/** Whether `backendUrl` answers `/props` like a llama-server. Any failure to
 *  fetch or decode means "not llama-server". */
export const probeLlamaCppServer = (backendUrl: string) =>
	getJson(`${backendUrl}/props`, Props).pipe(
		Effect.map(
			(body) =>
				"chat_template" in body ||
				"default_generation_settings" in body ||
				"total_slots" in body,
		),
		Effect.orElseSucceed(() => false),
	);

export function normalizeLlamaCppModels(
	data: ReadonlyArray<RawModelEntry>,
): WorkerModel[] {
	return data.map((m) => ({ id: m.id, purpose: "chat" }));
}
