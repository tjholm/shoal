import type { DatabaseError } from "@shoal/db/database";
import type {
	FinishReason,
	GeneratedImage,
	ImageOptions,
	ModelTask,
	SpeechOptions,
	Usage as TokenUsage,
	WorkerMessage,
} from "@shoal/protocol";
import {
	type Cause,
	Clock,
	Context,
	Crypto,
	Duration,
	Effect,
	Layer,
	Option,
	PubSub,
	Queue,
	Schedule,
	Schema,
	type Scope,
	Stream,
} from "effect";
import { Usage } from "./usage";
import { WorkerRegistry } from "./workers/registry";
import { newId } from "./workers/secrets";

/** What a worker reports for a job, in order: result fragments, then `done`. */
export type JobEvent = Extract<
	WorkerMessage,
	{ type: "delta" | "embedding" | "image" | "audio" | "done" }
>;

export interface JobRequest {
	readonly organizationId: string;
	readonly task: ModelTask;
	readonly model: string;
	readonly input: unknown;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly tools?: ReadonlyArray<unknown>;
	readonly toolChoice?: unknown;
	readonly image?: ImageOptions;
	readonly tts?: SpeechOptions;
}

export interface ToolCall {
	readonly index: number;
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

/** A finished job, reassembled from its events. */
export interface JobResult {
	readonly content: string;
	readonly toolCalls: ReadonlyArray<ToolCall>;
	readonly finishReason: FinishReason;
	readonly embedding?: ReadonlyArray<number>;
	readonly images?: ReadonlyArray<GeneratedImage>;
	readonly audio?: { readonly b64: string; readonly mimeType: string };
	readonly usage?: TokenUsage;
}

/** No worker, connected or not, advertises the model for this task. */
export class ModelNotServed extends Schema.TaggedError<ModelNotServed>()(
	"ModelNotServed",
	{ model: Schema.String, task: Schema.String },
) {
	get message(): string {
		return `No worker serves model "${this.model}" for task "${this.task}"`;
	}
}

/** Workers that serve the model for this task exist, but none is connected
 *  and advertising it right now. */
export class ModelOffline extends Schema.TaggedError<ModelOffline>()("ModelOffline", {
	model: Schema.String,
	task: Schema.String,
}) {
	get message(): string {
		return `No worker serving model "${this.model}" for task "${this.task}" is online`;
	}
}

/** Connected workers serve the model for this task, but every one is at its
 *  concurrency limit. */
export class WorkersBusy extends Schema.TaggedError<WorkersBusy>()("WorkersBusy", {
	model: Schema.String,
	task: Schema.String,
}) {
	get message(): string {
		return `Every worker serving model "${this.model}" for task "${this.task}" is busy`;
	}
}

/** Why a job couldn't be given to a worker. */
export type NoWorkerAvailable = ModelNotServed | ModelOffline | WorkersBusy;

export class JobFailed extends Schema.TaggedError<JobFailed>()("JobFailed", {
	message: Schema.String,
}) {}

interface Job {
	readonly workerId: string;
	readonly organizationId: string;
	/** The worker's key at dispatch, so a key rotated mid-job doesn't move
	 *  the job's usage onto the new key. */
	readonly keyId: string | null;
	readonly task: ModelTask;
	readonly model: string;
	readonly startedAt: number;
	readonly events: Queue.Queue<JobEvent, JobFailed | Cause.Done>;
	/** Deltas received so far, reasoning included: a live estimate of output
	 *  tokens. */
	outputChunks: number;
	/** Whether the latest delta was reasoning rather than answer. */
	thinking: boolean;
}

/** A snapshot of a job that's running, or finished with its usage still
 *  being written. */
export interface RunningJob {
	readonly jobId: string;
	readonly workerId: string;
	readonly model: string;
	readonly startedAt: number;
	readonly outputChunks: number;
	readonly thinking: boolean;
	/** The job's exact output tokens once it has finished; null while running. */
	readonly completionTokens: number | null;
}

/** A change to an org's running jobs. A job is `deleted` once it has failed,
 *  been cancelled, or finished with its usage recorded. */
export type JobChange =
	| { readonly type: "upsert"; readonly job: RunningJob }
	| { readonly type: "deleted"; readonly jobId: string };

/** How often a streaming job's output count is published. Deltas arrive per
 *  token, far faster than a dashboard needs to redraw. */
const PROGRESS_INTERVAL = Duration.millis(250);

/** Routes inference jobs to workers and relays their results back. */
export class Dispatcher extends Context.Service<
	Dispatcher,
	{
		/** Send a job to the best available worker. Running `events` to
		 *  completion follows the job; stopping early cancels it on the worker
		 *  and frees its slot. */
		dispatch(
			request: JobRequest,
		): Effect.Effect<
			{ jobId: string; events: Stream.Stream<JobEvent, JobFailed> },
			NoWorkerAvailable | DatabaseError
		>;
		/** Dispatch a job and wait for its whole result. */
		collect(request: JobRequest): Effect.Effect<
			{ jobId: string; result: JobResult },
			NoWorkerAvailable | DatabaseError | JobFailed
		>;
		/** Apply a job message from the worker connected as `workerId`. Messages
		 *  about jobs dispatched to another worker are ignored. */
		receive(workerId: string, message: JobEvent | WorkerMessage): Effect.Effect<void>;
		/** Fail every job running on a worker that has gone away. */
		abandonWorker(workerId: string): Effect.Effect<void>;
		/** The org's jobs that are running now, oldest first. */
		running(organizationId: string): Effect.Effect<ReadonlyArray<RunningJob>>;
		/** Subscribe to changes to the org's running jobs. The stream carries
		 *  every change from the moment this effect runs until its scope closes. */
		subscribe(
			organizationId: string,
		): Effect.Effect<Stream.Stream<JobChange>, never, Scope.Scope>;
	}
>()("@shoal/api/Dispatcher") {
	static readonly layer = Layer.effect(
		Dispatcher,
		Effect.gen(function* () {
			const registry = yield* WorkerRegistry;
			const usage = yield* Usage;
			const scope = yield* Effect.scope;
			const crypto = yield* Crypto.Crypto;
			const jobs = new Map<string, Job>();
			// Finished jobs whose usage is being written. They stay visible to
			// `running` until it lands, so a client that sees a job go can rely
			// on the usage totals including it.
			const recording = new Map<string, { organizationId: string; job: RunningJob }>();
			const bus = yield* PubSub.unbounded<{ organizationId: string; change: JobChange }>();
			// Jobs that have streamed output since their count was last published.
			const progressed = new Set<string>();

			const emit = (organizationId: string, change: JobChange) =>
				PubSub.publish(bus, { organizationId, change }).pipe(Effect.asVoid);

			/** Forget a job that won't finish, and tell subscribers it's gone. */
			const drop = (jobId: string, job: Job) => {
				jobs.delete(jobId);
				progressed.delete(jobId);
				return emit(job.organizationId, { type: "deleted", jobId });
			};

			yield* Effect.suspend(() => {
				const due = [...progressed];
				progressed.clear();
				return Effect.forEach(
					due,
					(jobId) => {
						const job = jobs.get(jobId);
						return job
							? emit(job.organizationId, { type: "upsert", job: runningJob(jobId, job) })
							: Effect.void;
					},
					{ discard: true },
				);
			}).pipe(Effect.repeat(Schedule.spaced(PROGRESS_INTERVAL)), Effect.forkIn(scope));

			const cancel = (jobId: string) =>
				Effect.gen(function* () {
					const job = jobs.get(jobId);
					if (!job) return;
					yield* drop(jobId, job);
					const worker = yield* registry.get(job.workerId);
					if (Option.isSome(worker)) {
						// Without this the worker would run the job to completion for a
						// consumer that's gone, holding capacity the next dispatch needs.
						yield* worker.value.connection.send({ type: "cancel", jobId });
					}
					yield* registry.release(job.workerId, "abandoned");
				});

			const dispatch = Effect.fn("Dispatcher.dispatch")(function* (
				request: JobRequest,
			) {
				const reservation = yield* registry.reserve(
					request.organizationId,
					request.model,
					request.task,
				);
				const unavailable = { model: request.model, task: request.task };
				switch (reservation._tag) {
					case "NotServed": {
						const offline = yield* registry.hasServed(
							request.organizationId,
							request.model,
							request.task,
						);
						return yield* offline
							? new ModelOffline(unavailable)
							: new ModelNotServed(unavailable);
					}
					case "Busy":
						return yield* new WorkersBusy(unavailable);
				}
				const worker = reservation.worker;
				const jobId = yield* newId(crypto);
				const events = yield* Queue.unbounded<JobEvent, JobFailed | Cause.Done>();
				const job: Job = {
					workerId: worker.workerId,
					organizationId: request.organizationId,
					keyId: worker.keyId,
					task: request.task,
					model: request.model,
					startedAt: yield* Clock.currentTimeMillis,
					events,
					outputChunks: 0,
					thinking: false,
				};
				jobs.set(jobId, job);
				yield* emit(job.organizationId, { type: "upsert", job: runningJob(jobId, job) });
				yield* worker.connection.send({
					type: "infer",
					jobId,
					task: request.task,
					model: request.model,
					input: request.input,
					options: {
						...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
						...(request.temperature !== undefined
							? { temperature: request.temperature }
							: {}),
						...(request.tools !== undefined ? { tools: request.tools } : {}),
						...(request.toolChoice !== undefined
							? { toolChoice: request.toolChoice }
							: {}),
						...(request.image !== undefined ? { image: request.image } : {}),
						...(request.tts !== undefined ? { tts: request.tts } : {}),
					},
				});
				return {
					jobId,
					events: Stream.fromQueue(events).pipe(Stream.ensuring(cancel(jobId))),
				};
			});

			const collect = Effect.fn("Dispatcher.collect")(function* (
				request: JobRequest,
			) {
				const { jobId, events } = yield* dispatch(request);
				return { jobId, result: yield* resultOf(events) };
			});

			const recordUsage = (
				jobId: string,
				job: Job,
				tokens: TokenUsage,
				finishReason: FinishReason,
			) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					yield* usage
						.record({
							organizationId: job.organizationId,
							workerId: job.workerId,
							keyId: job.keyId,
							model: job.model,
							task: job.task,
							promptTokens: tokens.promptTokens,
							completionTokens: tokens.completionTokens,
							finishReason,
							durationMs: now - job.startedAt,
						})
						.pipe(
							// The response has already gone out, so a failed write must
							// not fail it — but it must be visible.
							Effect.catch((err) =>
								Effect.logError("failed to write usage_event", err),
							),
							Effect.ensuring(
								Effect.suspend(() => {
									recording.delete(jobId);
									return emit(job.organizationId, { type: "deleted", jobId });
								}),
							),
							Effect.forkIn(scope),
						);
				});

			/** Move a finished job from `jobs` to `recording` in one synchronous
			 *  step, so `running` never misses it, then record its usage. */
			const finish = (jobId: string, job: Job, done: Extract<JobEvent, { type: "done" }>) => {
				jobs.delete(jobId);
				progressed.delete(jobId);
				// Only chat backends report usage, and a zero row would skew
				// rollups, so record nothing without it.
				const tokens = job.task === "chat" ? done.usage : undefined;
				if (!tokens) return emit(job.organizationId, { type: "deleted", jobId });
				const finished = runningJob(jobId, job, tokens.completionTokens);
				recording.set(jobId, { organizationId: job.organizationId, job: finished });
				return emit(job.organizationId, { type: "upsert", job: finished }).pipe(
					Effect.andThen(recordUsage(jobId, job, tokens, done.finishReason)),
				);
			};

			const receive = (workerId: string, message: JobEvent | WorkerMessage) =>
				Effect.gen(function* () {
					if (!("jobId" in message)) return;
					const job = jobs.get(message.jobId);
					if (!job || job.workerId !== workerId) return;
					switch (message.type) {
						case "delta":
							job.outputChunks++;
							job.thinking = isReasoningOnly(message);
							progressed.add(message.jobId);
							yield* Queue.offer(job.events, message);
							return;
						case "embedding":
						case "image":
						case "audio":
							yield* Queue.offer(job.events, message);
							return;
						case "done":
							yield* finish(message.jobId, job, message);
							yield* Queue.offer(job.events, message);
							yield* Queue.end(job.events);
							yield* registry.release(workerId, "completed");
							return;
						case "error":
							yield* drop(message.jobId, job);
							yield* Queue.fail(job.events, new JobFailed({ message: message.message }));
							yield* registry.release(workerId, "abandoned");
							return;
					}
				});

			const abandonWorker = (workerId: string) =>
				Effect.forEach(
					[...jobs].filter(([, job]) => job.workerId === workerId),
					([jobId, job]) =>
						drop(jobId, job).pipe(
							Effect.andThen(
								Queue.fail(job.events, new JobFailed({ message: "Worker disconnected" })),
							),
						),
					{ discard: true },
				);

			const running = (organizationId: string) =>
				Effect.sync((): ReadonlyArray<RunningJob> => [
					...[...jobs]
						.filter(([, job]) => job.organizationId === organizationId)
						.map(([jobId, job]) => runningJob(jobId, job)),
					...[...recording.values()]
						.filter((entry) => entry.organizationId === organizationId)
						.map((entry) => entry.job),
				]);

			const subscribe = (organizationId: string) =>
				PubSub.subscribe(bus).pipe(
					Effect.map((subscription) =>
						Stream.fromSubscription(subscription).pipe(
							Stream.filter((e) => e.organizationId === organizationId),
							Stream.map((e) => e.change),
						),
					),
				);

			return Dispatcher.of({ dispatch, collect, receive, abandonWorker, running, subscribe });
		}),
	);
}

