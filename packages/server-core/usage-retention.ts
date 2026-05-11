import { db as defaultDb, lt, schema } from "@shoal/db";

export interface PruneOptions {
  retentionDays: number;
}

export async function pruneUsageEvents(
  database: typeof defaultDb,
  { retentionDays }: PruneOptions,
): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  await database
    .delete(schema.usageEvent)
    .where(lt(schema.usageEvent.createdAt, cutoff));
  console.log(
    `[usage-retention] pruned usage_event rows older than ${cutoff.toISOString()} (retention: ${retentionDays}d)`,
  );
}
