import { parseIncoming, WorkerMessage } from "@shoal/protocol";
import { UnauthorizedError, verifyKey } from "@shoal/server-core/auth";
import {
	handleJobMessage,
	rejectWorkerJobs,
} from "@shoal/server-core/dispatch";
import {
	allWorkersUnscoped,
	getWorker,
	registerNew,
	registerResume,
	removeWorker,
	updateWorkerModels,
	updateWorkerStats,
	WorkerAlreadyConnectedError,
	WorkerAuthError,
} from "@shoal/server-core/workers";
import type { Hooks } from "crossws";

const PING_INTERVAL_MS = 10_000;
const MAX_MISSED_PINGS = 3;

const peerWorkerIds = new WeakMap<object, string>();

let heartbeatStarted = false;
function ensureHeartbeat() {
	if (heartbeatStarted) return;
	heartbeatStarted = true;

	setInterval(() => {
		for (const w of allWorkersUnscoped()) {
			if (w.missedPings >= MAX_MISSED_PINGS) {
				console.log(
					`[server] evicting worker ${w.workerId} (missed ${w.missedPings} pings)`,
				);
				rejectWorkerJobs(w.workerId);
				try {
					w.ws.close(1001, "ping timeout");
				} catch {
					/* already closed */
				}
				removeWorker(w.workerId);
				continue;
			}
			w.missedPings++;
			try {
				w.ws.send(JSON.stringify({ type: "ping" }));
			} catch {
				/* next cycle */
			}
		}
	}, PING_INTERVAL_MS);
}

export const workerHooks: Partial<Hooks> = {
	// Always accept the upgrade — auth result is stashed on peer.context and
	// enforced in `open` below. Returning a non-101 response here would crash
	// portless's httpxy proxy in dev (it can't relay one over an upgrade
	// attempt). Sending a clean close frame post-upgrade goes through the
	// proxy as normal WS traffic.
	async upgrade(request) {
		const url = new URL(request.url);
		const token = url.searchParams.get("token");
		if (!token) return { context: { authFailed: true } };
		try {
			const result = await verifyKey(token);
			return {
				context: {
					organizationId: result.organizationId,
					keyId: result.keyId,
				},
			};
		} catch (err) {
			if (err instanceof UnauthorizedError) {
				return { context: { authFailed: true } };
			}
			throw err;
		}
	},

	open(peer) {
		if (peer.context?.authFailed) {
			peer.close(1008, "invalid api key");
			return;
		}
		ensureHeartbeat();
	},

	async message(peer, message) {
		const msg = parseIncoming(WorkerMessage, message.text());
		if (!msg) return;

		if (msg.type === "register_new" || msg.type === "register_resume") {
			const organizationId = peer.context?.organizationId;
			if (typeof organizationId !== "string") {
				// Should be impossible — upgrade hook always sets this on success.
				peer.close(1008, "missing org context");
				return;
			}
			const ctxKeyId = peer.context?.keyId;
			const keyId = typeof ctxKeyId === "string" ? ctxKeyId : null;

			const ws = {
				send: (data: string) => peer.send(data),
				close: (code?: number, reason?: string) => peer.close(code, reason),
			};

			try {
				if (msg.type === "register_new") {
					const result = await registerNew({
						organizationId,
						keyId,
						ws,
						maxConcurrent: msg.maxConcurrent,
						name: msg.name,
					});
					peerWorkerIds.set(peer, result.workerId);
					peer.send(
						JSON.stringify({
							type: "registered",
							workerId: result.workerId,
							secret: result.secret,
						}),
					);
					console.log(
						`[server] worker registered (new): ${result.workerId} (org ${organizationId})`,
					);
				} else {
					const result = await registerResume({
						workerId: msg.workerId,
						secret: msg.secret,
						organizationId,
						keyId,
						ws,
						maxConcurrent: msg.maxConcurrent,
						name: msg.name,
					});
					peerWorkerIds.set(peer, result.workerId);
					peer.send(
						JSON.stringify({ type: "registered", workerId: result.workerId }),
					);
					console.log(
						`[server] worker registered (resume): ${result.workerId} (org ${organizationId})`,
					);
				}
			} catch (err) {
				if (err instanceof WorkerAuthError) {
					peer.close(1008, "invalid worker credentials");
					return;
				}
				if (err instanceof WorkerAlreadyConnectedError) {
					peer.close(1008, "worker already connected");
					return;
				}
				console.error("[server] worker register failed:", err);
				peer.close(1011, "register failed");
			}
			return;
		}

		const workerId = peerWorkerIds.get(peer);
		if (!workerId) {
			// Peer hasn't registered yet — drop any other message type.
			return;
		}

		if (msg.type === "pong") {
			const w = getWorker(workerId);
			if (w) {
				w.missedPings = 0;
				w.lastPong = Date.now();
			}
			return;
		}

		if (msg.type === "stats") {
			updateWorkerStats(workerId, msg);
			return;
		}

		if (msg.type === "models") {
			updateWorkerModels(workerId, msg.models);
			return;
		}

		handleJobMessage(msg, workerId);
	},

	close(peer) {
		const workerId = peerWorkerIds.get(peer);
		if (workerId) {
			console.log(`[server] worker disconnected: ${workerId}`);
			rejectWorkerJobs(workerId);
			removeWorker(workerId);
		}
	},
};