/** A snapshot of `job`. Pass `completionTokens` once it has finished; a
 *  finished job isn't thinking. */
function runningJob(jobId: string, job: Job, completionTokens: number | null = null): RunningJob {
	return {
		jobId,
		workerId: job.workerId,
		model: job.model,
		startedAt: job.startedAt,
		outputChunks: job.outputChunks,
		thinking: completionTokens === null && job.thinking,
		completionTokens,
	};
}

/** Whether a delta is only reasoning: the model is thinking, not answering. */
function isReasoningOnly(delta: Extract<JobEvent, { type: "delta" }>): boolean {
	return (
		delta.reasoning !== undefined && delta.content === undefined && delta.toolCalls === undefined
	);
}

/** Run a job's events to completion and reassemble its result. */
export const resultOf = <E>(events: Stream.Stream<JobEvent, E>) =>
	Stream.runFold(events, () => emptyResult, applyEvent).pipe(Effect.map(finish));

interface Accumulated {
	readonly content: string;
	readonly toolCalls: ReadonlyMap<number, ToolCall>;
	readonly done?: Extract<JobEvent, { type: "done" }>;
	readonly embedding?: ReadonlyArray<number>;
	readonly images?: ReadonlyArray<GeneratedImage>;
	readonly audio?: { readonly b64: string; readonly mimeType: string };
}

