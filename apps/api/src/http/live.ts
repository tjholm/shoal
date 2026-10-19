import type { LiveEvent } from "@shoal/contracts";
import { Effect, Layer, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { Auth } from "../auth";
import { workerEvents } from "../workers/stream";
import { activityEvents } from "./activity";
import { orgEventStream } from "./org-events";

/**
 * `GET /api/live`: the org's live feeds (workers and running jobs) as
 * server-sent events, on one connection. Browsers allow only six connections
 * per host over plain HTTP, so a dashboard tab must hold no more than one.
 * Each feed starts with a snapshot, on every connect.
 */
export const liveRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const auth = yield* Auth;
		const workers = yield* workerEvents;
		const activity = yield* activityEvents;

		const events = (organizationId: string): Stream.Stream<LiveEvent> =>
			Stream.merge(
				workers(organizationId).pipe(
					Stream.map((event) => ({ type: "workers" as const, event })),
				),
				activity(organizationId).pipe(
					Stream.map((event) => ({ type: "activity" as const, event })),
				),
			);

		yield* router.add("GET", "/api/live", orgEventStream(auth, events));
	}),
);
