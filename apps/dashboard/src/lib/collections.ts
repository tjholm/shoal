import {
	type WorkerInfo,
	WorkerStreamEvent,
} from "@shoal/contracts";
import { createCollection } from "@tanstack/react-db";
import { Schema } from "effect";
import { api } from "./api";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(WorkerStreamEvent));

/**
 * Live collection of workers for the active organization. Hydrates from the
 * `/api/workers/stream` SSE endpoint: an initial `snapshot` event seeds the
 * collection, then `upsert`/`delete` events drive incremental updates from
 * the worker registry (connect, disconnect, stats, models, rename).
 *
 * Mutations are optimistic — `update`/`delete` apply locally and roll back if
 * the server call fails.
 */
export const workersCollection = createCollection<WorkerInfo>({
	id: "workers",
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
