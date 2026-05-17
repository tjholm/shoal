import { and, db, desc, eq, gte, schema, sql } from "@shoal/db";
import type { WorkerModel } from "@shoal/protocol";
import {
	deleteWorker as deleteWorkerCore,
	getWorker,
	setWorkerName,
} from "@shoal/server-core/workers";
import { createServerFn } from "@tanstack/react-start";
import { orgMiddleware } from "../middleware/org";
import type { UsageBucket } from "./usage";

export interface WorkerInfo {
	workerId: string;
	name: string | null;
	online: boolean;
	/** Live: models currently resident on the worker's backends, deduped across
	 *  backends. Offline or no live state: empty array. */
	loadedModels: string[];
	availableModels: WorkerModel[];
	inFlight: number;
	maxConcurrent: number | null;
	/** Live: ms since the active connection started. Offline: null. */
	connectedMs: number | null;
	/** ms epoch — last time we saw this worker (live or persisted). */
	lastSeenAt: number;
	firstSeenAt: number;
	/** Cumulative across all sessions. */
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalJobs: number;
}

export interface WorkerDetail {
	workerId: string;
	name: string | null;
	online: boolean;
	inFlight: number;
	maxConcurrent: number | null;
	loadedModels: string[];
	availableModels: WorkerModel[];
	firstSeenAt: number;
	lastSeenAt: number;
	connectedMs: number | null;
	totalJobs: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	avgDurationMs: number | null;
	keyId: string | null;
	keyName: string | null;
}

export interface WorkerModelUsage {
	model: string;
	jobs: number;
	promptTokens: number;
	completionTokens: number;
}

export interface WorkerEventRow {
	id: string;
	model: string;
	task: string;
	promptTokens: number;
	completionTokens: number;
	finishReason: string | null;
	durationMs: number | null;
	createdAt: number;
}

export const getWorkers = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }): Promise<WorkerInfo[]> => {
		const { snapshotOrgWorkers } = await import("../workers-snapshot");
		return snapshotOrgWorkers(context.orgId);
	});

export const renameWorker = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.inputValidator((data: { workerId: string; name: string | null }) => data)
	.handler(async ({ data, context }) => {
		await setWorkerName(data.workerId, context.orgId, data.name);
		return { success: true };
	});

export const deleteWorker = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.inputValidator((data: { workerId: string }) => data)
	.handler(async ({ data, context }) => {
		const deleted = await deleteWorkerCore(data.workerId, context.orgId);
		return { success: deleted };
	});

export const getWorkerDetail = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.inputValidator((data: { workerId: string }) => data)
	.handler(async ({ data, context }): Promise<WorkerDetail | null> => {
		const rows = await db
			.select({
				workerId: schema.worker.id,
				name: schema.worker.name,
				firstSeenAt: schema.worker.firstSeenAt,
				lastSeenAt: schema.worker.lastSeenAt,
				keyId: schema.worker.keyId,
				keyName: schema.apikey.name,
			})
			.from(schema.worker)
			.leftJoin(schema.apikey, eq(schema.worker.keyId, schema.apikey.id))
			.where(
				and(
					eq(schema.worker.id, data.workerId),
					eq(schema.worker.organizationId, context.orgId),
				),
			)
			.limit(1);

		const row = rows[0];
		if (!row) return null;

		const usageRows = await db
			.select({
				promptTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.promptTokens}), 0)`,
				completionTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.completionTokens}), 0)`,
				jobs: sql<number>`COUNT(*)`,
				avgDuration: sql<number | null>`AVG(${schema.usageEvent.durationMs})`,
			})
			.from(schema.usageEvent)
			.where(eq(schema.usageEvent.workerId, data.workerId));
		const usage = usageRows[0];

		const live = getWorker(row.workerId);
		const now = Date.now();

		return {
			workerId: row.workerId,
			name: row.name,
			online: !!live,
			inFlight: live?.inFlight ?? 0,
			maxConcurrent: live?.maxConcurrent ?? null,
			loadedModels: live?.loadedModels ?? [],
			availableModels: live?.availableModels ?? [],
			firstSeenAt: row.firstSeenAt.getTime(),
			lastSeenAt: row.lastSeenAt.getTime(),
			connectedMs: live ? now - live.connectedAt : null,
			totalJobs: Number(usage?.jobs ?? 0),
			totalPromptTokens: Number(usage?.promptTokens ?? 0),
			totalCompletionTokens: Number(usage?.completionTokens ?? 0),
			avgDurationMs:
				usage?.avgDuration != null ? Number(usage.avgDuration) : null,
			keyId: row.keyId,
			keyName: row.keyName,
		};
	});

