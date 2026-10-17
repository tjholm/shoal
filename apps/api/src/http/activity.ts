import type { ActivityEvent } from "@shoal/contracts";
import { Clock, Effect, Layer, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { Auth } from "../auth";
import { Dispatcher, type JobChange } from "../dispatch";
import { orgEventStream } from "./org-events";

const toEvent = (change: JobChange): ActivityEvent =>
	change.type === "deleted"
		? { type: "delete", jobId: change.jobId }
		: { type: "upsert", job: change.job };

/**
 * `GET /api/activity/stream`: the org's running jobs as server-sent events. A
 * `snapshot` event seeds the client, then `upsert`/`delete` events follow
 * every change. Read from the dispatcher's memory, so it never touches the
 * database.
 */
export const activityStreamRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const auth = yield* Auth;
		const dispatcher = yield* Dispatcher;

		const events = (organizationId: string): Stream.Stream<ActivityEvent> =>
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

		yield* router.add("GET", "/api/activity/stream", orgEventStream(auth, events));
	}),
);
