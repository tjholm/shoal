/**
 * Inference modules that proxy to one or more OpenAI-compatible endpoints
 * (e.g. Ollama for chat/embeddings, openedai-speech / kokoro-fastapi for TTS).
 *
 * The worker doesn't run inference itself — each per-task module forwards to
 * whatever is running at the resolved backend URL. The client accepts a list
 * of backends and routes each job to whichever one advertises the requested
 * model via `/v1/models`. When multiple backends advertise the same id, the
 * first-configured wins.
 */

import type {
	GeneratedImage,
	ImageOptions,
	InferOptions,
	SpeechOptions,
	WorkerModel,
} from "@shoal/protocol";
import { Array as Arr, Context, Effect, Layer, Ref, Stream } from "effect";
import type { HttpClient } from "effect/http";
import { type ChatChunk, chatInference } from "./chat";
import { embeddingInference } from "./embedding";
import { type BackendError, NoBackendForModel } from "./errors";
import { imageInference } from "./image";
import { ModelDiscovery } from "./models";
import { type GeneratedAudio, speechInference } from "./speech";

export type { ChatChunk, GeneratedAudio };

type InferenceError = BackendError | NoBackendForModel;

export class InferenceClient extends Context.Service<
	InferenceClient,
	{
		/** Probe all configured backends in one pass. Returns the advertised
		 *  model catalog (deduped, first-configured-wins) and the
		 *  currently-loaded set (union across backends). Also refreshes the
		 *  routing cache used by chat/embedding/image/speech. Per-backend
		 *  failures are logged and that backend contributes nothing. */
		readonly refresh: Effect.Effect<{
			models: ReadonlyArray<WorkerModel>;
			loaded: ReadonlyArray<string>;
		}>;
		chat(
			model: string,
			messages: ReadonlyArray<unknown>,
			options: InferOptions | undefined,
		): Stream.Stream<ChatChunk, InferenceError>;
		embedding(
			model: string,
			input: string | ReadonlyArray<string>,
		): Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, InferenceError>;
		image(
			model: string,
			prompt: string,
			options: ImageOptions | undefined,
		): Effect.Effect<ReadonlyArray<GeneratedImage>, InferenceError>;
		speech(
			model: string,
			input: string,
			options: SpeechOptions | undefined,
		): Effect.Effect<GeneratedAudio, InferenceError>;
	}
>()("@shoal/cli/inference/InferenceClient") {
	static readonly layer = (
		configuredUrls: Arr.NonEmptyReadonlyArray<string>,
	): Layer.Layer<InferenceClient, never, HttpClient.HttpClient> =>
		Layer.effect(
			InferenceClient,
			Effect.gen(function* () {
				const discovery = yield* ModelDiscovery;
				const context = yield* Effect.context<HttpClient.HttpClient>();
				const backendUrls = configuredUrls.map((u) => u.replace(/\/+$/, ""));

				// Routing cache only: the last advertised model ids per backend.
				// Residency is computed per-refresh from the live response, so
				// there's no loaded-set state to keep in sync.
				const modelsByBackend = yield* Ref.make(
					new Map<string, ReadonlySet<string>>(),
				);

				const probeBackend = (url: string) =>
					discovery.available(url).pipe(
						Effect.flatMap(({ models, dialect }) =>
							discovery
								.loaded(
									url,
									dialect,
									models.map((m) => m.id),
								)
								.pipe(
									Effect.tapError((err) =>
										Effect.logError(
											`failed to fetch loaded models from ${url} (${dialect}): ${err.message}`,
										),
									),
									Effect.orElseSucceed((): ReadonlyArray<string> => []),
									Effect.map((loaded) => ({ models, loaded })),
								),
						),
						Effect.tapError((err) =>
							Effect.logError(
								`failed to fetch models from ${url}: ${err.message}`,
							),
						),
						Effect.orElseSucceed(() => ({
							models: [] as ReadonlyArray<WorkerModel>,
							loaded: [] as ReadonlyArray<string>,
						})),
					);

				const refresh = Effect.gen(function* () {
					// Results come back in configured order, so first-configured
					// wins when deduping below.
					const results = yield* Effect.forEach(backendUrls, probeBackend, {
						concurrency: "unbounded",
					});
					yield* Ref.set(
						modelsByBackend,
						new Map(
							backendUrls.map((url, i) => [
								url,
								new Set(results[i].models.map((m) => m.id)),
							]),
						),
					);
					return {
						models: Arr.dedupeWith(
							results.flatMap((r) => r.models),
							(a, b) => a.id === b.id,
						),
						loaded: Arr.dedupe(results.flatMap((r) => r.loaded)),
					};
				}).pipe(Effect.withSpan("InferenceClient.refresh"));

				const pickBackend = (model: string) =>
					Ref.get(modelsByBackend).pipe(
						Effect.map((byBackend) =>
							backendUrls.find((url) => byBackend.get(url)?.has(model)),
						),
					);

				const resolveBackend = Effect.fnUntraced(function* (model: string) {
					const cached = yield* pickBackend(model);
					if (cached) return cached;
					// Cache miss = the periodic refresh hasn't fired yet, or the
					// backend pulled a new model since the last tick. Refresh once
					// before giving up.
					yield* refresh;
					const url = yield* pickBackend(model);
					if (url) return url;
					const byBackend = yield* Ref.get(modelsByBackend);
					return yield* new NoBackendForModel({
						model,
						knownModels: Arr.dedupe(
							[...byBackend.values()].flatMap((ids) => [...ids]),
						),
					});
				});

				return InferenceClient.of({
					refresh,
					chat: (model, messages, options) =>
						resolveBackend(model).pipe(
							Effect.map((url) => chatInference(url, model, messages, options)),
							Stream.unwrap,
							Stream.provideContext(context),
						),
					embedding: (model, input) =>
						resolveBackend(model).pipe(
							Effect.flatMap((url) => embeddingInference(url, model, input)),
							Effect.provideContext(context),
						),
					image: (model, prompt, options) =>
						resolveBackend(model).pipe(
							Effect.flatMap((url) =>
								imageInference(url, model, prompt, options),
							),
							Effect.provideContext(context),
						),
					speech: (model, input, options) =>
						resolveBackend(model).pipe(
							Effect.flatMap((url) =>
								speechInference(url, model, input, options),
							),
							Effect.provideContext(context),
						),
				});
			}),
		).pipe(Layer.provide(ModelDiscovery.layer));
}
