import { WorkerModel } from "@shoal/protocol";
import { Schema } from "effect";

/** A worker registration enriched with its live state and lifetime usage. */
export const WorkerInfo = Schema.Struct({
	workerId: Schema.String,
	name: Schema.NullOr(Schema.String),
	/** The API key the worker last authenticated with. */
	keyId: Schema.NullOr(Schema.String),
	online: Schema.Boolean,
	/** Models currently resident on the worker's backends. Empty when offline. */
	loadedModels: Schema.Array(Schema.String),
	availableModels: Schema.Array(WorkerModel),
	inFlight: Schema.Number,
	maxConcurrent: Schema.NullOr(Schema.Number),
	/** Milliseconds since the active connection started; null when offline. */
	connectedMs: Schema.NullOr(Schema.Number),
	/** Epoch milliseconds the worker was last seen, live or persisted. */
	lastSeenAt: Schema.Number,
	firstSeenAt: Schema.Number,
	totalPromptTokens: Schema.Number,
	totalCompletionTokens: Schema.Number,
	totalJobs: Schema.Number,
});
export type WorkerInfo = typeof WorkerInfo.Type;

export const WorkerDetail = Schema.Struct({
	...WorkerInfo.fields,
	avgDurationMs: Schema.NullOr(Schema.Number),
	keyName: Schema.NullOr(Schema.String),
});
export type WorkerDetail = typeof WorkerDetail.Type;

export const ModelUsage = Schema.Struct({
	model: Schema.String,
	jobs: Schema.Number,
	promptTokens: Schema.Number,
	completionTokens: Schema.Number,
});
export type ModelUsage = typeof ModelUsage.Type;

/** One completed job with token usage. */
export const UsageEventRow = Schema.Struct({
	id: Schema.String,
	workerId: Schema.String,
	workerName: Schema.NullOr(Schema.String),
	model: Schema.String,
	task: Schema.String,
	promptTokens: Schema.Number,
	completionTokens: Schema.Number,
	finishReason: Schema.NullOr(Schema.String),
	durationMs: Schema.NullOr(Schema.Number),
	createdAt: Schema.Number,
});
export type UsageEventRow = typeof UsageEventRow.Type;

export const UsageBucket = Schema.Struct({
	/** UTC day, `YYYY-MM-DD`. */
	date: Schema.String,
	promptTokens: Schema.Number,
	completionTokens: Schema.Number,
	jobs: Schema.Number,
});
export type UsageBucket = typeof UsageBucket.Type;

/** The window a usage summary covers: hourly buckets for 24h, daily otherwise. */
export const UsageRange = Schema.Literals(["24h", "7d", "14d"]);
export type UsageRange = typeof UsageRange.Type;

export const UsageTotals = Schema.Struct({
	jobs: Schema.Number,
	promptTokens: Schema.Number,
	completionTokens: Schema.Number,
	avgDurationMs: Schema.NullOr(Schema.Number),
});
export type UsageTotals = typeof UsageTotals.Type;

export const UsageSummary = Schema.Struct({
	range: UsageRange,
	/** Oldest first; `start` is the bucket's start in epoch milliseconds. */
	buckets: Schema.Array(Schema.Struct({ start: Schema.Number, ...UsageTotals.fields })),
	current: UsageTotals,
	/** The window of the same length immediately before `current`. */
	previous: UsageTotals,
});
export type UsageSummary = typeof UsageSummary.Type;

/** One worker's daily usage, oldest first, zero-filled. */
export const WorkerUsageSeries = Schema.Struct({
	workerId: Schema.String,
	days: Schema.Array(UsageBucket),
});
export type WorkerUsageSeries = typeof WorkerUsageSeries.Type;

export const ServerConfig = Schema.Struct({
	/** Days of usage data retained before the prune job deletes it. */
	usageRetentionDays: Schema.Number,
	/** Public WebSocket URL workers should connect to. */
	serverWsUrl: Schema.String,
	/** Whether the public sign-up form accepts new registrations right now. */
	signupAllowed: Schema.Boolean,
});
export type ServerConfig = typeof ServerConfig.Type;

export const InvitationStatus = Schema.Literals([
	"pending",
	"expired",
	"accepted",
	"rejected",
	"canceled",
	"not_found",
]);

export const InvitationPublicInfo = Schema.Struct({
	status: InvitationStatus,
	email: Schema.NullOr(Schema.String),
	organizationName: Schema.NullOr(Schema.String),
	inviterName: Schema.NullOr(Schema.String),
	inviterEmail: Schema.NullOr(Schema.String),
	role: Schema.NullOr(Schema.String),
});
export type InvitationPublicInfo = typeof InvitationPublicInfo.Type;

/** A job running on a worker right now. */
export const ActiveJob = Schema.Struct({
	jobId: Schema.String,
	workerId: Schema.String,
	model: Schema.String,
	/** Server epoch milliseconds the job was dispatched. */
	startedAt: Schema.Number,
	/** Output chunks the worker has streamed so far: an estimate of tokens,
	 *  about one each for chat. */
	outputChunks: Schema.Number,
	/** Exact output tokens once the job has finished and its usage is being
	 *  recorded; null while it runs. The job leaves the feed once the usage
	 *  totals include it. */
	completionTokens: Schema.NullOr(Schema.Number),
});
export type ActiveJob = typeof ActiveJob.Type;

/** Events on the `/api/activity/stream` SSE feed, shaped like the worker
 *  feed: a `snapshot` seeds the client, then `upsert`/`delete` events follow
 *  every change. */
export const ActivityEvent = Schema.Union([
	Schema.Struct({
		type: Schema.tag("snapshot"),
		jobs: Schema.Array(ActiveJob),
		/** Server epoch milliseconds when sent, to read `startedAt` against. */
		serverTime: Schema.Number,
	}),
	Schema.Struct({ type: Schema.tag("upsert"), job: ActiveJob }),
	Schema.Struct({ type: Schema.tag("delete"), jobId: Schema.String }),
]);
export type ActivityEvent = typeof ActivityEvent.Type;

/** Events on the `/api/workers/stream` SSE feed. The SSE event name is the
 *  `type` field; `data` is the JSON payload. */
export const WorkerStreamEvent = Schema.Union([
	Schema.Struct({ type: Schema.tag("snapshot"), workers: Schema.Array(WorkerInfo) }),
	Schema.Struct({ type: Schema.tag("upsert"), worker: WorkerInfo }),
	Schema.Struct({ type: Schema.tag("delete"), workerId: Schema.String }),
]);
export type WorkerStreamEvent = typeof WorkerStreamEvent.Type;

