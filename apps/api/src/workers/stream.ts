import type { WorkerInfo, WorkerStreamEvent } from "@shoal/contracts";
import { Clock, Effect, Layer, Option, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Auth } from "../auth";
import { formatEvent, sseResponse } from "../http/sse";
import { Usage } from "../usage";
import { type WorkerChange, WorkerRegistry } from "./registry";
import { liveFields, snapshotWorkers } from "./views";

/**
 * `GET /api/workers/stream`: the org's workers as server-sent events. A
 * `snapshot` event seeds the client, then `upsert`/`delete` events follow
 * every change. Live-state changes are merged into the last record sent, so
 * usage totals only refresh on a snapshot or when a worker first appears —
 * live updates never touch the database.
 */
export const workerStreamRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const auth = yield* Auth;
		const registry = yield* WorkerRegistry;
		const context = yield* Effect.context<WorkerRegistry | Usage>();

		const events = (organizationId: string): Stream.Stream<WorkerStreamEvent> =>
			Stream.unwrap(
				Effect.gen(function* () {
					// Records last sent on this connection, so each event can carry a
					// complete WorkerInfo without a database round trip.
					const sent = new Map<string, WorkerInfo>();
					const remember = (worker: WorkerInfo): WorkerStreamEvent => {
						sent.set(worker.workerId, worker);
						return { type: "upsert", worker };
					};

					const freshRecord = (workerId: string) =>
						snapshotWorkers(organizationId).pipe(
							Effect.map((all) => all.find((w) => w.workerId === workerId)),
							Effect.map((worker) => (worker ? [remember(worker)] : [])),
							Effect.catch((err) =>
								Effect.logError("worker stream: snapshot of one worker failed", err).pipe(
									Effect.as([]),
								),
							),
						);

					const onChange = (
						change: WorkerChange,
					): Effect.Effect<
						ReadonlyArray<WorkerStreamEvent>,
						never,
						WorkerRegistry | Usage
					> =>
						Effect.gen(function* () {
							if (change.type === "deleted") {
								sent.delete(change.workerId);
								return [{ type: "delete", workerId: change.workerId }];
							}
							const previous = sent.get(change.workerId);
							if (!previous) return yield* freshRecord(change.workerId);
							if (change.type === "name") {
								return [remember({ ...previous, name: change.name })];
							}
							const live = yield* registry.get(change.workerId);
							const now = yield* Clock.currentTimeMillis;
							return [
								remember({
									...previous,
									...liveFields(live, now),
									maxConcurrent: Option.isSome(live)
										? live.value.maxConcurrent
										: previous.maxConcurrent,
									lastSeenAt: Option.isSome(live) ? now : previous.lastSeenAt,
								}),
							];
						});

					// Subscribe before taking the snapshot so no change falls between.
					const changes = yield* registry.subscribe(organizationId);
					const snapshot = yield* snapshotWorkers(organizationId).pipe(Effect.orDie);
					for (const worker of snapshot) sent.set(worker.workerId, worker);

					return Stream.concat(
						Stream.succeed<WorkerStreamEvent>({ type: "snapshot", workers: snapshot }),
						changes.pipe(
							Stream.mapEffect(onChange),
							Stream.flatMap((batch) => Stream.fromIterable(batch)),
						),
					);
				}),
			).pipe(Stream.provideContext(context));

		yield* router.add(
			"GET",
			"/api/workers/stream",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const session = yield* auth.getSession(new Headers(request.headers));
				if (Option.isNone(session)) {
					return HttpServerResponse.text("unauthorized", { status: 401 });
				}
				const organizationId = session.value.activeOrganizationId;
				if (organizationId === null) {
					return HttpServerResponse.text("no active organization", { status: 400 });
				}
				return sseResponse(
					events(organizationId).pipe(
						Stream.map((event) => formatEvent({ event: event.type, data: event })),
					),
				);
			}),
		);
	}),
);
