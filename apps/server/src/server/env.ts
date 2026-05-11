function parsePositiveInt(
	name: string,
	value: string | undefined,
	fallback: number,
): number {
	if (value === undefined || value === "") return fallback;
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`${name} must be a positive integer, got: ${value}`);
	}
	return n;
}

export const SCHEDULER_ENABLED =
	process.env.SHOAL_SCHEDULER_ENABLED !== "false";

export const USAGE_RETENTION_DAYS = parsePositiveInt(
	"SHOAL_USAGE_RETENTION_DAYS",
	process.env.SHOAL_USAGE_RETENTION_DAYS,
	14,
);

export const USAGE_PRUNE_CRON =
	process.env.SHOAL_USAGE_PRUNE_CRON ?? "0 * * * *";
