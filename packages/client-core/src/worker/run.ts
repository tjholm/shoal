import {
	type ServerMessage,
	ServerMessageJson,
	type WorkerMessage,
	WorkerMessageJson,
} from "@shoal/protocol";
import {
	Clock,
	Duration,
	Effect,
	Fiber,
	FiberMap,
	Option,
	Ref,
	Schedule,
	Schema,
	type Scope,
	Stream,
	SubscriptionRef,
} from "effect";
import { Socket } from "effect/socket";
import { type IdentityFileError, IdentityStore } from "../identity";
import {
	type BackendSnapshot,
	InferenceClient,
	type RefreshResult,
} from "../inference";
import type { BackendError } from "../inference/errors";
import { canUnload, type UnloadUnsupported } from "../inference/models";

const STATS_INTERVAL = Duration.seconds(10);
const INITIAL_RECONNECT_DELAY = Duration.seconds(1);
const MAX_RECONNECT_DELAY = Duration.seconds(30);
// Policy violation: the server rejected our credentials.
const CLOSE_POLICY_VIOLATION = 1008;

export class CredentialsRejected extends Schema.TaggedError<CredentialsRejected>()(
	"CredentialsRejected",
	{ detail: Schema.String, identityPath: Schema.String },
) {
	get message(): string {
		return (
			`credentials rejected by server (${this.detail}). ` +
			`If you've reset the server's database, delete ${this.identityPath} ` +
			`and restart to re-register as a new worker.`
		);
	}
}

export interface WorkerOptions {
	readonly serverUrl: string;
	readonly token: string;
	readonly maxConcurrent: number;
	readonly name: Option.Option<string>;
}

/** The worker's link to the server. A paused worker is disconnected on
 *  purpose; `Pausing` means it is finishing in-flight jobs first. */
export type WorkerConnection =
	| { readonly _tag: "Connecting" }
	| { readonly _tag: "Connected"; readonly workerId: string }
	| { readonly _tag: "Reconnecting"; readonly reason: string }
	| { readonly _tag: "Pausing" }
	| { readonly _tag: "Paused" };

export interface WorkerSnapshot {
	readonly connection: WorkerConnection;
	readonly jobsInFlight: number;
	/** Every configured backend as of the last probe, connected or not. */
	readonly backends: ReadonlyArray<BackendSnapshot>;
}

/** A running worker, for clients that control it while it runs. */
export interface Worker {
	readonly snapshot: Effect.Effect<WorkerSnapshot>;
	/** The current snapshot, then every change. */
	readonly changes: Stream.Stream<WorkerSnapshot>;
	/** Stop taking jobs, finish in-flight ones, then disconnect. */
	readonly pause: Effect.Effect<void>;
	readonly resume: Effect.Effect<void>;
	unload(
		backendUrl: string,
		model: string,
	): Effect.Effect<void, BackendError | UnloadUnsupported>;
	/** Pause, then unload every resident model. Backends that can't unload
	 *  are skipped; the first failure is reported after trying the rest. */
	readonly freeMemory: Effect.Effect<void, BackendError | UnloadUnsupported>;
	/** Fails when the worker stops for good: rejected credentials or an
	 *  unusable identity file. */
	readonly join: Effect.Effect<never, CredentialsRejected | IdentityFileError>;
}

type InferMessage = Extract<ServerMessage, { type: "infer" }>;

const encodeWorkerMessage = Schema.encodeSync(WorkerMessageJson);
const decodeServerMessage = Schema.decodeUnknownEffect(ServerMessageJson);

/** Connect to the Shoal server and serve inference jobs until the server
 *  rejects our credentials. */
export const runWorker = (options: WorkerOptions) =>
	makeWorker(options).pipe(
		Effect.flatMap((worker) => worker.join),
		Effect.scoped,
	);

/** Start a worker in the current scope. Disconnects are retried with
 *  exponential backoff, reset after every successful connect. Backends are
 *  probed every 10s whether or not the worker is connected, so residency
 *  stays current while paused. */
