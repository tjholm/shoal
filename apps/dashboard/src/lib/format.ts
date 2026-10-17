/** Every digit, with thousands separators. */
export function formatCount(n: number): string {
	return n.toLocaleString("en-US");
}

/** A short count for tight spaces: 950, 12.3K, 4.49M, 1.2B. */
export function formatNumber(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
	if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** How long a request took: 7.4s, 41s, 2m 05s. */
export function formatRequestTime(ms: number | null): string {
	if (ms == null) return "—";
	if (ms < 60_000) {
		const seconds = ms / 1000;
		return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	}
	const seconds = Math.round(ms / 1000);
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Tokens per second: one decimal below 100, whole above. */
export function formatRate(tokensPerSecond: number): string {
	return tokensPerSecond >= 100 ? String(Math.round(tokensPerSecond)) : tokensPerSecond.toFixed(1);
}

/** A worker's name, or the start of its id when it has none. */
export function workerLabel(workerId: string, name: string | null): string {
	return name?.trim() || workerId.slice(0, 8);
}
