import { BunServices } from "@effect/platform-bun";
import { IdentityStore } from "@shoal/client-core/identity";
import { type BackendSnapshot, InferenceClient } from "@shoal/client-core/inference";
import { canUnload } from "@shoal/client-core/inference/models";
import { type Settings, workerSocketUrl } from "@shoal/client-core/settings";
import { makeWorker, type WorkerSnapshot } from "@shoal/client-core/worker";
import { Array as Arr, Cause, Effect, Exit, Fiber, Layer, Option, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { Socket } from "effect/socket";
import type { BackendState } from "../shared/rpc";

export const toBackendState = (b: BackendSnapshot): BackendState => ({
	url: b.url,
	dialect: b.dialect ?? null,
	canUnload: b.dialect !== undefined && canUnload(b.dialect),
	models: b.models,
	loaded: b.loaded,
	error: b.error ?? null,
});

/** One probe of each URL, as the worker would see it. */
export const probeBackends = (urls: Arr.NonEmptyReadonlyArray<string>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const client = yield* InferenceClient;
			const { backends } = yield* client.refresh;
			return backends.map(toBackendState);
		}).pipe(Effect.provide(InferenceClient.layer(urls).pipe(Layer.provide(FetchHttpClient.layer)))),
	);

/** A worker running from saved settings. Replace it to apply new settings. */
export interface RunningWorker {
	/** Pausing disconnects at once, abandoning running jobs. */
	readonly setPaused: (paused: boolean) => Promise<void>;
	/** Resolves to an error message when the unload failed. */
	readonly unload: (backendUrl: string, model: string) => Promise<string | null>;
	readonly stop: () => Promise<void>;
}

export const startWorker = (
	settings: Settings,
	token: string,
	handlers: {
		readonly onSnapshot: (snapshot: WorkerSnapshot) => void;
		/** The worker stopped for good, e.g. the server rejected the token. */
		readonly onStopped: (reason: string) => void;
	},
): Promise<RunningWorker> =>
	new Promise((resolveStarted) => {
		let started = false;
		const resolve = (worker: RunningWorker) => {
			started = true;
			resolveStarted(worker);
		};
		const serverUrl = workerSocketUrl(settings.serverUrl);
		// Settings validation guarantees one; fail loudly if that ever changes.
		if (!Arr.isReadonlyArrayNonEmpty(settings.backends)) {
			throw new Error("worker settings have no model servers");
		}

		const layer = Layer.mergeAll(
			InferenceClient.layer(settings.backends),
			IdentityStore.layer(serverUrl),
			Socket.layerWebSocketConstructorGlobal,
		).pipe(Layer.provide(FetchHttpClient.layer), Layer.provideMerge(BunServices.layer));

		const program = Effect.gen(function* () {
			const worker = yield* makeWorker({
				serverUrl,
				token,
				maxConcurrent: settings.concurrency,
				name: settings.name === "" ? Option.none() : Option.some(settings.name),
				paused: settings.availability !== "on",
			});
			yield* worker.changes.pipe(
				Stream.runForEach((snapshot) => Effect.sync(() => handlers.onSnapshot(snapshot))),
				Effect.forkScoped,
			);
			resolve({
				setPaused: (paused) => Effect.runPromise(paused ? worker.pause : worker.resume),
				unload: (backendUrl, model) =>
					Effect.runPromise(
						worker.unload(backendUrl, model).pipe(
							Effect.as(null),
							Effect.catch((e) => Effect.succeed(e.message)),
						),
					),
				stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
			});
			return yield* worker.join;
		}).pipe(Effect.scoped, Effect.provide(layer));

		const fiber = Effect.runFork(program);
		fiber.addObserver((exit) => {
			if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
			const error = Cause.squash(exit.cause);
			handlers.onStopped(error instanceof Error ? error.message : Cause.pretty(exit.cause));
			// Failed before it could hand back controls, e.g. an unreadable identity file.
			if (!started) {
				resolve({
					setPaused: async () => {},
					unload: () => Promise.resolve("The worker has stopped."),
					stop: async () => {},
				});
			}
		});
	});
