import type {
	ModelStatsReport,
	RequestStats,
	UsageTotals as WindowTotals,
	UsageRange,
	UsageSummary,
	WorkerUsageSeries,
	ModelUsage,
	UsageBucket,
	UsageEventRow,
} from "@shoal/contracts";
import { Database, type DatabaseError } from "@shoal/db/database";
import * as schema from "@shoal/db/schema";
import type { FinishReason, ModelTask } from "@shoal/protocol";
import { and, desc, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import { Context, Crypto, Effect, Layer } from "effect";
import { newId } from "./workers/secrets";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageRecord {
	readonly organizationId: string;
	readonly workerId: string;
	readonly keyId: string | null;
	readonly model: string;
	readonly task: ModelTask;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly finishReason: FinishReason;
	readonly durationMs: number;
}

export interface UsageTotals {
	readonly jobs: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
}

/** Scope of a usage query: a whole org, or one worker within it. */
export interface UsageScope {
	readonly organizationId: string;
	readonly workerId?: string;
}

type Result<A> = Effect.Effect<A, DatabaseError>;

/** The `usage_event` table: one row per completed chat job with token usage. */
export class Usage extends Context.Service<
	Usage,
	{
		record(usage: UsageRecord): Result<void>;
		/** Delete rows older than `retentionDays`. */
		prune(retentionDays: number): Result<Date>;
		totalsByWorker(organizationId: string): Result<ReadonlyMap<string, UsageTotals>>;
		workerTotals(
			scope: Required<UsageScope>,
		): Result<UsageTotals & { avgDurationMs: number | null }>;
		/** One bucket per UTC day for the last `days` days, oldest first. With
		 *  `fill`, days without usage appear as zero buckets. */
		daily(
			scope: UsageScope,
			days: number,
			options: { fill: boolean },
		): Result<ReadonlyArray<UsageBucket>>;
		/** Usage over `range` in hourly (24h) or daily buckets, with the totals
		 *  for the window and for the equal window before it. */
		summary(organizationId: string, range: UsageRange): Result<UsageSummary>;
		/** Each worker's daily usage over the last `days` days. Workers with no
		 *  usage in the window are absent. */
		workerSeries(
			organizationId: string,
			days: number,
		): Result<ReadonlyArray<WorkerUsageSeries>>;
		/** Per-model rollup, most jobs first, optionally since a time. */
		byModel(scope: UsageScope, since?: Date): Result<ReadonlyArray<ModelUsage>>;
		/** Per-model and per-worker request stats over `range`, with requests
		 *  per model over time. */
		modelStats(organizationId: string, range: UsageRange): Result<ModelStatsReport>;
		/** Most recent first. */
		recentEvents(
			scope: UsageScope,
			limit: number,
		): Result<ReadonlyArray<UsageEventRow>>;
	}
>()("@shoal/api/Usage") {
	static readonly layer = Layer.effect(
		Usage,
		Effect.gen(function* () {
			const database = yield* Database;
			const crypto = yield* Crypto.Crypto;
			const e = schema.usageEvent;
			const promptTokens = sql<number>`COALESCE(SUM(${e.promptTokens}), 0)`;
			const completionTokens = sql<number>`COALESCE(SUM(${e.completionTokens}), 0)`;
			const jobs = sql<number>`COUNT(*)`;
			const day = sql<string>`TO_CHAR(${e.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

			const inScope = (scope: UsageScope, ...rest: Array<SQL>) =>
				and(
					eq(e.organizationId, scope.organizationId),
					...(scope.workerId !== undefined ? [eq(e.workerId, scope.workerId)] : []),
					...rest,
				);

			// Percentiles ignore rows with no duration. Speed is end to end: output
			// tokens over the whole request time.
			const requestStats = {
				jobs,
				promptTokens,
				completionTokens,
				p50DurationMs: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${e.durationMs})`,
				p90DurationMs: sql<number | null>`percentile_cont(0.9) WITHIN GROUP (ORDER BY ${e.durationMs})`,
				p50TokensPerSecond: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${e.completionTokens} * 1000.0 / NULLIF(${e.durationMs}, 0)) FILTER (WHERE ${e.completionTokens} > 0)`,
				truncated: sql<number>`COUNT(*) FILTER (WHERE ${e.finishReason} = 'length')`,
				toolCalls: sql<number>`COUNT(*) FILTER (WHERE ${e.finishReason} = 'tool_calls')`,
			};

			const totals = (row: {
				jobs: number;
				promptTokens: number;
				completionTokens: number;
			}): UsageTotals => ({
				jobs: Number(row.jobs),
				promptTokens: Number(row.promptTokens),
				completionTokens: Number(row.completionTokens),
			});

			return Usage.of({
				record: (usage) =>
					newId(crypto).pipe(
						Effect.flatMap((id) =>
							database.query((db) => db.insert(e).values({ id, ...usage })),
						),
						Effect.asVoid,
					),

				prune: (retentionDays) => {
					const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
					return database
						.query((db) => db.delete(e).where(lt(e.createdAt, cutoff)))
						.pipe(Effect.as(cutoff));
				},

				totalsByWorker: (organizationId) =>
					database
						.query((db) =>
							db
								.select({ workerId: e.workerId, jobs, promptTokens, completionTokens })
								.from(e)
								.where(inScope({ organizationId }))
								.groupBy(e.workerId),
						)
						.pipe(
							Effect.map(
								(rows) => new Map(rows.map((r) => [r.workerId, totals(r)])),
							),
						),

				workerTotals: (scope) =>
					database
						.query((db) =>
							db
								.select({
									jobs,
									promptTokens,
									completionTokens,
									avgDuration: sql<number | null>`AVG(${e.durationMs})`,
								})
								.from(e)
								.where(inScope(scope)),
						)
						.pipe(
							Effect.map(([row]) => ({
								...totals(row ?? { jobs: 0, promptTokens: 0, completionTokens: 0 }),
								avgDurationMs:
									row?.avgDuration != null ? Number(row.avgDuration) : null,
							})),
						),

				daily: (scope, days, { fill }) =>
					database
						.query((db) =>
							db
								.select({ date: day, jobs, promptTokens, completionTokens })
								.from(e)
								.where(
									inScope(scope, gte(e.createdAt, new Date(Date.now() - days * DAY_MS))),
								)
								.groupBy(day)
								.orderBy(day),
						)
						.pipe(
							Effect.map((rows) => {
								const buckets = rows.map((r) => ({ date: r.date, ...totals(r) }));
								return fill ? fillDays(buckets, days) : buckets;
							}),
						),

				byModel: (scope, since) =>
					database
						.query((db) =>
							db
								.select({ model: e.model, jobs, promptTokens, completionTokens })
								.from(e)
								.where(
									inScope(scope, ...(since !== undefined ? [gte(e.createdAt, since)] : [])),
								)
								.groupBy(e.model)
								.orderBy(sql`COUNT(*) DESC`),
						)
						.pipe(Effect.map((rows) => rows.map((r) => ({ model: r.model, ...totals(r) })))),

				summary: (organizationId, range) =>
					Effect.gen(function* () {
						const window = summaryWindow(range, new Date());
						// created_at is a zoneless UTC timestamp, so take the epoch in SQL
						// rather than letting the driver parse it as local time.
						const bucket = sql<string>`(EXTRACT(EPOCH FROM date_trunc(${sql.raw(`'${window.unit}'`)}, ${e.createdAt})) * 1000)::bigint`;
						const avgDuration = sql<number | null>`AVG(${e.durationMs})`;
						const scope = { organizationId };
						const [rows, [current], [previous]] = yield* Effect.all(
							[
								database.query((db) =>
									db
										.select({ start: bucket, jobs, promptTokens, completionTokens, avgDuration })
										.from(e)
										.where(inScope(scope, gte(e.createdAt, window.start)))
										.groupBy(bucket),
								),
								database.query((db) =>
									db
										.select({ jobs, promptTokens, completionTokens, avgDuration })
										.from(e)
										.where(inScope(scope, gte(e.createdAt, window.start))),
								),
								database.query((db) =>
									db
										.select({ jobs, promptTokens, completionTokens, avgDuration })
										.from(e)
										.where(
											inScope(
												scope,
												gte(e.createdAt, window.previousStart),
												lt(e.createdAt, window.start),
											),
										),
								),
							],
							{ concurrency: "unbounded" },
						);
						const byStart = new Map(
							rows.map((r) => [Number(r.start), windowTotals(r)]),
						);
						return {
							range,
							buckets: Array.from({ length: window.count }, (_, i) => {
								const start = window.start.getTime() + i * window.stepMs;
								return { start, ...(byStart.get(start) ?? emptyWindow) };
							}),
							current: current ? windowTotals(current) : emptyWindow,
							previous: previous ? windowTotals(previous) : emptyWindow,
						};
					}),

				workerSeries: (organizationId, days) =>
					database
						.query((db) =>
							db
								.select({
									workerId: e.workerId,
									date: day,
									jobs,
									promptTokens,
									completionTokens,
								})
								.from(e)
								.where(
									inScope(
										{ organizationId },
										gte(e.createdAt, new Date(Date.now() - days * DAY_MS)),
									),
								)
								.groupBy(e.workerId, day),
						)
						.pipe(
							Effect.map((rows) => {
								const byWorker = new Map<string, Array<UsageBucket>>();
								for (const r of rows) {
									const list = byWorker.get(r.workerId) ?? [];
									list.push({ date: r.date, ...totals(r) });
									byWorker.set(r.workerId, list);
								}
								return [...byWorker].map(([workerId, buckets]) => ({
									workerId,
									days: fillDays(buckets, days),
								}));
							}),
						),

				modelStats: (organizationId, range) =>
					Effect.gen(function* () {
						const window = summaryWindow(range, new Date());
						const bucket = sql<string>`(EXTRACT(EPOCH FROM date_trunc(${sql.raw(`'${window.unit}'`)}, ${e.createdAt})) * 1000)::bigint`;
						const scope = { organizationId };
						const inWindow = inScope(scope, gte(e.createdAt, window.start));
						const [models, workers, buckets] = yield* Effect.all(
							[
								database.query((db) =>
									db
										.select({ model: e.model, ...requestStats })
										.from(e)
										.where(inWindow)
										.groupBy(e.model)
										.orderBy(sql`COUNT(*) DESC`, e.model),
								),
								database.query((db) =>
									db
										.select({
											model: e.model,
											workerId: e.workerId,
											workerName: schema.worker.name,
											...requestStats,
										})
										.from(e)
										.leftJoin(schema.worker, eq(e.workerId, schema.worker.id))
										.where(inWindow)
										.groupBy(e.model, e.workerId, schema.worker.name)
										.orderBy(sql`COUNT(*) DESC`, e.workerId),
								),
								database.query((db) =>
									db
										.select({ start: bucket, model: e.model, jobs })
										.from(e)
										.where(inWindow)
										.groupBy(bucket, e.model),
								),
							],
							{ concurrency: "unbounded" },
						);
						const starts = Array.from(
							{ length: window.count },
							(_, i) => window.start.getTime() + i * window.stepMs,
						);
						const slot = new Map(starts.map((start, i) => [start, i]));
						const series = new Map<string, Array<number>>();
						for (const row of buckets) {
							const i = slot.get(Number(row.start));
							if (i === undefined) continue;
							const counts = series.get(row.model) ?? starts.map(() => 0);
							counts[i] = Number(row.jobs);
							series.set(row.model, counts);
						}
						return {
							range,
							models: models.map((m) => ({
								model: m.model,
								...toRequestStats(m),
								workers: workers
									.filter((w) => w.model === m.model)
									.map((w) => ({
										workerId: w.workerId,
										workerName: w.workerName,
										...toRequestStats(w),
									})),
							})),
							series: {
								starts,
								models: models.map((m) => ({
									model: m.model,
									jobs: series.get(m.model) ?? starts.map(() => 0),
								})),
							},
						};
					}),

				recentEvents: (scope, limit) =>
					database
						.query((db) =>
							db
								.select({
									id: e.id,
									workerId: e.workerId,
									workerName: schema.worker.name,
									model: e.model,
									task: e.task,
									promptTokens: e.promptTokens,
									completionTokens: e.completionTokens,
									finishReason: e.finishReason,
									durationMs: e.durationMs,
									createdAt: e.createdAt,
								})
								.from(e)
								.leftJoin(schema.worker, eq(e.workerId, schema.worker.id))
								.where(inScope(scope))
								.orderBy(desc(e.createdAt))
								.limit(limit),
						)
						.pipe(
							Effect.map((rows) =>
								rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime() })),
							),
						),
			});
		}),
	);
}

const HOUR_MS = 60 * 60 * 1000;

const emptyWindow: WindowTotals = {
	jobs: 0,
	promptTokens: 0,
	completionTokens: 0,
	avgDurationMs: null,
};

/** Postgres returns counts and percentiles as strings; make them numbers. */
function toRequestStats(row: {
	jobs: number;
	promptTokens: number;
	completionTokens: number;
	p50DurationMs: number | null;
	p90DurationMs: number | null;
	p50TokensPerSecond: number | null;
	truncated: number;
	toolCalls: number;
}): RequestStats {
	const orNull = (value: number | null) => (value != null ? Number(value) : null);
	return {
		jobs: Number(row.jobs),
		promptTokens: Number(row.promptTokens),
		completionTokens: Number(row.completionTokens),
		p50DurationMs: orNull(row.p50DurationMs),
		p90DurationMs: orNull(row.p90DurationMs),
		p50TokensPerSecond: orNull(row.p50TokensPerSecond),
		truncated: Number(row.truncated),
		toolCalls: Number(row.toolCalls),
	};
}

function windowTotals(row: {
	jobs: number;
	promptTokens: number;
	completionTokens: number;
	avgDuration: number | null;
}): WindowTotals {
	return {
		jobs: Number(row.jobs),
		promptTokens: Number(row.promptTokens),
		completionTokens: Number(row.completionTokens),
		avgDurationMs: row.avgDuration != null ? Number(row.avgDuration) : null,
	};
}

/** Bucket layout for a summary range, aligned to whole UTC hours or days so
 *  buckets line up with Postgres's `date_trunc`. */
function summaryWindow(range: UsageRange, now: Date) {
	const unit = range === "24h" ? "hour" : "day";
	const stepMs = unit === "hour" ? HOUR_MS : DAY_MS;
	const count = range === "24h" ? 24 : range === "7d" ? 7 : 14;
	const current = Math.floor(now.getTime() / stepMs) * stepMs;
	const start = new Date(current - (count - 1) * stepMs);
	return {
		unit,
		stepMs,
		count,
		start,
		previousStart: new Date(start.getTime() - count * stepMs),
	};
}

/** Zero-fill missing days so a chart's axis stays continuous. */
function fillDays(
	buckets: ReadonlyArray<UsageBucket>,
	days: number,
): ReadonlyArray<UsageBucket> {
	const byDate = new Map(buckets.map((b) => [b.date, b]));
	return Array.from({ length: days }, (_, i) => {
		const date = new Date(Date.now() - (days - 1 - i) * DAY_MS)
			.toISOString()
			.slice(0, 10);
		return (
			byDate.get(date) ?? { date, jobs: 0, promptTokens: 0, completionTokens: 0 }
		);
	});
}
