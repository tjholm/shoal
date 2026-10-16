import { type ActiveJob, ActivityEvent } from "@shoal/contracts";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ActivityEvent));

/** Batches the usage refetch when several jobs finish close together. */
const REFETCH_DEBOUNCE_MS = 300;

export interface Activity {
	/** The org's running jobs, oldest first. */
	readonly jobs: ReadonlyArray<ActiveJob>;
	/** Add to `Date.now()` for the server's clock, which stamps `startedAt`. */
	readonly serverClockOffset: number;
	/** Output tokens not yet in the usage totals: running jobs' live counts,
	 *  plus finished jobs' until a usage refetch that includes them returns. */
	readonly unrecordedOutputTokens: number;
}

const IDLE: Activity = { jobs: [], serverClockOffset: 0, unrecordedOutputTokens: 0 };

/** A job's output so far: exact once it has finished, streamed chunks before. */
export const jobTokens = (job: ActiveJob): number => job.completionTokens ?? job.outputChunks;

interface Feed {
	subscribe(listener: () => void): () => void;
	getSnapshot(): Activity;
}

const feeds = new Map<string, Feed>();

/**
 * One `/api/activity/stream` connection per org, shared by every component
 * reading it and closed when the last one unmounts. The server keeps a
 * finished job in the feed until its usage is recorded, so when a job leaves,
 * a usage refetch is sure to include it; its tokens are held until then.
 */
function feedFor(organizationId: string, queryClient: QueryClient): Feed {
	const existing = feeds.get(organizationId);
	if (existing) return existing;

	const listeners = new Set<() => void>();
	let snapshot = IDLE;
	let source: EventSource | undefined;
	let lastTokens = new Map<string, number>();
	let finishedTokens = 0;
	let refetch: ReturnType<typeof setTimeout> | undefined;

	const publish = (jobs: ReadonlyArray<ActiveJob>, serverClockOffset: number) => {
		const live = jobs.reduce((sum, job) => sum + jobTokens(job), 0);
		snapshot = { jobs, serverClockOffset, unrecordedOutputTokens: live + finishedTokens };
		for (const listener of listeners) listener();
	};

	const scheduleRefetch = () => {
		clearTimeout(refetch);
		refetch = setTimeout(() => {
			const covered = finishedTokens;
			void queryClient.invalidateQueries({ queryKey: ["usage"] }).finally(() => {
				finishedTokens -= covered;
				publish(snapshot.jobs, snapshot.serverClockOffset);
			});
		}, REFETCH_DEBOUNCE_MS);
	};

	const onActivity = (raw: MessageEvent<string>) => {
		const event = decodeEvent(raw.data);
		const next = new Map(event.jobs.map((job) => [job.jobId, jobTokens(job)]));
		let finished = false;
		for (const [jobId, tokens] of lastTokens) {
			if (next.has(jobId)) continue;
			finished = true;
			finishedTokens += tokens;
		}
		lastTokens = next;
		publish(event.jobs, event.serverTime - Date.now());
		if (finished) scheduleRefetch();
	};

	// The jobs may still be running, so their tokens aren't held as finished.
	// EventSource reconnects on its own and the next event resends them.
	const onError = () => {
		lastTokens = new Map();
		publish([], snapshot.serverClockOffset);
	};

	const feed: Feed = {
		subscribe(listener) {
			listeners.add(listener);
			if (!source) {
				feeds.set(organizationId, feed);
				source = new EventSource("/api/activity/stream");
				source.addEventListener("activity", onActivity);
				source.addEventListener("error", onError);
			}
			return () => {
				listeners.delete(listener);
				if (listeners.size > 0) return;
				source?.close();
				source = undefined;
				clearTimeout(refetch);
				feeds.delete(organizationId);
			};
		},
		getSnapshot: () => snapshot,
	};
	feeds.set(organizationId, feed);
	return feed;
}

const noFeed: Feed = { subscribe: () => () => {}, getSnapshot: () => IDLE };

/** Live running jobs for the active org. Keyed on the org because the server
 *  reads it once per connection. */
export function useActivity(organizationId: string | undefined): Activity {
	const queryClient = useQueryClient();
	const feed = organizationId === undefined ? noFeed : feedFor(organizationId, queryClient);
	return useSyncExternalStore(feed.subscribe, feed.getSnapshot);
}
