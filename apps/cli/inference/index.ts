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

import type { WorkerModel } from "@shoal/protocol";
import {
	type ChatChunk,
	type ChatOptions,
	chatInference,
	type ToolCallDelta,
	type Usage,
} from "./chat";
import { embeddingInference } from "./embedding";
import {
	type GeneratedImage,
	type ImageOptions,
	imageInference,
} from "./image";
import { fetchAvailableModels, fetchLoadedModels } from "./models";
import {
	type GeneratedAudio,
	type SpeechOptions,
	speechInference,
} from "./speech";

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
	/** Probe all configured backends in one pass. Returns the advertised model
	 *  catalog (deduped, first-configured-wins) and the currently-loaded set
	 *  (union across backends). Also refreshes the internal routing cache used
	 *  by chat/embedding/image/speech. Call this on the worker's stats tick. */
	refresh(): Promise<{ models: WorkerModel[]; loaded: string[] }>;
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

export function createInferenceClient(config: {
	backendUrls: string[];
}): InferenceClient {
	if (config.backendUrls.length === 0) {
		throw new Error("createInferenceClient requires at least one backend URL");
	}
	const backendUrls = config.backendUrls.map((u) => u.replace(/\/+$/, ""));

	// Routing cache only. Keyed by URL, holds the last advertised model set per
	// backend. Updated on every refresh(); read on every chat/embedding/etc.
	// call by resolveBackend(). Not used for residency — residency is computed
	// per-refresh from the live response, so there's no dialect or loaded-set
	// state to keep in sync.
	const modelsByBackend = new Map<string, Map<string, WorkerModel>>();

	async function refresh(): Promise<{
		models: WorkerModel[];
		loaded: string[];
	}> {
		// Probe each backend in parallel — they're independent and the result is
		// rebuilt deterministically below regardless of completion order.
		const results = await Promise.all(
			backendUrls.map(async (url) => {
				try {
					const { models, dialect } = await fetchAvailableModels(url);
					const advertised = models.map((m) => m.id);
					let loaded: string[];
					try {
						loaded = await fetchLoadedModels(url, dialect, advertised);
					} catch (err) {
						console.error(
							`[worker] failed to fetch loaded models from ${url} (${dialect}):`,
							(err as Error).message,
						);
						loaded = [];
					}
					return { url, models, loaded };
				} catch (err) {
					console.error(
						`[worker] failed to fetch models from ${url}:`,
						(err as Error).message,
					);
					return { url, models: [] as WorkerModel[], loaded: [] as string[] };
				}
			}),
		);

		// Refresh routing cache in one synchronous block.
		modelsByBackend.clear();
		for (const { url, models } of results) {
			modelsByBackend.set(url, new Map(models.map((m) => [m.id, m])));
		}

		// Walk results in configured order so first-configured-wins.
		const byUrl = new Map(results.map((r) => [r.url, r]));
		const orderedModels: WorkerModel[] = [];
		const seen = new Set<string>();
		for (const url of backendUrls) {
			const r = byUrl.get(url);
			if (!r) continue;
			for (const m of r.models) {
				if (!seen.has(m.id)) {
					seen.add(m.id);
					orderedModels.push(m);
				}
			}
		}
		const loadedSet = new Set<string>();
		for (const r of results) for (const id of r.loaded) loadedSet.add(id);

		return { models: orderedModels, loaded: [...loadedSet] };
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
		// Cache miss = the periodic refresh hasn't fired yet, or the backend
		// pulled a new model since the last tick. Refresh once before giving up.
		await refresh();
		const url = pickBackend(model);
		if (!url) {
			const known = new Set<string>();
			for (const map of modelsByBackend.values())
				for (const id of map.keys()) known.add(id);
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
		refresh,
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
