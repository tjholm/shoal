/**
 * Inference modules that proxy to one or more OpenAI-compatible endpoints
 * (e.g. Ollama for chat/embeddings, openedai-speech / kokoro-fastapi for TTS).
 *
 * The worker doesn't run inference itself — each per-task module forwards to
 * whatever is running at the resolved backend URL. The client accepts a list
 * of backends and routes each job to whichever one advertises the requested
 * model via `/v1/models`. When multiple backends advertise the same id, the
 * first-configured wins. Construct a client once via `createInferenceClient`
 * and inject it where inference is needed; this keeps all backend coupling
 * at the construction site, so tests can pass in a fake client without
 * touching module-level state.
 */

import {
  type ChatChunk,
  chatInference,
  type ChatOptions,
  type ToolCallDelta,
  type Usage,
} from "./chat";
import { embeddingInference } from "./embedding";
import { type GeneratedImage, imageInference, type ImageOptions } from "./image";
import { fetchAvailableModels } from "./models";
import { type GeneratedAudio, speechInference, type SpeechOptions } from "./speech";

export type {
  ChatChunk,
  ChatOptions,
  GeneratedAudio,
  GeneratedImage,
  ImageOptions,
  SpeechOptions,
  ToolCallDelta,
  Usage,
};

export interface InferenceClient {
  listModels(): Promise<string[]>;
  chat(
    model: string,
    messages: unknown[],
    options?: ChatOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatChunk>;
  embedding(
    model: string,
    input: string | string[],
    signal?: AbortSignal,
  ): Promise<number[][]>;
  image(
    model: string,
    prompt: string,
    options?: ImageOptions,
    signal?: AbortSignal,
  ): Promise<GeneratedImage[]>;
  speech(
    model: string,
    input: string,
    options?: SpeechOptions,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio>;
}

export function createInferenceClient(config: { backendUrls: string[] }): InferenceClient {
  if (config.backendUrls.length === 0) {
    throw new Error("createInferenceClient requires at least one backend URL");
  }
  const backendUrls = config.backendUrls.map((u) => u.replace(/\/+$/, ""));

  // Per-backend snapshot of advertised model ids, rebuilt on every
  // listModels() call. Kept as `backend -> models` (not `model -> backend`)
  // so we don't lose visibility into which other backends also serve a
  // given model — the resolver walks `backendUrls` in configured order and
  // picks the first match, which gives users a deterministic primary while
  // leaving room to fall through to a secondary backend on failure.
  const modelsByBackend = new Map<string, Set<string>>();

  async function refreshModels(): Promise<string[]> {
    modelsByBackend.clear();
    const ordered: string[] = [];
    const seen = new Set<string>();
    // Sequential, not parallel: first-configured-wins for the returned union
    // requires deterministic iteration, and per-backend failures shouldn't
    // mask each other in an aggregated rejection.
    for (const url of backendUrls) {
      try {
        const ids = await fetchAvailableModels(url);
        modelsByBackend.set(url, new Set(ids));
        for (const id of ids) {
          if (!seen.has(id)) {
            seen.add(id);
            ordered.push(id);
          }
        }
      } catch (err) {
        // Record an empty set so this backend is still "known" — without it
        // a stale resolver entry could keep routing to a backend whose model
        // list we never managed to read.
        modelsByBackend.set(url, new Set());
        console.error(
          `[worker] failed to fetch models from ${url}:`,
          (err as Error).message,
        );
      }
    }
    return ordered;
  }

  function pickBackend(model: string): string | undefined {
    for (const url of backendUrls) {
      if (modelsByBackend.get(url)?.has(model)) return url;
    }
    return undefined;
  }

  async function resolveBackend(model: string): Promise<string> {
    const cached = pickBackend(model);
    if (cached) return cached;
    // Cache miss may just mean the periodic refresh hasn't fired yet, or a
    // backend pulled a new model. Re-query once before giving up.
    await refreshModels();
    const url = pickBackend(model);
    if (!url) {
      const known = new Set<string>();
      for (const set of modelsByBackend.values()) for (const id of set) known.add(id);
      throw new Error(
        `No configured backend serves model "${model}". ` +
          (known.size > 0
            ? `Known models: ${[...known].join(", ")}`
            : "No backends reported any models."),
      );
    }
    return url;
  }

  return {
    listModels: refreshModels,
    chat: async function* (model, messages, options, signal) {
      const url = await resolveBackend(model);
      yield* chatInference(url, model, messages, options, signal);
    },
    embedding: async (model, input, signal) => {
      const url = await resolveBackend(model);
      return embeddingInference(url, model, input, signal);
    },
    image: async (model, prompt, options, signal) => {
      const url = await resolveBackend(model);
      return imageInference(url, model, prompt, options, signal);
    },
    speech: async (model, input, options, signal) => {
      const url = await resolveBackend(model);
      return speechInference(url, model, input, options, signal);
    },
  };
}