export const getWorkerUsageDaily = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.inputValidator((data: { workerId: string; days?: number }) => data)
	.handler(async ({ data, context }): Promise<UsageBucket[]> => {
		const days = data.days ?? 14;
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
					eq(schema.usageEvent.workerId, data.workerId),
					gte(schema.usageEvent.createdAt, since),
				),
			)
			.groupBy(
				sql`TO_CHAR(${schema.usageEvent.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
			)
			.orderBy(
				sql`TO_CHAR(${schema.usageEvent.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
			);

		// Backfill missing days with zeroes so the chart axis stays continuous.
		const byDate = new Map(rows.map((r) => [r.date, r]));
		const out: UsageBucket[] = [];
		for (let i = days - 1; i >= 0; i--) {
			const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
			const key = d.toISOString().slice(0, 10);
			const r = byDate.get(key);
			out.push({
				date: key,
				promptTokens: r ? Number(r.promptTokens) : 0,
				completionTokens: r ? Number(r.completionTokens) : 0,
				jobs: r ? Number(r.jobs) : 0,
			});
		}
		return out;
	});

export const getWorkerUsageByModel = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.inputValidator((data: { workerId: string }) => data)
	.handler(async ({ data, context }): Promise<WorkerModelUsage[]> => {
		const rows = await db
			.select({
				model: schema.usageEvent.model,
				promptTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.promptTokens}), 0)`,
				completionTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.completionTokens}), 0)`,
				jobs: sql<number>`COUNT(*)`,
			})
			.from(schema.usageEvent)
			.where(
				and(
					eq(schema.usageEvent.organizationId, context.orgId),
					eq(schema.usageEvent.workerId, data.workerId),
				),
			)
			.groupBy(schema.usageEvent.model)
			.orderBy(sql`COUNT(*) DESC`);
		return rows.map((r) => ({
			model: r.model,
			jobs: Number(r.jobs),
			promptTokens: Number(r.promptTokens),
			completionTokens: Number(r.completionTokens),
		}));
	});

export const getWorkerRecentEvents = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.inputValidator((data: { workerId: string; limit?: number }) => data)
	.handler(async ({ data, context }): Promise<WorkerEventRow[]> => {
		const limit = Math.min(data.limit ?? 25, 100);
		const rows = await db
			.select({
				id: schema.usageEvent.id,
				model: schema.usageEvent.model,
				task: schema.usageEvent.task,
				promptTokens: schema.usageEvent.promptTokens,
				completionTokens: schema.usageEvent.completionTokens,
				finishReason: schema.usageEvent.finishReason,
				durationMs: schema.usageEvent.durationMs,
				createdAt: schema.usageEvent.createdAt,
			})
			.from(schema.usageEvent)
			.where(
				and(
					eq(schema.usageEvent.organizationId, context.orgId),
					eq(schema.usageEvent.workerId, data.workerId),
				),
			)
			.orderBy(desc(schema.usageEvent.createdAt))
			.limit(limit);
		return rows.map((r) => ({
			id: r.id,
			model: r.model,
			task: r.task,
			promptTokens: r.promptTokens,
			completionTokens: r.completionTokens,
			finishReason: r.finishReason,
			durationMs: r.durationMs,
			createdAt: r.createdAt.getTime(),
		}));
	});
