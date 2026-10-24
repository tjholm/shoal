import type { WorkerState } from "@shoal/client-core/host/api";
import type { HostClient, HostConnection } from "../src/host";

const post = (path: string, body: unknown) =>
	fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? null),
	});

/** Swaps the access token for a session cookie; false when the token is wrong. */
export const signIn = async (token: string) => (await post("/api/login", { token })).ok;

export const isSignedIn = async () => (await fetch("/api/session")).ok;

/** The CLI's host over HTTP. Calls `onSignedOut` when the server stops accepting this session. */
export const httpHost = (onSignedOut: () => void): HostConnection => {
	const request = new Proxy({} as HostClient, {
		get:
			(_target, name: string) =>
			async (params: unknown) => {
				const response = await post(`/api/request/${name}`, params);
				if (response.status === 401) onSignedOut();
				if (!response.ok) throw new Error(`${name} failed: ${response.status} ${await response.text()}`);
				return response.json();
			},
	});

	const listeners = new Set<(state: WorkerState) => void>();
	let events: EventSource | null = null;
	const listen = () => {
		events = new EventSource("/api/state");
		events.onmessage = (event) => {
			const state = JSON.parse(event.data) as WorkerState;
			for (const listener of listeners) listener(state);
		};
		// EventSource retries on its own, but can't say why it failed; a lost session won't come back.
		events.onerror = () => {
			void isSignedIn().then((signedIn) => {
				if (!signedIn) {
					events?.close();
					onSignedOut();
				}
			});
		};
	};

	return {
		request,
		onStateChanged: (listener) => {
			listeners.add(listener);
			if (events === null) listen();
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					events?.close();
					events = null;
				}
			};
		},
	};
};
