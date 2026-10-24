/**
 * What a client's UI sees of the host running its worker, and the requests it
 * can make. Types only, plus pure helpers, so a browser bundle can import it.
 */
import type { BackendDialect } from "../inference";
import type { Availability, SettingsInput } from "../settings";
import type { FinishedJob, RunningJob } from "../worker/run";
import type { WorkerModel } from "@shoal/protocol";

export type { Availability, SettingsInput } from "../settings";
export type { FinishedJob, JobTask, RunningJob } from "../worker/run";

export type WorkerStatus =
	| "not-configured"
	| "connecting"
	| "online"
	| "reconnecting"
	/** Gave up reconnecting; waits for the person to try again. */
	| "failed"
	/** macOS is blocking Shoal from the server on the local network; reconnects once the person allows it. */
	| "blocked"
	| "paused"
	| "off"
	/** Stopped for good, e.g. the server rejected the API key. */
	| "stopped";

export interface BackendState {
	readonly url: string;
	/** Null until the backend has answered a probe. */
	readonly dialect: BackendDialect | null;
	/** False for servers that keep one model loaded, like vLLM. */
	readonly canUnload: boolean;
	readonly models: ReadonlyArray<WorkerModel>;
	readonly loaded: ReadonlyArray<string>;
	readonly error: string | null;
}

export interface WorkerState {
	readonly status: WorkerStatus;
	/** Why the worker is reconnecting, failed or stopped, as a sentence naming the server. */
	readonly detail: string | null;
	/** When a reconnecting worker tries next, epoch ms. */
	readonly retryAt: number | null;
	/** Which reconnect attempt starts at `retryAt`, from 1, while reconnecting. */
	readonly attempt: number | null;
	/** Reconnect attempts before the worker gives up and waits for "Try again"; null when it never gives up. */
	readonly maxAttempts: number | null;
	readonly availability: Availability;
	readonly serverUrl: string | null;
	/** Empty keeps whatever name the server has stored. */
	readonly name: string;
	/** Set once the server has accepted this worker. */
	readonly workerId: string | null;
	/** When the server accepted the current connection, epoch ms. */
	readonly onlineSince: number | null;
	readonly concurrency: number;
	readonly jobs: ReadonlyArray<RunningJob>;
	readonly recent: ReadonlyArray<FinishedJob>;
	readonly jobsCompleted: number;
	readonly tokensOut: number;
	/** In configured order; jobs go to the first backend with the model. */
	readonly backends: ReadonlyArray<BackendState>;
}

/** Settings as the window sees them. The token never leaves the main process. */
export interface SettingsView {
	readonly serverUrl: string;
	readonly hasToken: boolean;
	readonly backends: ReadonlyArray<string>;
	readonly name: string;
	readonly concurrency: number;
	readonly launchAtLogin: boolean;
}

export interface SettingsForm extends SettingsInput {
	readonly launchAtLogin: boolean;
}

export type SaveResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly errors: ReadonlyArray<string> };

export interface LoadedModel {
	readonly backend: string;
	readonly id: string;
}

export const isPaused = (a: Availability): a is { readonly pausedUntil: number } => typeof a === "object";

/** The requests a client's UI makes of its host, by name. A type, not an interface, so RPC libraries can index it. */
export type HostRequests = {
	getState: { params: void; response: WorkerState };
	getSettings: { params: void; response: SettingsView | null };
	saveSettings: { params: SettingsForm; response: SaveResult };
	setAvailability: { params: Availability; response: void };
	/** Connects now, skipping any backoff. */
	retryConnection: { params: void; response: void };
	openLocalNetworkSettings: { params: void; response: void };
	/** Probes the ports local model servers usually listen on. */
	detectBackends: { params: void; response: ReadonlyArray<BackendState> };
	/** Resolves to an error message when something couldn't be unloaded. */
	unloadModel: { params: LoadedModel; response: string | null };
};

/** A host's implementation of each request. */
export type HostHandlers = {
	readonly [K in keyof HostRequests]: (
		params: HostRequests[K]["params"],
	) => HostRequests[K]["response"] | Promise<HostRequests[K]["response"]>;
};
