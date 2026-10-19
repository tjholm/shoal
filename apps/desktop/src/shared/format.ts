import type { Availability, WorkerState } from "./rpc";

/** "31s", "4m 12s", "2h 14m". */
export const elapsed = (ms: number) => {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** "1:42 PM". */
export const clock = (epochMs: number) =>
	new Date(epochMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "41.2 tok/s", or null before a second has passed. */
export const rate = (tokens: number, ms: number) =>
	ms < 1000 ? null : `${(tokens / (ms / 1000)).toFixed(1)} tok/s`;

export const isPaused = (a: Availability): a is { readonly pausedUntil: number } =>
	typeof a === "object";

/** The one-line status the tray and window lead with. */
export const statusLabel = (state: WorkerState) => {
	switch (state.status) {
		case "off":
			return "Not accepting work";
		case "paused":
			return isPaused(state.availability) ? `Paused until ${clock(state.availability.pausedUntil)}` : "Paused";
		case "not-configured":
			return "Not set up";
		case "connecting":
			return "Connecting…";
		case "reconnecting":
			return "Reconnecting…";
		case "stopped":
			return "Stopped";
		case "online":
			return state.jobs.length === 0
				? "Online"
				: `Online · ${state.jobs.length} job${state.jobs.length === 1 ? "" : "s"}`;
	}
};
