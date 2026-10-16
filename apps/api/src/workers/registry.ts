import { Database, type DatabaseError } from "@shoal/db/database";
import * as schema from "@shoal/db/schema";
import {
	type ModelTask,
	normalizeWorkerModels,
	type ServerMessage,
	TASK_PURPOSE,
	type WorkerMessage,
	type WorkerModel,
} from "@shoal/protocol";
import { and, desc, eq } from "drizzle-orm";
import {
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	PubSub,
	Schema,
	type Scope,
	Stream,
} from "effect";
import { makeSecrets, newId } from "./secrets";

/** The server's end of a worker's socket. */
export interface WorkerConnection {
	send(message: ServerMessage): Effect.Effect<void>;
	close(code: number, reason: string): Effect.Effect<void>;
}

/** A connected worker. Owned by the registry; callers get read-only views. */
export interface LiveWorker {
	readonly workerId: string;
	readonly organizationId: string;
	/** API key the current connection authed with. Snapshotted onto each job. */
	readonly keyId: string | null;
	readonly connection: WorkerConnection;
	/** Models resident across the worker's backends, per its last stats tick. */
	readonly loadedModels: ReadonlyArray<string>;
	readonly availableModels: ReadonlyArray<WorkerModel>;
	readonly inFlight: number;
	readonly maxConcurrent: number;
	readonly jobsCompleted: number;
	/** Epoch milliseconds the current connection started. */
	readonly connectedAt: number;
}

type MutableWorker = { -readonly [K in keyof LiveWorker]: LiveWorker[K] };

/** The outcome of `reserve`: a claimed slot, or why there isn't one. */
export type Reservation =
	| { readonly _tag: "Reserved"; readonly worker: LiveWorker }
	/** Connected workers serve the model for the task, all at capacity. */
	| { readonly _tag: "Busy" }
	/** No connected worker serves the model for the task. */
	| { readonly _tag: "NotServed" };

export type WorkerChange =
	/** Any change to a worker's live state, including connect and disconnect. */
	| { readonly type: "live"; readonly workerId: string }
	| { readonly type: "name"; readonly workerId: string; readonly name: string | null }
	| { readonly type: "deleted"; readonly workerId: string };

export interface WorkerRegistration {
	readonly workerId: string;
	readonly name: string | null;
	readonly keyId: string | null;
	readonly firstSeenAt: Date;
	readonly lastSeenAt: Date;
}

export class WorkerAuthFailed extends Schema.TaggedError<WorkerAuthFailed>()(
	"WorkerAuthFailed",
	{ message: Schema.String },
) {}

export class WorkerAlreadyConnected extends Schema.TaggedError<WorkerAlreadyConnected>()(
	"WorkerAlreadyConnected",
	{ workerId: Schema.String },
) {}

interface RegisterOptions {
	readonly organizationId: string;
	readonly keyId: string | null;
	readonly connection: WorkerConnection;
	readonly maxConcurrent: number;
	/** The worker's `--name`. When given it overwrites the stored name (empty
	 *  clears it); when omitted the stored name is kept, so a dashboard rename
	 *  sticks until the worker reconnects with `--name` again. */
	readonly name: string | undefined;
}