export const makeWorker = Effect.fn("makeWorker")(function* (
	options: WorkerOptions,
) {
	const client = yield* InferenceClient;
	const identityStore = yield* IdentityStore;

	const paused = yield* SubscriptionRef.make(false);
	const snapshot = yield* SubscriptionRef.make<WorkerSnapshot>({
		connection: { _tag: "Connecting" },
		jobsInFlight: 0,
		backends: [],
	});
	const setConnection = (connection: WorkerConnection) =>
		SubscriptionRef.update(snapshot, (s) => ({ ...s, connection }));
	const lastProbe = yield* SubscriptionRef.make<Option.Option<RefreshResult>>(
		Option.none(),
	);
	const probe = client.refresh.pipe(
		Effect.tap((result) =>
			Effect.all([
				SubscriptionRef.set(lastProbe, Option.some(result)),
				SubscriptionRef.update(snapshot, (s) => ({
					...s,
					backends: result.backends,
				})),
			]),
		),
	);
	yield* probe.pipe(
		Effect.repeat(Schedule.spaced(STATS_INTERVAL)),
		Effect.forkScoped,
	);

	const whenPaused = (value: boolean) =>
		SubscriptionRef.changes(paused).pipe(
			Stream.filter((p) => p === value),
			Stream.runHead,
			Effect.asVoid,
		);

	const wsUrl = `${options.serverUrl}${options.serverUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(options.token)}`;
	const nameField = Option.match(options.name, {
		onNone: () => ({}),
		onSome: (name) => ({ name }),
	});

	const startedAt = yield* Clock.currentTimeMillis;
	const jobsCompleted = yield* Ref.make(0);

	// Loaded once and updated in-place when the server returns a fresh secret
	// on initial registration. Persisted to disk only after the server
	// confirms it.
	const stored = yield* identityStore.load;
	yield* Option.match(stored, {
		onNone: () =>
			Effect.log(
				`no stored identity, will register as new at ${identityStore.path}`,
			),
		onSome: ({ workerId }) =>
			Effect.log(`loaded identity ${workerId} from ${identityStore.path}`),
	});
	const identity = yield* Ref.make(stored);

	/** One connection's lifetime. Fails with the socket error that ended it;
	 *  its scope owns the stats loop and every in-flight job, so they stop
	 *  when the connection drops. */
	const session = (onOpen: Effect.Effect<void>) =>
		Effect.gen(function* () {
			yield* Effect.log(`connecting to ${options.serverUrl}`);
			const socket = yield* Socket.makeWebSocket(wsUrl);
			const writer = yield* socket.writer;
			const pull = yield* Socket.readerString(socket);
			const send = (msg: WorkerMessage) =>
				writer.write(encodeWorkerMessage(msg));

			yield* onOpen;
			yield* Effect.log("connected, registering");
			const stored = yield* Ref.get(identity);
			yield* send(
				Option.isSome(stored)
					? {
							type: "register_resume",
							workerId: stored.value.workerId,
							secret: stored.value.secret,
							maxConcurrent: options.maxConcurrent,
							...nameField,
						}
					: {
							type: "register_new",
							maxConcurrent: options.maxConcurrent,
							...nameField,
						},
			);

			/** Send both messages from one probe, so the model catalog and the
			 *  loaded-models report always agree. */
			const report = ({ models, loaded }: RefreshResult) =>
				Effect.gen(function* () {
				yield* send({ type: "models", models });
				yield* send({
					type: "stats",
					// Residency as each backend reports it (Ollama /api/ps, LM Studio
					// per-entry state, llama-swap /running), for the server's
					// warm-vs-cold routing in pickWorker.
					loadedModels: loaded,
					jobsCompleted: yield* Ref.get(jobsCompleted),
					uptimeMs: (yield* Clock.currentTimeMillis) - startedAt,
				});
				});

			const completeJob = (jobId: string, result: WorkerMessage) =>
				Effect.gen(function* () {
					yield* send(result);
					yield* Ref.update(jobsCompleted, (n) => n + 1);
					yield* send({ type: "done", jobId, finishReason: "stop" });
				});

			const runTask = (msg: InferMessage) => {
				const { jobId, model, input, options: taskOptions } = msg;
				switch (msg.task) {
					case "chat":
						return client
							.chat(model, input as ReadonlyArray<unknown>, taskOptions)
							.pipe(
								Stream.runForEach((chunk) =>
									chunk._tag === "Done"
										? Ref.update(jobsCompleted, (n) => n + 1).pipe(
												Effect.andThen(
													send({
														type: "done",
														jobId,
														finishReason: chunk.finishReason,
														...(chunk.usage ? { usage: chunk.usage } : {}),
													}),
												),
											)
										: send({
												type: "delta",
												jobId,
												...(chunk.content !== undefined
													? { content: chunk.content }
													: {}),
												...(chunk.toolCalls !== undefined
													? { toolCalls: chunk.toolCalls }
													: {}),
											}),
								),
							);
					case "embedding":
						return client
							.embedding(model, input as string | ReadonlyArray<string>)
							.pipe(
								Effect.flatMap((vectors) =>
									completeJob(jobId, {
										type: "embedding",
										jobId,
										vector: vectors[0],
									}),
								),
							);
					case "image":
						return client
							.image(model, input as string, taskOptions?.image)
							.pipe(
								Effect.flatMap((images) =>
									completeJob(jobId, { type: "image", jobId, images }),
								),
							);
					case "tts":
						return client
							.speech(model, input as string, taskOptions?.tts)
							.pipe(
								Effect.flatMap((audio) =>
									completeJob(jobId, { type: "audio", jobId, ...audio }),
								),
							);
				}
			};

			const trackJob = (delta: number) =>
				SubscriptionRef.update(snapshot, (s) => ({
					...s,
					jobsInFlight: s.jobsInFlight + delta,
				}));

			const handleInfer = (msg: InferMessage) =>
				send({ type: "model_ready", jobId: msg.jobId, model: msg.model }).pipe(
					Effect.andThen(runTask(msg)),
					Effect.catch((err) =>
						Effect.logError(`inference error for job ${msg.jobId}`, err).pipe(
							Effect.andThen(
								send({ type: "error", jobId: msg.jobId, message: err.message }),
							),
						),
					),
					// The server already knows a canceled job is gone and is no
					// longer listening on its jobId, so there's nothing to report.
					Effect.onInterrupt(() =>
						Effect.log(`job ${msg.jobId} aborted`),
					),
					Effect.ensuring(trackJob(-1)),
					(job) => trackJob(1).pipe(Effect.andThen(job)),
				);

			// Keyed by jobId, so a server-initiated `cancel` can interrupt the
			// backend request and free worker capacity rather than running to
			// completion for a consumer that's already gone.
			const inFlight = yield* FiberMap.make<string, unknown, Socket.SocketError>();
			const draining = yield* Ref.make(false);

			const handleMessage = (
				msg: ServerMessage,
			): Effect.Effect<void, Socket.SocketError | IdentityFileError, Scope.Scope> => {
				switch (msg.type) {
					case "registered":
						return Effect.gen(function* () {
							if (msg.secret !== undefined) {
								// First-time registration — persist credentials so future
								// reconnects can resume the same identity.
								const fresh = { workerId: msg.workerId, secret: msg.secret };
								yield* Ref.set(identity, Option.some(fresh));
								yield* identityStore.save(fresh);
								yield* Effect.log(
									`registered (new) as ${msg.workerId}, identity saved`,
								);
							} else {
								yield* Effect.log(`registered (resumed) as ${msg.workerId}`);
							}
							yield* setConnection({ _tag: "Connected", workerId: msg.workerId });
							yield* SubscriptionRef.changes(lastProbe).pipe(
								Stream.filter(Option.isSome),
								Stream.runForEach((p) => report(p.value)),
								Effect.forkScoped,
							);
							// Probe now so the server sees our catalog and loaded set
							// without waiting for the next interval.
							yield* probe.pipe(Effect.forkScoped);
						});
					case "ping":
						return send({ type: "pong" });
					case "infer":
						return Effect.gen(function* () {
							// The server keeps dispatching until we disconnect.
							if (yield* Ref.get(draining)) {
								return yield* send({
									type: "error",
									jobId: msg.jobId,
									message: "worker is pausing",
								});
							}
							yield* FiberMap.run(inFlight, msg.jobId, handleInfer(msg));
						});
					case "cancel":
						return Effect.gen(function* () {
							if (!(yield* FiberMap.has(inFlight, msg.jobId))) return;
							yield* Effect.log(`cancel received for job ${msg.jobId}`);
							yield* FiberMap.remove(inFlight, msg.jobId);
						});
				}
			};

			const serve = Effect.gen(function* () {
				while (true) {
					const frames = yield* pull;
					for (const frame of frames) {
						yield* decodeServerMessage(frame).pipe(
							Effect.matchEffect({
								onFailure: (err) =>
									Effect.logError(`invalid message from server: ${err.message}`),
								onSuccess: handleMessage,
							}),
						);
					}
				}
			});

			// Keeps serving (cancels, pings) while in-flight jobs finish.
			const drainOnPause = Effect.gen(function* () {
				yield* whenPaused(true);
				yield* Effect.log("pausing: finishing in-flight jobs");
				yield* setConnection({ _tag: "Pausing" });
				yield* Ref.set(draining, true);
				yield* FiberMap.awaitEmpty(inFlight);
			});

			yield* Effect.raceFirst(serve, drainOnPause);
		}).pipe(Effect.scoped);

	const closeDetail = (err: Socket.SocketError) =>
		err.reason._tag === "SocketCloseError"
			? err.reason.closeReason
				? `${err.reason.code} ${err.reason.closeReason}`
				: `${err.reason.code}`
			: err.message;

	const connectLoop = Effect.gen(function* () {
	let reconnectDelay = INITIAL_RECONNECT_DELAY;
	while (true) {
		if (yield* SubscriptionRef.get(paused)) {
			yield* Effect.log("paused");
			yield* setConnection({ _tag: "Paused" });
			yield* whenPaused(false);
			yield* Effect.log("resuming");
			yield* setConnection({ _tag: "Connecting" });
		}
		const err = yield* session(
			Effect.sync(() => {
				reconnectDelay = INITIAL_RECONNECT_DELAY;
			}),
		).pipe(
			Effect.match({ onFailure: (e) => e, onSuccess: () => undefined }),
		);
		// The session ended because the worker paused.
		if (err === undefined) continue;
		if (
			err._tag === "SocketError" &&
			err.reason._tag === "SocketCloseError" &&
			err.reason.code === CLOSE_POLICY_VIOLATION
		) {
			return yield* new CredentialsRejected({
				detail: closeDetail(err),
				identityPath: identityStore.path,
			});
		}
		if (err._tag !== "SocketError") return yield* err;
		yield* Effect.log(
			`disconnected (${closeDetail(err)}), reconnecting in ${Duration.format(reconnectDelay)}`,
		);
		yield* setConnection({ _tag: "Reconnecting", reason: closeDetail(err) });
		// Resuming or pausing shouldn't wait out the backoff.
		yield* Effect.raceFirst(
			Effect.sleep(reconnectDelay),
			whenPaused(!(yield* SubscriptionRef.get(paused))),
		);
		reconnectDelay = Duration.min(
			Duration.times(reconnectDelay, 2),
			MAX_RECONNECT_DELAY,
		);
	}
	});

	const running = yield* connectLoop.pipe(Effect.forkScoped);

	const unload = (backendUrl: string, model: string) =>
		client.unload(backendUrl, model).pipe(Effect.andThen(probe));

	const freeMemory = Effect.gen(function* () {
		yield* SubscriptionRef.set(paused, true);
		const { backends } = yield* probe;
		const results = yield* Effect.forEach(
			backends
				.filter((b) => b.dialect !== undefined && canUnload(b.dialect))
				.flatMap((b) => b.loaded.map((model) => ({ url: b.url, model }))),
			({ url, model }) => client.unload(url, model).pipe(Effect.flip, Effect.option),
			{ concurrency: "unbounded" },
		);
		yield* probe;
		const failure = results.find(Option.isSome);
		if (failure) return yield* failure.value;
	});

	return {
		snapshot: SubscriptionRef.get(snapshot),
		changes: SubscriptionRef.changes(snapshot),
		pause: SubscriptionRef.set(paused, true),
		resume: SubscriptionRef.set(paused, false),
		unload,
		freeMemory,
		join: Fiber.join(running),
	} satisfies Worker;
});
