import type { ActivityEvent } from "@shoal/contracts";
import { Clock, Duration, Effect, Layer, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { Auth } from "../auth";
import { Dispatcher } from "../dispatch";
import { orgEventStream } from "./org-events";

/** Often enough for token counts to tick visibly, rare enough that a busy
 *  org's dashboards don't flood. Unchanged samples aren't sent. */
const SAMPLE_INTERVAL = Duration.millis(250);

/**
 * `GET /api/activity/stream`: the org's running jobs as server-sent
 * `activity` events, each a full list, sent when it changes. Read from the
 * dispatcher's memory, so it never touches the database.
 */
export const activityStreamRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const auth = yield* Auth;
		const dispatcher = yield* Dispatcher;

		const events = (organizationId: string): Stream.Stream<ActivityEvent> =>
			Stream.tick(SAMPLE_INTERVAL).pipe(
				Stream.mapEffect(() => dispatcher.running(organizationId)),
				Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
				Stream.mapEffect((jobs) =>
					Clock.currentTimeMillis.pipe(
						Effect.map((serverTime): ActivityEvent => ({ type: "activity", jobs, serverTime })),
					),
				),
			);

		yield* router.add("GET", "/api/activity/stream", orgEventStream(auth, events));
	}),
);