export class WorkerRegistry extends Context.Service<
	WorkerRegistry,
	{
		/** Create a worker row and bind the connection. The plaintext secret is
		 *  returned exactly once; the worker persists it to resume later. */
		registerNew(
			options: RegisterOptions,
		): Effect.Effect<{ workerId: string; secret: string }, DatabaseError>;
		/** Bind a returning worker after checking its secret against the stored
		 *  hash, scoped to the organization its API key belongs to. */
		registerResume(
			options: RegisterOptions & { workerId: string; secret: string },
		): Effect.Effect<
			void,
			WorkerAuthFailed | WorkerAlreadyConnected | DatabaseError
		>;
		disconnect(workerId: string): Effect.Effect<void>;
		recordStats(
			workerId: string,
			stats: Extract<WorkerMessage, { type: "stats" }>,
		): Effect.Effect<void>;
		recordModels(
			workerId: string,
			models: Extract<WorkerMessage, { type: "models" }>["models"],
		): Effect.Effect<void>;
		/** Claim a slot on the best worker for this job: one advertising the model
		 *  for this task with spare capacity, preferring workers that already
		 *  have it loaded, then the least busy. */
		reserve(organizationId: string, model: string, task: ModelTask): Effect.Effect<Reservation>;
		/** Return a slot claimed with `reserve`. */
		release(workerId: string, outcome: "completed" | "abandoned"): Effect.Effect<void>;
		get(workerId: string): Effect.Effect<Option.Option<LiveWorker>>;
		live(organizationId: string): Effect.Effect<ReadonlyArray<LiveWorker>>;
		/** Distinct model ids served by the org's connected workers. */
		availableModels(organizationId: string): Effect.Effect<ReadonlyArray<string>>;
		/** Every worker ever registered in the org, most recently seen first. */
		registrations(
			organizationId: string,
		): Effect.Effect<ReadonlyArray<WorkerRegistration>, DatabaseError>;
		rename(
			workerId: string,
			organizationId: string,
			name: string | null,
		): Effect.Effect<void, DatabaseError>;
		/** Disconnect and delete a worker; its usage rows cascade. False when the
		 *  worker isn't in this org. */
		remove(
			workerId: string,
			organizationId: string,
		): Effect.Effect<boolean, DatabaseError>;
		/** Subscribe to changes to the org's workers. The stream carries every
		 *  change from the moment this effect runs until its scope closes. */
		subscribe(
			organizationId: string,
		): Effect.Effect<Stream.Stream<WorkerChange>, never, Scope.Scope>;
	}
