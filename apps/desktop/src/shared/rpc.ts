import type { SettingsInput } from "@shoal/client-core/settings";
import type { RPCSchema } from "electrobun";

export type WorkerStatus =
	| "not-configured"
	| "connecting"
	| "sharing"
	| "reconnecting"
	| "pausing"
	| "paused"
	/** Stopped for good, e.g. the server rejected the API key. */
	| "stopped";

export interface LoadedModel {
	readonly backend: string;
	readonly id: string;
}

export interface BackendState {
	readonly url: string;
	readonly reachable: boolean;
	/** False for servers that keep one model loaded, like vLLM. */
	readonly canUnload: boolean;
	readonly loaded: ReadonlyArray<string>;
	readonly error: string | null;
}

export interface WorkerState {
	readonly status: WorkerStatus;
	/** Why the worker is reconnecting or stopped. */
	readonly detail: string | null;
	readonly serverUrl: string | null;
	readonly jobsRunning: number;
	readonly backends: ReadonlyArray<BackendState>;
}

/** Settings as the window sees them. The token never leaves the main process. */
export interface SettingsView {
	readonly serverUrl: string;
	readonly hasToken: boolean;
	readonly backends: ReadonlyArray<string>;
}

export type { SettingsInput } from "@shoal/client-core/settings";

export type SaveResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly errors: ReadonlyArray<string> };

export type Tab = "status" | "settings";

export type ShoalRPC = {
	bun: RPCSchema<{
		requests: {
			getState: { params: void; response: WorkerState };
			getSettings: { params: void; response: SettingsView | null };
			saveSettings: { params: SettingsInput; response: SaveResult };
			setPaused: { params: { paused: boolean }; response: void };
			/** Resolves to an error message when something couldn't be unloaded. */
			freeMemory: { params: void; response: string | null };
			unloadModel: { params: LoadedModel; response: string | null };
			openWebDashboard: { params: void; response: void };
			takeRequestedTab: { params: void; response: Tab };
		};
	}>;
	webview: RPCSchema<{
		messages: {
			stateChanged: WorkerState;
			showTab: Tab;
		};
	}>;
};
