import type { ActivityEvent } from "@shoal/contracts";
import { Clock, Effect, Stream } from "effect";
import { Dispatcher, type JobChange } from "../dispatch";

const toEvent = (change: JobChange): ActivityEvent =>
	change.type === "deleted"
		? { type: "delete", jobId: change.jobId }
		: { type: "upsert", job: change.job };

/**
 * An org's running jobs as a feed: a `snapshot` first, then `upsert`/`delete`
 * events for every change. Read from the dispatcher's memory, so it never
 * touches the database.
 */
export const activityEvents = Effect.gen(function* () {
	const dispatcher = yield* Dispatcher;

	return (organizationId: string): Stream.Stream<ActivityEvent> =>
		Stream.unwrap(
			Effect.gen(function* () {
				// Subscribe before taking the snapshot so no change falls between.
				const changes = yield* dispatcher.subscribe(organizationId);
				const jobs = yield* dispatcher.running(organizationId);
				const serverTime = yield* Clock.currentTimeMillis;
				return Stream.concat(
					Stream.succeed<ActivityEvent>({ type: "snapshot", jobs, serverTime }),
					changes.pipe(Stream.map(toEvent)),
				);
			}),
		);
});