>()("@shoal/api/workers/WorkerRegistry") {
	static readonly layer = Layer.effect(
		WorkerRegistry,
		Effect.gen(function* () {
			const database = yield* Database;
			const crypto = yield* Crypto.Crypto;
			const secrets = makeSecrets(crypto);
			const workers = new Map<string, MutableWorker>();
			const bus = yield* PubSub.unbounded<{
				organizationId: string;
				change: WorkerChange;
			}>();
			// So the deprecation notice fires once per worker, not every tick.
			// TODO(remove-legacy-models): delete with the legacy branch.
			const legacyWarned = new Set<string>();

			const emit = (organizationId: string, change: WorkerChange) =>
				PubSub.publish(bus, { organizationId, change }).pipe(Effect.asVoid);

			const emitLive = (worker: MutableWorker) =>
				emit(worker.organizationId, { type: "live", workerId: worker.workerId });

			const bind = Effect.fnUntraced(function* (
				workerId: string,
				options: RegisterOptions,
			) {
				const now = yield* Clock.currentTimeMillis;
				const worker: MutableWorker = {
					workerId,
					organizationId: options.organizationId,
					keyId: options.keyId,
					connection: options.connection,
					loadedModels: [],
					availableModels: [],
					inFlight: 0,
					maxConcurrent: options.maxConcurrent,
					jobsCompleted: 0,
					connectedAt: now,
				};
				workers.set(workerId, worker);
				yield* emitLive(worker);
			});

			const registerNew = Effect.fn("WorkerRegistry.registerNew")(function* (
				options: RegisterOptions,
			) {
				const workerId = yield* newId(crypto);
				const secret = yield* secrets.generate;
				const secretHash = yield* secrets.hash(secret);
				const now = new Date();
				yield* database.query((db) =>
					db.insert(schema.worker).values({
						id: workerId,
						organizationId: options.organizationId,
						secretHash,
						keyId: options.keyId,
						name: normalizeName(options.name),
						firstSeenAt: now,
						lastSeenAt: now,
					}),
				);
				yield* bind(workerId, options);
				return { workerId, secret };
			});

			const registerResume = Effect.fn("WorkerRegistry.registerResume")(
				function* (options: RegisterOptions & { workerId: string; secret: string }) {
					const [row] = yield* database.query((db) =>
						db
							.select({ secretHash: schema.worker.secretHash })
							.from(schema.worker)
							.where(
								and(
									eq(schema.worker.id, options.workerId),
									eq(schema.worker.organizationId, options.organizationId),
								),
							)
							.limit(1),
					);
					if (!row) {
						return yield* new WorkerAuthFailed({
							message: "unknown worker id for this organization",
						});
					}
					if (!(yield* secrets.verify(options.secret, row.secretHash))) {
						return yield* new WorkerAuthFailed({ message: "invalid worker secret" });
					}
					if (workers.has(options.workerId)) {
						return yield* new WorkerAlreadyConnected({ workerId: options.workerId });
					}
					yield* database.query((db) =>
						db
							.update(schema.worker)
							.set({
								lastSeenAt: new Date(),
								keyId: options.keyId,
								...(options.name !== undefined
									? { name: normalizeName(options.name) }
									: {}),
							})
							.where(eq(schema.worker.id, options.workerId)),
					);
					yield* bind(options.workerId, options);
					if (options.name !== undefined) {
						yield* emit(options.organizationId, {
							type: "name",
							workerId: options.workerId,
							name: normalizeName(options.name),
						});
					}
				},
			);

			const disconnect = (workerId: string) =>
				Effect.suspend(() => {
					const worker = workers.get(workerId);
					if (!worker) return Effect.void;
					workers.delete(workerId);
					return emitLive(worker);
				});

			const recordStats = (
				workerId: string,
				stats: Extract<WorkerMessage, { type: "stats" }>,
			) =>
				Effect.suspend(() => {
					const worker = workers.get(workerId);
					if (!worker) return Effect.void;
					const changed =
						!sameMembers(worker.loadedModels, stats.loadedModels) ||
						worker.jobsCompleted !== stats.jobsCompleted;
					worker.loadedModels = stats.loadedModels;
					worker.jobsCompleted = stats.jobsCompleted;
					return changed ? emitLive(worker) : Effect.void;
				});

			const recordModels = (
				workerId: string,
				wireModels: Extract<WorkerMessage, { type: "models" }>["models"],
			) =>
				Effect.gen(function* () {
					const worker = workers.get(workerId);
					if (!worker) return;
					const { models, legacy } = normalizeWorkerModels(wireModels);
					if (legacy && !legacyWarned.has(workerId)) {
						legacyWarned.add(workerId);
						yield* Effect.logWarning(
							`worker ${workerId} sent legacy string[] models payload; upgrade the worker to send { id }[]`,
						);
					}
					const changed =
						worker.availableModels.length !== models.length ||
						worker.availableModels.some((m, i) => m.id !== models[i].id);
					worker.availableModels = models;
					if (changed) yield* emitLive(worker);
				});

			const reserve = (organizationId: string, model: string, task: ModelTask) =>
				Effect.suspend(() => {
					let warm: MutableWorker | undefined;
					let cold: MutableWorker | undefined;
					let served = false;
					for (const w of workers.values()) {
						if (w.organizationId !== organizationId) continue;
						if (!servesTask(w, model, task)) continue;
						served = true;
						if (w.inFlight >= w.maxConcurrent) continue;
						if (w.loadedModels.includes(model)) {
							if (!warm || w.inFlight < warm.inFlight) warm = w;
						} else if (!cold || w.inFlight < cold.inFlight) {
							cold = w;
						}
					}
					const picked = warm ?? cold;
					if (!picked) {
						return Effect.succeed<Reservation>({ _tag: served ? "Busy" : "NotServed" });
					}
					picked.inFlight++;
					return emitLive(picked).pipe(
						Effect.as<Reservation>({ _tag: "Reserved", worker: picked }),
					);
				});

			const release = (workerId: string, outcome: "completed" | "abandoned") =>
				Effect.suspend(() => {
					const worker = workers.get(workerId);
					if (!worker) return Effect.void;
					if (worker.inFlight > 0) worker.inFlight--;
					if (outcome === "completed") worker.jobsCompleted++;
					return emitLive(worker);
				});

			const live = (organizationId: string) =>
				Effect.sync(() =>
					[...workers.values()].filter((w) => w.organizationId === organizationId),
				);

			const availableModels = (organizationId: string) =>
				Effect.sync(() => {
					const ids = new Set<string>();
					for (const w of workers.values()) {
						if (w.organizationId !== organizationId) continue;
						for (const m of w.availableModels) ids.add(m.id);
					}
					return [...ids];
				});

			const registrations = (organizationId: string) =>
				database.query((db) =>
					db
						.select({
							workerId: schema.worker.id,
							name: schema.worker.name,
							keyId: schema.worker.keyId,
							firstSeenAt: schema.worker.firstSeenAt,
							lastSeenAt: schema.worker.lastSeenAt,
						})
						.from(schema.worker)
						.where(eq(schema.worker.organizationId, organizationId))
						.orderBy(desc(schema.worker.lastSeenAt)),
				);

			const rename = Effect.fn("WorkerRegistry.rename")(function* (
				workerId: string,
				organizationId: string,
				name: string | null,
			) {
				yield* database.query((db) =>
					db
						.update(schema.worker)
						.set({ name })
						.where(
							and(
								eq(schema.worker.id, workerId),
								eq(schema.worker.organizationId, organizationId),
							),
						),
				);
				yield* emit(organizationId, { type: "name", workerId, name });
			});

			const remove = Effect.fn("WorkerRegistry.remove")(function* (
				workerId: string,
				organizationId: string,
			) {
				const worker = workers.get(workerId);
				if (worker && worker.organizationId === organizationId) {
					workers.delete(workerId);
					yield* worker.connection.close(1000, "worker deleted");
				}
				const deleted = yield* database.query((db) =>
					db
						.delete(schema.worker)
						.where(
							and(
								eq(schema.worker.id, workerId),
								eq(schema.worker.organizationId, organizationId),
							),
						)
						.returning({ id: schema.worker.id }),
				);
				if (deleted.length === 0) return false;
				yield* emit(organizationId, { type: "deleted", workerId });
				return true;
			});

			const subscribe = (organizationId: string) =>
				PubSub.subscribe(bus).pipe(
					Effect.map((subscription) =>
						Stream.fromSubscription(subscription).pipe(
							Stream.filter((e) => e.organizationId === organizationId),
							Stream.map((e) => e.change),
						),
					),
				);

			return WorkerRegistry.of({
				registerNew,
				registerResume,
				disconnect,
				recordStats,
				recordModels,
				reserve,
				release,
				get: (workerId) =>
					Effect.sync(() => {
						const worker: LiveWorker | undefined = workers.get(workerId);
						return Option.fromNullishOr(worker);
					}),
				live,
				availableModels,
				registrations,
				rename,
				remove,
				subscribe,
			});
		}),
	);
}

/** Trim, and store an empty name as "no name set". */
function normalizeName(name: string | undefined): string | null {
	const trimmed = name?.trim();
	return trimmed ? trimmed : null;
}

/** A worker serves a task when it advertises the model and the model's
 *  declared purpose matches the task or is unknown. An explicit mismatch
 *  excludes it — that's the enforcement contract. */
function servesTask(worker: LiveWorker, model: string, task: ModelTask): boolean {
	const entry = worker.availableModels.find((m) => m.id === model);
	if (!entry) return false;
	return entry.purpose === undefined || entry.purpose === TASK_PURPOSE[task];
}

/** Order-insensitive set equality, so a backend reporting `[a, b]` then
 *  `[b, a]` isn't a change. */
function sameMembers(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
	if (a.length !== b.length) return false;
	const members = new Set(a);
	return b.every((v) => members.has(v));
}
