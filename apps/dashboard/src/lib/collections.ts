import {
	type ActiveJob,
	ActivityEvent,
	type WorkerInfo,
	WorkerStreamEvent,
} from "@shoal/contracts";
import { createCollection } from "@tanstack/react-db";
import { getRouteApi } from "@tanstack/react-router";
import { Schema } from "effect";
import { api } from "./api";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(WorkerStreamEvent));
const decodeActivity = Schema.decodeUnknownSync(Schema.fromJsonString(ActivityEvent));

/**
 * Live collection of workers for the active organization. Hydrates from the
 * `/api/workers/stream` SSE endpoint: an initial `snapshot` event seeds the
 * collection, then `upsert`/`delete` events drive incremental updates from
 * the worker registry (connect, disconnect, stats, models, rename).
 *
 * Mutations are optimistic — `update`/`delete` apply locally and roll back if
 * the server call fails.
 */
const createWorkersCollection = (session: string) =>
	createCollection<WorkerInfo>({
		id: `workers-${session}`,
		getKey: (w) => w.workerId,
		sync: {
			rowUpdateMode: "full",
			sync: ({ begin, write, commit, markReady, truncate }) => {
				const source = new EventSource("/api/workers/stream");

				const apply = (raw: MessageEvent) => {
					const event = decodeEvent(raw.data);
					begin();
					switch (event.type) {
						case "snapshot":
							// Sent again on every reconnect, so it replaces what's there.
							truncate();
							for (const w of event.workers) write({ type: "insert", value: w });
							break;
						case "upsert":
							write({ type: "update", value: event.worker });
							break;
						case "delete":
							write({ type: "delete", key: event.workerId });
							break;
					}
					commit();
					if (event.type === "snapshot") markReady();
				};

				source.addEventListener("snapshot", apply);
				source.addEventListener("upsert", apply);
				source.addEventListener("delete", apply);
				// EventSource reconnects on its own; the server resends a snapshot.
				return () => source.close();
			},
		},
		onUpdate: async ({ transaction }) => {
			const mutation = transaction.mutations[0];
			if (!mutation) return;
			const { workerId, name } = mutation.modified;
			await api((c) => c.workers.rename({ params: { workerId }, payload: { name } }));
		},
		onDelete: async ({ transaction }) => {
			const mutation = transaction.mutations[0];
			if (!mutation) return;
			await api((c) => c.workers.remove({ params: { workerId: String(mutation.key) } }));
		},
	});

/** A job's output so far: exact once it has finished, streamed chunks before. */
export const jobTokens = (job: ActiveJob): number => job.completionTokens ?? job.outputChunks;

/**
 * Live collection of the active organization's running jobs, from the
 * `/api/activity/stream` SSE endpoint: a `snapshot` seeds it, then
 * `upsert`/`delete` events follow the dispatcher. A finished job stays until
 * its usage is recorded, so once it's deleted a usage refetch includes it.
 */
const createActiveJobsCollection = (session: string) => {
	let serverClockOffset = 0;
	return createCollection<ActiveJob>({
		id: `active-jobs-${session}`,
		getKey: (job) => job.jobId,
		utils: {
			/** Add to `Date.now()` for the server's clock, which stamps `startedAt`. */
			serverClockOffset: () => serverClockOffset,
		},
		sync: {
			rowUpdateMode: "full",
			sync: ({ begin, write, commit, markReady, truncate }) => {
				const source = new EventSource("/api/activity/stream");

				const apply = (raw: MessageEvent) => {
					const event = decodeActivity(raw.data);
					begin();
					switch (event.type) {
						case "snapshot":
							// Sent again on every reconnect, so it replaces what's there.
							serverClockOffset = event.serverTime - Date.now();
							truncate();
							for (const job of event.jobs) write({ type: "insert", value: job });
							break;
						case "upsert":
							write({ type: "update", value: event.job });
							break;
						case "delete":
							write({ type: "delete", key: event.jobId });
							break;
					}
					commit();
					if (event.type === "snapshot") markReady();
				};

				source.addEventListener("snapshot", apply);
				source.addEventListener("upsert", apply);
				source.addEventListener("delete", apply);
				// EventSource reconnects on its own; the server resends a snapshot.
				return () => source.close();
			},
		},
	});
};

const createSessionCollections = (session: string) => ({
	workers: createWorkersCollection(session),
	activeJobs: createActiveJobsCollection(session),
});

export type SessionCollections = ReturnType<typeof createSessionCollections>;

const sessions = new Map<string, SessionCollections>();

/**
 * The live collections for a signed-in user's active org, keyed
 * `userId/orgId`. The server reads both once per stream, so each session gets
 * its own instances rather than reusing another's connections.
 */
export function collectionsFor(session: string): SessionCollections {
	let collections = sessions.get(session);
	if (!collections) {
		collections = createSessionCollections(session);
		sessions.set(session, collections);
	}
	return collections;
}

/**
 * Close every session's collections except `keep` (all of them when null).
 * Run it once nothing renders the old ones: cleaning up a collection under a
 * mounted live query leaves that query in a terminal error state.
 */
export function evictCollectionsExcept(keep: SessionCollections | null) {
	for (const [session, collections] of sessions) {
		if (collections === keep) continue;
		sessions.delete(session);
		for (const collection of Object.values(collections)) void collection.cleanup();
	}
}

const authedRoute = getRouteApi("/_authed");

/** The active session's live collections, from the `_authed` route context. */
export const useCollections = (): SessionCollections => authedRoute.useRouteContext().collections;
