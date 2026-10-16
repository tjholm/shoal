// @vitest-environment jsdom
import type { ActiveJob } from "@shoal/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActivity } from "./activity";

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
	emit(type: string, data?: unknown) {
		act(() => this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>));
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

const activity = (jobs: ActiveJob[]) => ({ type: "activity", jobs, serverTime: 0 });

let queryClient: QueryClient;
let refetches: Array<() => void>;

beforeEach(() => {
	vi.useFakeTimers();
	FakeEventSource.instances = [];
	vi.stubGlobal("EventSource", FakeEventSource);
	queryClient = new QueryClient();
	refetches = [];
	// Each refetch returns when the test resolves it, like a slow network.
	vi.spyOn(queryClient, "invalidateQueries").mockImplementation(
		() => new Promise<void>((resolve) => refetches.push(resolve)),
	);
});

afterEach(() => {
	// Unmount every hook, so each test's feed starts from a fresh connection.
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const wrapper = ({ children }: { children: ReactNode }) =>
	createElement(QueryClientProvider, { client: queryClient }, children);

const render = (organizationId = "org") =>
	renderHook(() => useActivity(organizationId), { wrapper });

/** Lets the debounced refetch start. */
const startRefetch = () => act(() => vi.advanceTimersByTime(300));

/** Returns the oldest in-flight refetch. */
const finishRefetch = async () => {
	await act(async () => refetches.shift()?.());
};

describe("useActivity", () => {
	it("counts running jobs' streamed output, then their exact tokens once finished", () => {
		const { result } = render();
		const source = FakeEventSource.instances[0];

		source.emit("activity", activity([job({ outputChunks: 5 })]));
		expect(result.current.unrecordedOutputTokens).toBe(5);

		source.emit("activity", activity([job({ outputChunks: 5, completionTokens: 6 })]));
		expect(result.current.unrecordedOutputTokens).toBe(6);
	});

	it("holds a finished job's tokens until a usage refetch returns", async () => {
		const { result } = render();
		const source = FakeEventSource.instances[0];
		source.emit("activity", activity([job({ completionTokens: 6 })]));

		source.emit("activity", activity([]));
		expect(result.current.jobs).toEqual([]);
		expect(result.current.unrecordedOutputTokens).toBe(6);

		startRefetch();
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["usage"] });
		expect(result.current.unrecordedOutputTokens).toBe(6);

		await finishRefetch();
		expect(result.current.unrecordedOutputTokens).toBe(0);
	});

	it("keeps holding a job that finished after the refetch started", async () => {
		const { result } = render();
		const source = FakeEventSource.instances[0];
		source.emit("activity", activity([job({ jobId: "a", completionTokens: 6 })]));
		source.emit("activity", activity([]));
		startRefetch();

		source.emit("activity", activity([job({ jobId: "b", completionTokens: 4 })]));
		source.emit("activity", activity([]));
		await finishRefetch();
		expect(result.current.unrecordedOutputTokens).toBe(4);

		startRefetch();
		await finishRefetch();
		expect(result.current.unrecordedOutputTokens).toBe(0);
	});

	it("drops jobs without holding their tokens when the feed disconnects", () => {
		const { result } = render();
		const source = FakeEventSource.instances[0];
		source.emit("activity", activity([job({ outputChunks: 5 })]));

		source.emit("error");
		expect(result.current.jobs).toEqual([]);
		expect(result.current.unrecordedOutputTokens).toBe(0);
		startRefetch();
		expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
	});

	it("shares one connection per org and closes it with the last reader", () => {
		const first = render();
		const second = render();
		expect(FakeEventSource.instances).toHaveLength(1);

		first.unmount();
		expect(FakeEventSource.instances[0].closed).toBe(false);
		second.unmount();
		expect(FakeEventSource.instances[0].closed).toBe(true);
	});

	it("opens a new connection when the org changes", () => {
		const { rerender } = renderHook(({ org }) => useActivity(org), {
			wrapper,
			initialProps: { org: "one" },
		});
		rerender({ org: "two" });
		expect(FakeEventSource.instances).toHaveLength(2);
		expect(FakeEventSource.instances[0].closed).toBe(true);
	});
});
