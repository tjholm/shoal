// @vitest-environment jsdom
import type { ActiveJob } from "@shoal/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	closed = false;
	private listeners = new Map<string, (event: MessageEvent<string>) => void>();
	constructor(readonly url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
		this.listeners.set(type, listener);
	}
	close() {
		this.closed = true;
	}
	emit(type: string, data: unknown) {
		this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
	}
}

const job = (overrides: Partial<ActiveJob>): ActiveJob => ({
	jobId: "a",
	workerId: "w",
	model: "gemma",
	startedAt: 0,
	outputChunks: 0,
	completionTokens: null,
	...overrides,
});

const snapshot = (jobs: ActiveJob[]) => ({ type: "snapshot", jobs, serverTime: 0 });

const latest = () => FakeEventSource.instances.at(-1) as FakeEventSource;

// A fresh module per test, so each starts with no sessions.
let collections: typeof import("./collections");

beforeEach(async () => {
	FakeEventSource.instances = [];
	vi.stubGlobal("EventSource", FakeEventSource);
	vi.resetModules();
	collections = await import("./collections");
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const SESSION = "user/org-1";

/** Starts a session's activity stream and seeds it with `jobs`. */
const syncActivity = async (jobs: ActiveJob[], session = SESSION) => {
	const { activeJobs } = collections.collectionsFor(session);
	const ready = activeJobs.preload();
	latest().emit("snapshot", snapshot(jobs));
	await ready;
	return latest();
};

const rows = (session = SESSION) =>
	collections.collectionsFor(session).activeJobs.toArray.map((j) => [j.jobId, j.outputChunks]);

describe("activeJobs collection", () => {
	it("follows the snapshot with upserts and deletes", async () => {
		await syncActivity([job({ jobId: "a" }), job({ jobId: "b" })]);
		latest().emit("upsert", { type: "upsert", job: job({ jobId: "a", outputChunks: 7 }) });
		latest().emit("delete", { type: "delete", jobId: "b" });
		expect(rows()).toEqual([["a", 7]]);
	});

	it("replaces its rows with each reconnect's snapshot", async () => {
		await syncActivity([job({ jobId: "a" })]);
		latest().emit("snapshot", snapshot([job({ jobId: "b" })]));
		expect(rows()).toEqual([["b", 0]]);
	});
});

describe("session collections", () => {
	it("gives each user and org its own collections and stream", async () => {
		expect(collections.collectionsFor(SESSION)).toBe(collections.collectionsFor(SESSION));
		const first = await syncActivity([job({ jobId: "a" })]);
		const second = await syncActivity([job({ jobId: "b" })], "user/org-2");
		expect(second).not.toBe(first);
		expect(rows()).toEqual([["a", 0]]);
		expect(rows("user/org-2")).toEqual([["b", 0]]);
	});

	it("closes the other sessions' streams on eviction, keeping the active one", async () => {
		const old = await syncActivity([job({ jobId: "a" })]);
		const active = await syncActivity([], "user/org-2");

		collections.evictCollectionsExcept(collections.collectionsFor("user/org-2"));
		await vi.waitFor(() => expect(old.closed).toBe(true));
		expect(active.closed).toBe(false);
	});

	it("starts an evicted session afresh when it comes back", async () => {
		const evicted = collections.collectionsFor(SESSION);
		await syncActivity([job({ jobId: "a" })]);
		collections.evictCollectionsExcept(null);

		expect(collections.collectionsFor(SESSION)).not.toBe(evicted);
		await syncActivity([job({ jobId: "b" })]);
		expect(rows()).toEqual([["b", 0]]);
	});
});
