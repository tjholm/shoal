import type { BackendDialect } from "@shoal/client-core/inference";
import type { Availability, SettingsInput } from "@shoal/client-core/settings";
import type { FinishedJob, RunningJob } from "@shoal/client-core/worker";
import type { WorkerModel } from "@shoal/protocol";
import type { RPCSchema } from "electrobun";

export type { Availability, SettingsInput } from "@shoal/client-core/settings";
export type { FinishedJob, JobTask, RunningJob } from "@shoal/client-core/worker";

export type WorkerStatus =
	| "not-configured"
	| "connecting"
	| "online"
	| "reconnecting"
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
	/** Why the worker is reconnecting or stopped. */
	readonly detail: string | null;
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

export type ShoalRPC = {
	bun: RPCSchema<{
		requests: {
			getState: { params: void; response: WorkerState };
			getSettings: { params: void; response: SettingsView | null };
			saveSettings: { params: SettingsForm; response: SaveResult };
			setAvailability: { params: Availability; response: void };
			/** Probes the ports local model servers usually listen on. */
			detectBackends: { params: void; response: ReadonlyArray<BackendState> };
			/** Resolves to an error message when something couldn't be unloaded. */
			unloadModel: { params: LoadedModel; response: string | null };
		};
	}>;
	webview: RPCSchema<{
		messages: {
			stateChanged: WorkerState;
		};
	}>;
};
