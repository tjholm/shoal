import { BunServices } from "@effect/platform-bun";
import { IdentityStore } from "@shoal/client-core/identity";
import { InferenceClient } from "@shoal/client-core/inference";
import { canUnload } from "@shoal/client-core/inference/models";
import { type Settings, workerSocketUrl } from "@shoal/client-core/settings";
import {
	makeWorker,
	type Worker,
	type WorkerSnapshot,
} from "@shoal/client-core/worker";
import { Array as Arr, Cause, Effect, Exit, Fiber, Layer, Option, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { Socket } from "effect/socket";
import type { WorkerState } from "../shared/rpc";

/** The desktop's view of the shared worker: what the window and tray show. */
const toState = (settings: Settings, snapshot: WorkerSnapshot): WorkerState => {
	const { connection } = snapshot;
	return {
		status: {
			Connecting: "connecting",
			Connected: "sharing",
			Reconnecting: "reconnecting",
			Pausing: "pausing",
			Paused: "paused",
		}[connection._tag] as WorkerState["status"],
		detail: connection._tag === "Reconnecting" ? connection.reason : null,
		serverUrl: settings.serverUrl,
		jobsRunning: snapshot.jobsInFlight,
		backends: snapshot.backends.map((b) => ({
			url: b.url,
			reachable: b.dialect !== undefined,
			canUnload: b.dialect !== undefined && canUnload(b.dialect),
			loaded: b.loaded,
			error: b.error ?? null,
		})),
	};
};

/** A worker running from saved settings. Replace it to apply new settings. */
export interface RunningWorker {
	readonly pause: () => Promise<void>;
	readonly resume: () => Promise<void>;
	/** Resolve to an error message when an unload failed. */
	readonly unload: (backendUrl: string, model: string) => Promise<string | null>;
	readonly freeMemory: () => Promise<string | null>;
	readonly stop: () => Promise<void>;
}

const errorMessage = <E extends { message: string }>(
	effect: Effect.Effect<void, E>,
): Promise<string | null> =>
	Effect.runPromise(
		effect.pipe(
			Effect.as(null),
			Effect.catch((e) => Effect.succeed(e.message)),
		),
	);

export const startWorker = (
	settings: Settings,
	onState: (state: WorkerState) => void,
): Promise<RunningWorker> =>
	new Promise((resolveStarted) => {
		let started = false;
		const resolve = (worker: RunningWorker) => {
			started = true;
			resolveStarted(worker);
		};
		const serverUrl = workerSocketUrl(settings.serverUrl);
		const backends = Arr.isReadonlyArrayNonEmpty(settings.backends)
			? settings.backends
			: null;
		// Settings validation guarantees one; fail loudly if that ever changes.
		if (backends === null) throw new Error("worker settings have no model servers");

		const layer = Layer.mergeAll(
			InferenceClient.layer(backends),
			IdentityStore.layer(serverUrl),
			Socket.layerWebSocketConstructorGlobal,
		).pipe(Layer.provide(FetchHttpClient.layer), Layer.provideMerge(BunServices.layer));

		const program = Effect.gen(function* () {
			const worker: Worker = yield* makeWorker({
				serverUrl,
				token: settings.token,
				maxConcurrent: 1,
				name: Option.none(),
			});
			yield* worker.changes.pipe(
				Stream.runForEach((snapshot) => Effect.sync(() => onState(toState(settings, snapshot)))),
				Effect.forkScoped,
			);
			resolve({
				pause: () => Effect.runPromise(worker.pause),
				resume: () => Effect.runPromise(worker.resume),
				unload: (backendUrl, model) => errorMessage(worker.unload(backendUrl, model)),
				freeMemory: () => errorMessage(worker.freeMemory),
				stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
			});
			return yield* worker.join;
		}).pipe(Effect.scoped, Effect.provide(layer));

		const fiber = Effect.runFork(program);
		fiber.addObserver((exit) => {
			if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
			const error = Cause.squash(exit.cause);
			onState({
				status: "stopped",
				detail: error instanceof Error ? error.message : Cause.pretty(exit.cause),
				serverUrl: settings.serverUrl,
				jobsRunning: 0,
				backends: [],
			});
			// Failed before it could hand back controls, e.g. an unreadable identity file.
			if (!started) {
				const stopped = () => Promise.resolve("The worker has stopped.");
				resolve({
					pause: async () => {},
					resume: async () => {},
					unload: stopped,
					freeMemory: stopped,
					stop: async () => {},
				});
			}
		});
	});
