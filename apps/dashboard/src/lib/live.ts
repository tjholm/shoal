import { LiveEvent } from "@shoal/contracts";
import { Schema } from "effect";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(LiveEvent));

/** How long a hidden tab keeps its connection, so a quick look at another tab
 *  doesn't drop and reload the live data. */
const HIDDEN_GRACE_MS = 10_000;

type Feed = LiveEvent["type"];
type FeedEvent<F extends Feed> = Extract<LiveEvent, { type: F }>["event"];

export interface LiveFeed {
	/** Calls `listener` with `feed`'s events, starting with a snapshot. Returns
	 *  a function that stops; the connection closes with the last listener. */
	subscribe<F extends Feed>(feed: F, listener: (event: FeedEvent<F>) => void): () => void;
}

/**
 * One `/api/live` connection, shared by a session's live collections. Over
 * plain HTTP a browser allows only six connections per host, and every tab
 * shares them, so a tab holds at most one, and lets it go while hidden. The
 * server resends every feed's snapshot on each connect, so reconnecting loses
 * nothing.
 */
export function createLiveFeed(): LiveFeed {
	const listeners = new Set<(event: LiveEvent) => void>();
	let source: EventSource | null = null;
	let closing: ReturnType<typeof setTimeout> | undefined;

	const dispatch = (raw: MessageEvent<string>) => {
		const event = decode(raw.data);
		for (const listener of listeners) listener(event);
	};
	const connect = () => {
		clearTimeout(closing);
		closing = undefined;
		if (source || document.hidden) return;
		source = new EventSource("/api/live");
		source.addEventListener("workers", dispatch);
		source.addEventListener("activity", dispatch);
	};
	const disconnect = () => {
		clearTimeout(closing);
		closing = undefined;
		source?.close();
		source = null;
	};
	const onVisibilityChange = () => {
		if (!document.hidden) connect();
		else if (source && !closing) closing = setTimeout(disconnect, HIDDEN_GRACE_MS);
	};

	return {
		subscribe(feed, listener) {
			const forward = (event: LiveEvent) => {
				if (event.type === feed) listener(event.event as FeedEvent<typeof feed>);
			};
			listeners.add(forward);
			if (listeners.size === 1) document.addEventListener("visibilitychange", onVisibilityChange);
			// A listener that joins late needs its feed's snapshot, which only
			// comes on connect.
			disconnect();
			connect();
			return () => {
				listeners.delete(forward);
				if (listeners.size > 0) return;
				document.removeEventListener("visibilitychange", onVisibilityChange);
				disconnect();
			};
		},
	};
}
