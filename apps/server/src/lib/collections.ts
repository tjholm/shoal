import { createCollection } from "@tanstack/react-db";
import {
	deleteWorker as deleteWorkerFn,
	renameWorker as renameWorkerFn,
	type WorkerInfo,
} from "../server/functions/workers";

/**
 * Live collection of workers for the active organization. Hydrates from the
 * `/api/workers/stream` SSE endpoint: an initial `snapshot` event seeds the
 * collection, then `upsert`/`delete` events drive incremental updates from
 * the worker bus (connect, disconnect, stats, models, rename).
 *
 * Mutations are optimistic — `update`/`delete` apply locally and roll back if
 * the server call fails.
 */
export const workersCollection = createCollection<WorkerInfo>({
	id: "workers",
	getKey: (w) => w.workerId,
	sync: {
		rowUpdateMode: "full",
		sync: ({ begin, write, commit, markReady }) => {
			// EventSource is browser-only. Sync only runs when the collection is
			// actually subscribed to, which never happens during SSR, but bail
			// defensively in case the module is touched in a non-browser context.
			if (typeof EventSource === "undefined") {
				markReady();
				return;
			}

			const es = new EventSource("/api/workers/stream");

			es.addEventListener("snapshot", (e) => {
				const items: WorkerInfo[] = JSON.parse((e as MessageEvent).data);
				begin();
				for (const w of items) write({ type: "insert", value: w });
				commit();
				markReady();
			});

			es.addEventListener("upsert", (e) => {
				const value: WorkerInfo = JSON.parse((e as MessageEvent).data);
				begin();
				write({ type: "update", value });
				commit();
			});

			es.addEventListener("delete", (e) => {
				const { workerId }: { workerId: string } = JSON.parse(
					(e as MessageEvent).data,
				);
				begin();
				write({ type: "delete", key: workerId });
				commit();
			});

			es.onerror = () => {
				// EventSource auto-reconnects; on reconnect the server resends a
				// `snapshot` event which truncates/refills the collection naturally.
			};

			return () => es.close();
		},
	},
	onUpdate: async ({ transaction }) => {
		const mutation = transaction.mutations[0];
		if (!mutation) return;
		const modified = mutation.modified as WorkerInfo;
		await renameWorkerFn({
			data: { workerId: modified.workerId, name: modified.name },
		});
	},
	onDelete: async ({ transaction }) => {
		const mutation = transaction.mutations[0];
		if (!mutation) return;
		await deleteWorkerFn({ data: { workerId: mutation.key as string } });
	},
});
