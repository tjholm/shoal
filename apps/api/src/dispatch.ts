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
	Effect,
	Layer,
	Option,
	Queue,
	Schema,
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

/** No connected worker advertises the model for this task. */
export class ModelNotServed extends Schema.TaggedError<ModelNotServed>()(
	"ModelNotServed",
	{ model: Schema.String, task: Schema.String },
) {
	get message(): string {
		return `No connected worker serves model "${this.model}" for task "${this.task}"`;
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
export type NoWorkerAvailable = ModelNotServed | WorkersBusy;

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
}

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
			NoWorkerAvailable
		>;
		/** Dispatch a job and wait for its whole result. */
		collect(request: JobRequest): Effect.Effect<
			{ jobId: string; result: JobResult },
			NoWorkerAvailable | JobFailed
		>;
		/** Apply a job message from the worker connected as `workerId`. Messages
		 *  about jobs dispatched to another worker are ignored. */
		receive(workerId: string, message: JobEvent | WorkerMessage): Effect.Effect<void>;
		/** Fail every job running on a worker that has gone away. */
		abandonWorker(workerId: string): Effect.Effect<void>;
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

			const cancel = (jobId: string) =>
				Effect.gen(function* () {
					const job = jobs.get(jobId);
					if (!job) return;
					jobs.delete(jobId);
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
					case "NotServed":
						return yield* new ModelNotServed(unavailable);
					case "Busy":
						return yield* new WorkersBusy(unavailable);
				}
				const worker = reservation.worker;
				const jobId = yield* newId(crypto);
				const events = yield* Queue.unbounded<JobEvent, JobFailed | Cause.Done>();
				jobs.set(jobId, {
					workerId: worker.workerId,
					organizationId: request.organizationId,
					keyId: worker.keyId,
					task: request.task,
					model: request.model,
					startedAt: yield* Clock.currentTimeMillis,
					events,
				});
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

			const recordUsage = (job: Job, done: Extract<JobEvent, { type: "done" }>) =>
				Effect.gen(function* () {
					// Only chat backends report usage, and a zero row would skew
					// rollups, so record nothing without it.
					if (job.task !== "chat" || !done.usage) return;
					const now = yield* Clock.currentTimeMillis;
					yield* usage
						.record({
							organizationId: job.organizationId,
							workerId: job.workerId,
							keyId: job.keyId,
							model: job.model,
							task: job.task,
							promptTokens: done.usage.promptTokens,
							completionTokens: done.usage.completionTokens,
							finishReason: done.finishReason,
							durationMs: now - job.startedAt,
						})
						.pipe(
							// The response has already gone out, so a failed write must
							// not fail it — but it must be visible.
							Effect.catch((err) =>
								Effect.logError("failed to write usage_event", err),
							),
							Effect.forkIn(scope),
						);
				});

			const receive = (workerId: string, message: JobEvent | WorkerMessage) =>
				Effect.gen(function* () {
					if (!("jobId" in message)) return;
					const job = jobs.get(message.jobId);
					if (!job || job.workerId !== workerId) return;
					switch (message.type) {
						case "delta":
						case "embedding":
						case "image":
						case "audio":
							yield* Queue.offer(job.events, message);
							return;
						case "done":
							jobs.delete(message.jobId);
							yield* Queue.offer(job.events, message);
							yield* Queue.end(job.events);
							yield* registry.release(workerId, "completed");
							yield* recordUsage(job, message);
							return;
						case "error":
							jobs.delete(message.jobId);
							yield* Queue.fail(job.events, new JobFailed({ message: message.message }));
							yield* registry.release(workerId, "abandoned");
							return;
					}
				});

			const abandonWorker = (workerId: string) =>
				Effect.forEach(
					[...jobs].filter(([, job]) => job.workerId === workerId),
					([jobId, job]) => {
						jobs.delete(jobId);
						return Queue.fail(job.events, new JobFailed({ message: "Worker disconnected" }));
					},
					{ discard: true },
				);

			return Dispatcher.of({ dispatch, collect, receive, abandonWorker });
		}),
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

