// In-process scheduler initialisation. Replaces the equivalent block that
// used to live in the old `apps/server/server.ts`. The plugin runs once on
// nitro startup; the `close` hook lets us stop the cron jobs when the server
// is shutting down.
import { db } from "@shoal/db";
import { createCronScheduler, type Scheduler } from "@shoal/server-core/scheduler";
import { pruneUsageEvents } from "@shoal/server-core/usage-retention";
import { definePlugin } from "nitro";
import {
  SCHEDULER_ENABLED,
  USAGE_PRUNE_CRON,
  USAGE_RETENTION_DAYS,
} from "../../src/server/env";

// HMR / branch-switching in dev re-evaluates this plugin module without nitro
// firing the previous `close` hook, so the prior scheduler's cron jobs are
// left running. Croner keeps a process-global registry of named jobs and
// throws ("name already taken") when we try to register the same job again,
// and even if it didn't, we'd leak duplicate prune jobs across reloads. Stash
// the active scheduler on globalThis so a re-evaluation can tear it down
// before installing a fresh one.
const SCHEDULER_KEY = "__shoal_scheduler__";
const globals = globalThis as Record<string, unknown>;

export default definePlugin((nitroApp) => {
  if (!SCHEDULER_ENABLED) {
    console.log(
      "[server] in-process scheduler disabled (SHOAL_SCHEDULER_ENABLED=false)",
    );
    return;
  }

  const previous = globals[SCHEDULER_KEY] as Scheduler | undefined;
  if (previous) previous.stop();

  const scheduler = createCronScheduler();
  scheduler.register({
    name: "prune-usage",
    cron: USAGE_PRUNE_CRON,
    run: () => pruneUsageEvents(db, { retentionDays: USAGE_RETENTION_DAYS }),
  });
  scheduler.start();
  globals[SCHEDULER_KEY] = scheduler;

  nitroApp.hooks.hook("close", () => {
    scheduler.stop();
    if (globals[SCHEDULER_KEY] === scheduler) delete globals[SCHEDULER_KEY];
  });
});
