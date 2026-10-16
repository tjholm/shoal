import type { WorkerInfo } from "@shoal/contracts";
import type { WorkerModel } from "@shoal/protocol";
import { Clock, Effect, Option } from "effect";
import { Usage, type UsageTotals } from "../usage";
import { type LiveWorker, type WorkerRegistration, WorkerRegistry } from "./registry";

const noUsage: UsageTotals = { jobs: 0, promptTokens: 0, completionTokens: 0 };

/** The live-state fields of a `WorkerInfo`, from the registry's view of a
 *  worker, or its last advertised models when offline. */
export function liveFields(
	live: Option.Option<LiveWorker>,
	now: number,
	lastModels: ReadonlyArray<WorkerModel>,
): Pick<
	WorkerInfo,
	"online" | "loadedModels" | "availableModels" | "inFlight" | "maxConcurrent" | "connectedMs"
> {
	return Option.match(live, {
		onNone: () => ({
			online: false,
			loadedModels: [],
			availableModels: lastModels,
			inFlight: 0,
			maxConcurrent: null,
			connectedMs: null,
		}),
		onSome: (w) => ({
			online: true,
			loadedModels: w.loadedModels,
			availableModels: w.availableModels,
			inFlight: w.inFlight,
			maxConcurrent: w.maxConcurrent,
			connectedMs: now - w.connectedAt,
		}),
	});
}

const toInfo = (
	row: WorkerRegistration,
	live: Option.Option<LiveWorker>,
	usage: UsageTotals,
	now: number,
): WorkerInfo => ({
	workerId: row.workerId,
	name: row.name,
	keyId: row.keyId,
	...liveFields(live, now, row.lastModels),
	lastSeenAt: row.lastSeenAt.getTime(),
	firstSeenAt: row.firstSeenAt.getTime(),
	totalPromptTokens: usage.promptTokens,
	totalCompletionTokens: usage.completionTokens,
	totalJobs: usage.jobs,
});

/** Every worker registered in the org, with live state and lifetime usage. */
export const snapshotWorkers = Effect.fn("snapshotWorkers")(function* (
	organizationId: string,
) {
	const registry = yield* WorkerRegistry;
	const usage = yield* Usage;
	const [rows, totals] = yield* Effect.all(
		[registry.registrations(organizationId), usage.totalsByWorker(organizationId)],
		{ concurrency: "unbounded" },
	);
	const now = yield* Clock.currentTimeMillis;
	return yield* Effect.forEach(rows, (row) =>
		registry
			.get(row.workerId)
			.pipe(
				Effect.map((live) =>
					toInfo(row, live, totals.get(row.workerId) ?? noUsage, now),
				),
			),
	);
});
