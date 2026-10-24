import type { WorkerConnection } from "@shoal/client-core/worker";

export interface LocalNetworkHandlers {
	/** `blocked` changed, or a check finished. */
	readonly onChange: () => void;
	/** The person allowed access; the worker should connect now. */
	readonly onAllowed: () => void;
}

/** Whether the OS is keeping Shoal off the local network the server is on. */
export interface LocalNetworkWatch {
	readonly blocked: boolean;
	/** Checks for a block whenever the server stops answering. */
	readonly observe: (connection: WorkerConnection, serverUrl: string) => void;
	/** Forgets any block, for a new worker or server. */
	readonly reset: () => void;
	/** Opens the system settings where the person allows access. */
	readonly openSettings: () => void;
}
