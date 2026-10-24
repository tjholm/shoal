import type { HostRequests, WorkerState } from "@shoal/client-core/host/api";
import { createContext, useContext } from "react";

/** One function per request the UI can make of its host. */
export type HostClient = {
	readonly [K in keyof HostRequests]: (params: HostRequests[K]["params"]) => Promise<HostRequests[K]["response"]>;
};

/** How the UI reaches the host running its worker: Electrobun RPC in the desktop app, HTTP from the CLI. */
export interface HostConnection {
	readonly request: HostClient;
	/** Calls `listener` with each new state; returns a function that stops it. */
	readonly onStateChanged: (listener: (state: WorkerState) => void) => () => void;
}

const HostContext = createContext<HostConnection | null>(null);

export const HostProvider = HostContext.Provider;

export const useHost = (): HostConnection => {
	const host = useContext(HostContext);
	if (host === null) throw new Error("useHost needs a HostProvider above it.");
	return host;
};