const emptyResult: Accumulated = { content: "", toolCalls: new Map() };

/** Fold one event into the result so far. Tool-call `arguments` arrive as
 *  JSON slices to concatenate per call index; `id` and `name` arrive once. */
function applyEvent(acc: Accumulated, event: JobEvent): Accumulated {
	switch (event.type) {
		case "delta": {
			const toolCalls = new Map(acc.toolCalls);
			for (const tc of event.toolCalls ?? []) {
				const prev = toolCalls.get(tc.index);
				toolCalls.set(tc.index, {
					index: tc.index,
					id: tc.id || prev?.id || "",
					name: tc.name || prev?.name || "",
					arguments: (prev?.arguments ?? "") + (tc.arguments ?? ""),
				});
			}
			return { ...acc, content: acc.content + (event.content ?? ""), toolCalls };
		}
		case "embedding":
			return { ...acc, embedding: event.vector };
		case "image":
			return { ...acc, images: event.images };
		case "audio":
			return { ...acc, audio: { b64: event.b64, mimeType: event.mimeType } };
		case "done":
			return { ...acc, done: event };
	}
}

function finish(acc: Accumulated): JobResult {
	return {
		content: acc.content,
		toolCalls: [...acc.toolCalls.values()].sort((a, b) => a.index - b.index),
		finishReason: acc.done?.finishReason ?? "stop",
		...(acc.embedding !== undefined ? { embedding: acc.embedding } : {}),
		...(acc.images !== undefined ? { images: acc.images } : {}),
		...(acc.audio !== undefined ? { audio: acc.audio } : {}),
		...(acc.done?.usage !== undefined ? { usage: acc.done.usage } : {}),
	};
}

