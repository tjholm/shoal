import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	live: new Map<string, { ws: object; missedPings: number; lastPong: number }>(),
	rejected: [] as string[],
	removed: [] as string[],
}));

vi.mock("@shoal/protocol", () => ({
	parseIncoming: (_schema: unknown, text: string) => JSON.parse(text),
	WorkerMessage: {},
}));
vi.mock("@shoal/server-core/auth", () => ({
	UnauthorizedError: class extends Error {},
	verifyKey: vi.fn(),
}));
vi.mock("@shoal/server-core/dispatch", () => ({
	handleJobMessage: vi.fn(),
	rejectWorkerJobs: (id: string) => state.rejected.push(id),
}));
vi.mock("@shoal/server-core/workers", () => ({
	allWorkersUnscoped: () => [...state.live.values()],
	getWorker: (id: string) => state.live.get(id),
	registerNew: vi.fn(),
	registerResume: async ({ workerId, ws }: { workerId: string; ws: object }) => {
		const worker = { ws, missedPings: 0, lastPong: 0 };
		state.live.set(workerId, worker);
		return { workerId, state: worker };
	},
	removeWorker: (id: string) => {
		state.removed.push(id);
		state.live.delete(id);
	},
	updateWorkerModels: vi.fn(),
	updateWorkerStats: vi.fn(),
	WorkerAlreadyConnectedError: class extends Error {},
	WorkerAuthError: class extends Error {},
}));

import { workerHooks } from "./worker-ws";

type Peer = {
	context: { organizationId: string; keyId: string };
	send: (data: string) => void;
	close: (code?: number, reason?: string) => void;
};
const hooks = workerHooks as unknown as {
	message: (peer: Peer, message: { text: () => string }) => Promise<void>;
	close: (peer: Peer) => void;
};
function peer(): Peer {
	return {
		context: { organizationId: "org", keyId: "key" },
		send: vi.fn(),
		close: vi.fn(),
	};
}

async function resume(p: Peer) {
	await hooks.message(p, {
		text: () =>
			JSON.stringify({
				type: "register_resume",
				workerId: "worker",
				secret: "secret",
				maxConcurrent: 1,
			}),
	});
}

describe("worker websocket session ownership", () => {
	beforeEach(() => {
		state.live.clear();
		state.rejected.length = 0;
		state.removed.length = 0;
	});

	it("ignores the old peer's late close and pong after a replacement connects", async () => {
		const oldPeer = peer();
		await resume(oldPeer);
		const oldState = state.live.get("worker")!;
		state.live.delete("worker"); // heartbeat eviction before the close event

		const newPeer = peer();
		await resume(newPeer);
		const newState = state.live.get("worker")!;
		expect(newState.ws).not.toBe(oldState.ws);

		newState.missedPings = 2;
		hooks.close(oldPeer);
		await hooks.message(oldPeer, {
			text: () => JSON.stringify({ type: "pong" }),
		});

		expect(state.live.get("worker")).toBe(newState);
		expect(newState.missedPings).toBe(2);
		expect(state.rejected).toEqual([]);
		expect(state.removed).toEqual([]);

		hooks.close(newPeer);
		expect(state.live.has("worker")).toBe(false);
		expect(state.rejected).toEqual(["worker"]);
		expect(state.removed).toEqual(["worker"]);
	});
});
