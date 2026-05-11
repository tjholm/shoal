import { db, eq, schema, sql } from "@shoal/db";
import { getWorker, listOrgWorkers } from "@shoal/server-core/workers";
import type { WorkerInfo } from "../server/functions/workers";

/**
 * Build the full WorkerInfo list for an org: DB registrations enriched with
 * in-memory live state and per-worker usage aggregates. Used by the workers
 * server-fn and by the SSE stream endpoint to produce its initial snapshot.
 *
 * Kept out of `server-fns.ts` so the DB/drizzle imports don't leak into the
 * client bundle — `createServerFn` strips handler bodies on the client, but a
 * plain exported function would not be stripped and `WorkerInfo` is imported
 * by client components.
 */
export async function snapshotOrgWorkers(orgId: string): Promise<WorkerInfo[]> {
	const rows = await listOrgWorkers(orgId);

	// Aggregate usage per worker in one round-trip.
	const usageRows = await db
		.select({
			workerId: schema.usageEvent.workerId,
			promptTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.promptTokens}), 0)`,
			completionTokens: sql<number>`COALESCE(SUM(${schema.usageEvent.completionTokens}), 0)`,
			jobs: sql<number>`COUNT(*)`,
		})
		.from(schema.usageEvent)
		.where(eq(schema.usageEvent.organizationId, orgId))
		.groupBy(schema.usageEvent.workerId);

	const usageByWorker = new Map(
		usageRows.map((u) => [
			u.workerId,
			{
				promptTokens: Number(u.promptTokens),
				completionTokens: Number(u.completionTokens),
				jobs: Number(u.jobs),
			},
		]),
	);

	const now = Date.now();
	return rows.map((row) => {
		const live = getWorker(row.workerId);
		const usage = usageByWorker.get(row.workerId);
		return {
			workerId: row.workerId,
			name: row.name,
			online: !!live,
			loadedModel: live?.loadedModel ?? null,
			availableModels: live?.availableModels ?? [],
			inFlight: live?.inFlight ?? 0,
			maxConcurrent: live?.maxConcurrent ?? null,
			connectedMs: live ? now - live.connectedAt : null,
			lastSeenAt: row.lastSeenAt.getTime(),
			firstSeenAt: row.firstSeenAt.getTime(),
			totalPromptTokens: usage?.promptTokens ?? 0,
			totalCompletionTokens: usage?.completionTokens ?? 0,
			totalJobs: usage?.jobs ?? 0,
		};
	});
}

export async function snapshotOneWorker(
	workerId: string,
	orgId: string,
): Promise<WorkerInfo | null> {
	const all = await snapshotOrgWorkers(orgId);
	return all.find((w) => w.workerId === workerId) ?? null;
}
