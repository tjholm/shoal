import { Effect, Layer, Schedule } from "effect";
import { ShoalConfig } from "./config";
import { Usage } from "./usage";

/** Prune usage rows past the retention window on `SHOAL_USAGE_PRUNE_CRON`,
 *  unless `SHOAL_SCHEDULER_ENABLED=false` hands that job to an external
 *  scheduler. */
export const usagePruning = Layer.effectDiscard(
	Effect.gen(function* () {
		const config = yield* ShoalConfig;
		if (!config.schedulerEnabled) {
			yield* Effect.log("in-process scheduler disabled (SHOAL_SCHEDULER_ENABLED=false)");
			return;
		}
		const usage = yield* Usage;
		const prune = usage.prune(config.usageRetentionDays).pipe(
			Effect.tap((cutoff) =>
				Effect.log(
					`pruned usage_event rows older than ${cutoff.toISOString()} (retention: ${config.usageRetentionDays}d)`,
				),
			),
			Effect.catch((err) => Effect.logError("usage prune failed", err)),
		);
		const schedule = Schedule.cron(config.usagePruneCron);
		yield* Effect.log(`scheduled usage pruning (cron: ${config.usagePruneCron})`);
		// The first run waits for the first cron tick, and runs never overlap.
		yield* Effect.sleep(0).pipe(
			Effect.andThen(Effect.schedule(prune, schedule)),
			Effect.forkScoped,
		);
	}),
);
