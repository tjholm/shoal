import { and, db, eq, gte, schema, sql } from "@shoal/db";
import type { ModelTask } from "@shoal/protocol";
import {
	allWorkers,
	availableModels,
	getWorker,
} from "@shoal/server-core/workers";
import { createServerFn } from "@tanstack/react-start";
import { orgMiddleware } from "../middleware/org";

/**
 * DB-backed aggregates for the dashboard. Live worker counts (online/busy/idle)
 * and the available-model list are intentionally NOT included here — those
 * derive from the `workersCollection` SSE feed on the client, and a tiny
 * `getWorkerCountsSnapshot()` server fn covers the SSR fallback. Splitting the
 * two means this query is cache-friendly (15-30s staleTime) while live counts
 * stay current via the collection.
 */
export interface DashboardAggregates {
	/** Lifetime totals across `usage_event`. Survive worker reconnects. */
	totalJobs: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	/** Last 24 hours. */
	jobsLastDay: number;
	tokensLastDay: number;
}

/**
 * Cheap snapshot of worker liveness used as the SSR fallback before the
 * `workersCollection` (SSE) hydrates. Backed by the in-memory worker map plus a
 * single COUNT for total registrations.
 */
export interface WorkerCountsSnapshot {
	onlineCount: number;
	busyCount: number;
	idleCount: number;
	totalWorkerCount: number;
	models: string[];
}

export interface UsageBucket {
	date: string; // YYYY-MM-DD (UTC)
	promptTokens: number;
	completionTokens: number;
	jobs: number;
}

export interface OrgModelUsage {
	model: string;
	jobs: number;
	promptTokens: number;
	completionTokens: number;
}

export interface WorkerLeaderboardEntry {
	workerId: string;
	name: string | null;
	online: boolean;
	jobs: number;
	promptTokens: number;
	completionTokens: number;
}

export const getDashboardAggregates = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }): Promise<DashboardAggregates> => {
		const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

		const [lifetimeRows, dayRows] = await Promise.all([
			db
				.select({
					jobs: sql<number>`COUNT(*)`,
					promptTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.promptTokens}), 0)`,
					completionTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.completionTokens}), 0)`,
				})
				.from(schema.usageEvent)
				.where(eq(schema.usageEvent.organizationId, context.orgId)),
			db
				.select({
					jobs: sql<number>`COUNT(*)`,
					tokens: sql<number>`COALESCE(SUM(${schema.usageEvent.promptTokens} + ${schema.usageEvent.completionTokens}), 0)`,
				})
				.from(schema.usageEvent)
				.where(
					and(
						eq(schema.usageEvent.organizationId, context.orgId),
						gte(schema.usageEvent.createdAt, dayAgo),
					),
				),
		]);

		const lifetime = lifetimeRows[0];
		const day = dayRows[0];

		return {
			totalJobs: Number(lifetime?.jobs ?? 0),
			totalPromptTokens: Number(lifetime?.promptTokens ?? 0),
			totalCompletionTokens: Number(lifetime?.completionTokens ?? 0),
			jobsLastDay: Number(day?.jobs ?? 0),
			tokensLastDay: Number(day?.tokens ?? 0),
		};
	});

export const getWorkerCountsSnapshot = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.inputValidator((data: { task?: ModelTask } | undefined) => data ?? {})
	.handler(async ({ data, context }): Promise<WorkerCountsSnapshot> => {
		const liveWorkers = allWorkers(context.orgId);
		const busy = liveWorkers.filter((w) => w.inFlight > 0).length;

		const totalRows = await db
			.select({ count: sql<number>`COUNT(*)` })
			.from(schema.worker)
			.where(eq(schema.worker.organizationId, context.orgId));

		return {
			onlineCount: liveWorkers.length,
			busyCount: busy,
			idleCount: liveWorkers.length - busy,
			totalWorkerCount: Number(totalRows[0]?.count ?? 0),
			models: availableModels(context.orgId, data.task),
		};
	});

/** Per-model rollup across all workers in the org, ranked by job count. */
export const getOrgUsageByModel = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }): Promise<OrgModelUsage[]> => {
		const rows = await db
			.select({
				model: schema.usageEvent.model,
				promptTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.promptTokens}), 0)`,
				completionTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.completionTokens}), 0)`,
				jobs: sql<number>`COUNT(*)`,
			})
			.from(schema.usageEvent)
			.where(eq(schema.usageEvent.organizationId, context.orgId))
			.groupBy(schema.usageEvent.model)
			.orderBy(sql`COUNT(*) DESC`);
		return rows.map((r) => ({
			model: r.model,
			jobs: Number(r.jobs),
			promptTokens: Number(r.promptTokens),
			completionTokens: Number(r.completionTokens),
		}));
	});

/** Daily usage rollup for the org over the last `days` days. */
export const getUsageDaily = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.inputValidator((data: { days?: number }) => data)
	.handler(async ({ data, context }): Promise<UsageBucket[]> => {
		const days = data.days ?? 30;
		const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const rows = await db
			.select({
				date: sql<string>`TO_CHAR(${schema.usageEvent.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
				promptTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.promptTokens}), 0)`,
				completionTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.completionTokens}), 0)`,
				jobs: sql<number>`COUNT(*)`,
			})
			.from(schema.usageEvent)
			.where(
				and(
					eq(schema.usageEvent.organizationId, context.orgId),
					gte(schema.usageEvent.createdAt, since),
				),
			)
			.groupBy(
				sql`TO_CHAR(${schema.usageEvent.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
			)
			.orderBy(
				sql`TO_CHAR(${schema.usageEvent.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
			);
		return rows.map((r) => ({
			date: r.date,
			promptTokens: Number(r.promptTokens),
			completionTokens: Number(r.completionTokens),
			jobs: Number(r.jobs),
		}));
	});

/**
 * Top workers in the org by lifetime job count. Includes offline workers — the
 * leaderboard is about cumulative contribution, not current availability.
 */
export const getWorkerLeaderboard = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.inputValidator((data: { limit?: number }) => data)
	.handler(async ({ data, context }): Promise<WorkerLeaderboardEntry[]> => {
		const limit = Math.min(data.limit ?? 10, 50);
		const rows = await db
			.select({
				workerId: schema.usageEvent.workerId,
				name: schema.worker.name,
				promptTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.promptTokens}), 0)`,
				completionTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.completionTokens}), 0)`,
				jobs: sql<number>`COUNT(*)`,
			})
			.from(schema.usageEvent)
			.leftJoin(schema.worker, eq(schema.usageEvent.workerId, schema.worker.id))
			.where(eq(schema.usageEvent.organizationId, context.orgId))
			.groupBy(schema.usageEvent.workerId, schema.worker.name)
			.orderBy(sql`COUNT(*) DESC`)
			.limit(limit);

		return rows.map((r) => ({
			workerId: r.workerId,
			name: r.name,
			online: !!getWorker(r.workerId),
			jobs: Number(r.jobs),
			promptTokens: Number(r.promptTokens),
			completionTokens: Number(r.completionTokens),
		}));
	});
