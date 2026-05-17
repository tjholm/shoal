import { auth } from "@shoal/db/auth";
import { getWorker, subscribeWorkers } from "@shoal/server-core/workers";
import { createFileRoute } from "@tanstack/react-router";
import type { WorkerInfo } from "../../server/functions/workers";
import {
	snapshotOneWorker,
	snapshotOrgWorkers,
} from "../../server/workers-snapshot";

const encoder = new TextEncoder();

function sse(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Derive an updated WorkerInfo from the in-memory state and the last record we
 * sent on this connection. Usage totals (`totalJobs`, `totalPromptTokens`,
 * `totalCompletionTokens`) are kept from `prev` — they only refresh on the
 * initial snapshot or when a worker first appears mid-stream. That's the
 * accepted v1 tradeoff: live state updates are pure in-memory, no DB.
 */
function mergeLive(prev: WorkerInfo, now: number): WorkerInfo {
	const live = getWorker(prev.workerId);
	return {
		...prev,
		online: !!live,
		loadedModels: live?.loadedModels ?? [],
		availableModels: live?.availableModels ?? [],
		inFlight: live?.inFlight ?? 0,
		maxConcurrent: live?.maxConcurrent ?? prev.maxConcurrent,
		connectedMs: live ? now - live.connectedAt : null,
		lastSeenAt: live ? now : prev.lastSeenAt,
	};
}

export const Route = createFileRoute("/api/workers/stream")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const session = await auth.api.getSession({ headers: request.headers });
				if (!session) return new Response("unauthorized", { status: 401 });
				const orgId = session.session.activeOrganizationId;
				if (!orgId)
					return new Response("no active organization", { status: 400 });

				const stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						// Comment line keeps proxies from buffering before the first event.
						controller.enqueue(encoder.encode(":ok\n\n"));

						const initial = await snapshotOrgWorkers(orgId);
						controller.enqueue(sse("snapshot", initial));

						// Per-connection cache of the last record we've sent for each
						// worker. Lets us emit complete WorkerInfo objects on every event
						// without a DB roundtrip — incoming live deltas merge against the
						// cached row.
						const cache = new Map<string, WorkerInfo>();
						for (const w of initial) cache.set(w.workerId, w);

						const send = (event: string, data: unknown) => {
							try {
								controller.enqueue(sse(event, data));
							} catch {
								// controller closed — abort handler tears down the rest
							}
						};

						const upsertNew = async (workerId: string) => {
							try {
								const row = await snapshotOneWorker(workerId, orgId);
								if (row) {
									cache.set(workerId, row);
									send("upsert", row);
								}
							} catch (err) {
								console.error("[workers.stream] snapshotOne failed:", err);
							}
						};

						const unsubscribe = subscribeWorkers(orgId, (e) => {
							if (e.type === "deleted") {
								cache.delete(e.workerId);
								send("delete", { workerId: e.workerId });
								return;
							}
							if (e.type === "name") {
								const prev = cache.get(e.workerId);
								if (!prev) {
									void upsertNew(e.workerId);
									return;
								}
								const next = { ...prev, name: e.name };
								cache.set(e.workerId, next);
								send("upsert", next);
								return;
							}
							// "live" — in-memory change. New worker → DB fetch once.
							const prev = cache.get(e.workerId);
							if (!prev) {
								void upsertNew(e.workerId);
								return;
							}
							const next = mergeLive(prev, Date.now());
							cache.set(e.workerId, next);
							send("upsert", next);
						});

						// Heartbeat keeps the connection alive. Interval must stay below
						// Bun's default 10s socket idleTimeout — longer gaps cause Bun to
						// close the TCP socket without sending the chunked-encoding
						// terminator, which upstream proxies (e.g. Envoy) see as
						// upstream_cx_protocol_error and translate to an HTTP/2
						// RST_STREAM with INTERNAL_ERROR.
						const heartbeat = setInterval(() => {
							try {
								controller.enqueue(encoder.encode(":hb\n\n"));
							} catch {
								clearInterval(heartbeat);
							}
						}, 5_000);

						const abort = () => {
							clearInterval(heartbeat);
							unsubscribe();
							try {
								controller.close();
							} catch {
								// already closed
							}
						};
						request.signal.addEventListener("abort", abort, { once: true });
					},
				});

				return new Response(stream, {
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache, no-transform",
						connection: "keep-alive",
						"x-accel-buffering": "no",
					},
				});
			},
		},
	},
});
