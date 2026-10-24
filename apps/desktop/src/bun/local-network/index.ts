import type { LocalNetworkHandlers, LocalNetworkWatch } from "./types";

export type { LocalNetworkWatch } from "./types";

/** Only macOS gates the local network per app, so elsewhere nothing is ever blocked. */
const neverBlocked: LocalNetworkWatch = {
	blocked: false,
	observe: () => {},
	reset: () => {},
	openSettings: () => {
		throw new Error("Only macOS has Local Network settings.");
	},
};

export const watchLocalNetwork = async (handlers: LocalNetworkHandlers): Promise<LocalNetworkWatch> =>
	process.platform === "darwin" ? (await import("./darwin")).watchLocalNetwork(handlers) : neverBlocked;
