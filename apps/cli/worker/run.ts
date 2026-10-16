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
	FiberMap,
	Option,
	Ref,
	Schedule,
	Schema,
	type Scope,
	Stream,
} from "effect";
import { Socket } from "effect/socket";
import { type IdentityFileError, IdentityStore } from "../identity";
import { InferenceClient } from "../inference";

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

type InferMessage = Extract<ServerMessage, { type: "infer" }>;

const encodeWorkerMessage = Schema.encodeSync(WorkerMessageJson);
const decodeServerMessage = Schema.decodeUnknownEffect(ServerMessageJson);

/** Connect to the Shoal server and serve inference jobs until the server
 *  rejects our credentials. Disconnects are retried with exponential backoff,
 *  reset after every successful connect. */
export const runWorker = Effect.fn("runWorker")(function* (
	options: WorkerOptions,
) {
	const client = yield* InferenceClient;
	const identityStore = yield* IdentityStore;

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

			/** Probe every backend in one pass, then send both messages. One
			 *  pass so the model catalog and the loaded-models report are always
			 *  derived from the same probe. */
			const refreshAndReport = Effect.gen(function* () {
				const { models, loaded } = yield* client.refresh;
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
										: send({ type: "delta", jobId, ...withoutTag(chunk) }),
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
				);

			// Keyed by jobId, so a server-initiated `cancel` can interrupt the
			// backend request and free worker capacity rather than running to
			// completion for a consumer that's already gone.
			const inFlight = yield* FiberMap.make<string>();

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
							// Report immediately so the server sees our model catalog
							// and loaded set without waiting for the first interval.
							yield* refreshAndReport.pipe(
								Effect.repeat(Schedule.spaced(STATS_INTERVAL)),
								Effect.forkScoped,
							);
						});
					case "ping":
						return send({ type: "pong" });
					case "infer":
						return FiberMap.run(inFlight, msg.jobId, handleInfer(msg)).pipe(
							Effect.asVoid,
						);
					case "cancel":
						return Effect.gen(function* () {
							if (!(yield* FiberMap.has(inFlight, msg.jobId))) return;
							yield* Effect.log(`cancel received for job ${msg.jobId}`);
							yield* FiberMap.remove(inFlight, msg.jobId);
						});
				}
			};

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
		}).pipe(Effect.scoped);

	const closeDetail = (err: Socket.SocketError) =>
		err.reason._tag === "SocketCloseError"
			? err.reason.closeReason
				? `${err.reason.code} ${err.reason.closeReason}`
				: `${err.reason.code}`
			: err.message;

	let reconnectDelay = INITIAL_RECONNECT_DELAY;
	while (true) {
		const err = yield* session(
			Effect.sync(() => {
				reconnectDelay = INITIAL_RECONNECT_DELAY;
			}),
		).pipe(Effect.flip);
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
		yield* Effect.sleep(reconnectDelay);
		reconnectDelay = Duration.min(
			Duration.times(reconnectDelay, 2),
			MAX_RECONNECT_DELAY,
		);
	}
});

/** A chunk's fields without its `_tag`: a chat delta's fields are the
 *  protocol `delta` message's. */
const withoutTag = <T extends { readonly _tag: string }>({
	_tag,
	...fields
}: T): Omit<T, "_tag"> => fields;
