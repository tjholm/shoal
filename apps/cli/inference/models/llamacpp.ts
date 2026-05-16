import type { WorkerModel } from "@shoal/protocol";
import type { RawModelEntry } from "./types";

/**
 * llama.cpp's `llama-server` exposes a sparse `/v1/models` (just the model
 * path as id) plus a richer `GET /props` endpoint. We probe `/props` once
 * per refresh to confirm we're talking to a llama-server, and on success
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

interface LlamaCppProps {
  // Required-ish — present on every llama-server build we care about.
  chat_template?: unknown;
  // Older builds also expose `default_generation_settings` and `total_slots`;
  // we require at least one of these or `chat_template` to confirm the
  // dialect.
  default_generation_settings?: unknown;
  total_slots?: unknown;
}

/** Per-backend memoization. Probing /props on every refresh would mostly be a
 *  waste; once we know a backend is/isn't llama-server, the answer is stable
 *  for the lifetime of the process. */
const detected = new Map<string, boolean>();

export async function isLlamaCppServer(backendUrl: string): Promise<boolean> {
  const cached = detected.get(backendUrl);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(`${backendUrl}/props`);
    if (!res.ok) {
      detected.set(backendUrl, false);
      return false;
    }
    const body = (await res.json()) as LlamaCppProps;
    const ok =
      "chat_template" in body ||
      "default_generation_settings" in body ||
      "total_slots" in body;
    detected.set(backendUrl, ok);
    return ok;
  } catch {
    detected.set(backendUrl, false);
    return false;
  }
}

export function normalizeLlamaCppModels(
  data: ReadonlyArray<RawModelEntry>,
): WorkerModel[] {
  return data.map((m) => ({ id: m.id, purpose: "chat" }));
}
