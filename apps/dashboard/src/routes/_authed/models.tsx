import type {
	ModelStats,
	ModelStatsReport,
	ModelWorkerStats,
	RequestStats,
	UsageRange,
	WorkerInfo,
} from "@shoal/contracts";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { ChevronIcon } from "../../components/icons";
import { Fact, Page, Section } from "../../components/Page";
import { Segmented } from "../../components/Segmented";
import { useCollections, useRefetchUsageWhenJobsLeave } from "../../lib/collections";
import {
	formatCount,
	formatNumber,
	formatRate,
	formatRequestTime,
	workerLabel,
} from "../../lib/format";
import { modelStatsQuery } from "../../lib/queries";

const DEFAULT_RANGE: UsageRange = "7d";
/** Fewer requests than this make a worker's figures too noisy to rank. */
const MIN_RANKED_JOBS = 10;
const LEADERBOARD_SIZE = 5;
/** Models drawn individually in the trend; the rest are summed as "other". */
const TREND_MODELS = 3;

export const Route = createFileRoute("/_authed/models")({
	loader: ({ context: { queryClient } }) =>
		queryClient.ensureQueryData(modelStatsQuery(DEFAULT_RANGE)),
	component: Models,
});

function Models() {
	const [range, setRange] = useState<UsageRange>(DEFAULT_RANGE);
	const { data: report } = useQuery(modelStatsQuery(range));
	const collections = useCollections();
	useRefetchUsageWhenJobsLeave(collections.activeJobs);
	const { data: liveWorkers } = useLiveQuery(
		(q) => q.from({ worker: collections.workers }),
		[collections.workers],
	);
	const workers = liveWorkers ?? [];
	const known = new Set(workers.flatMap((w) => w.availableModels.map((m) => m.id)));
	const available = availableModels(workers);
	const models = report?.models ?? [];

	return (
		<Page
			title="Models"
			stats={
				<>
					<Fact value={known.size}>known</Fact>
					<Fact value={available.size}>available now</Fact>
					<Fact value={report ? models.length : "—"}>used, last {range}</Fact>
				</>
			}
			controls={
				<Segmented
					label="Range"
					value={range}
					onChange={setRange}
					options={[
						{ value: "24h", label: "24h" },
						{ value: "7d", label: "7d" },
						{ value: "14d", label: "14d" },
					]}
				/>
			}
		>
			<ModelsTable models={models} loaded={report !== undefined} available={available} />
			<div className="grid gap-6 lg:grid-cols-2">
				<Leaderboard
					title="Fastest worker for each model"
					caption={`Median end-to-end tok/s, ${MIN_RANKED_JOBS}+ requests. Smaller models run faster.`}
					loaded={report !== undefined}
					entries={fastest(models)}
				/>
				<Leaderboard
					title="Slowest requests (p90)"
					caption={`90th-percentile request time, ${MIN_RANKED_JOBS}+ requests`}
					loaded={report !== undefined}
					entries={slowest(models)}
				/>
			</div>
			{report && models.length > 0 && <Trend report={report} />}
		</Page>
	);
}

/** Models a connected worker serves right now. */
function availableModels(workers: ReadonlyArray<WorkerInfo>): Set<string> {
	return new Set(
		workers.filter((w) => w.online).flatMap((w) => w.availableModels.map((m) => m.id)),
	);
}

const COLUMNS = [
	"Requests",
	"Tokens in",
	"Tokens out",
	"Avg out",
	"p50 time",
	"p90 time",
	"p50 tok/s",
	"Hit max",
	"Tool calls",
] as const;

function ModelsTable({
	models,
	loaded,
	available,
}: {
	models: ReadonlyArray<ModelStats>;
	loaded: boolean;
	available: ReadonlySet<string>;
}) {
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	const toggle = (model: string) =>
		setOpen((current) => {
			const next = new Set(current);
			if (!next.delete(model)) next.add(model);
			return next;
		});
	const busiest = models[0]?.jobs ?? 0;

	return (
		<Section title="Models" caption="Most requests first. Expand a model for each worker's figures.">
			{models.length === 0 ? (
				<p className="px-[18px] py-10 text-center text-[13px] text-silt">
					{loaded ? "No chat requests in this range." : "Loading…"}
				</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full min-w-[920px] border-collapse font-mono text-[12.5px] tabular-nums">
						<thead>
							<tr className="border-b border-line text-[10.5px] tracking-[0.08em] text-silt uppercase">
								<th scope="col" className="py-2.5 pr-3 pl-[18px] text-left font-medium">
									Model
								</th>
								{COLUMNS.map((column) => (
									<th
										key={column}
										scope="col"
										className="px-3 py-2.5 text-right font-medium whitespace-nowrap"
									>
										{column}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{models.map((m) => {
								const fastestWorkerId = fastestWorker(m)?.workerId;
								return (
									<Fragment key={m.model}>
										<tr className="border-b border-reef hover:bg-trench">
											<th scope="row" className="py-2.5 pr-3 pl-[18px] text-left font-normal">
												<button
													type="button"
													onClick={() => toggle(m.model)}
													aria-expanded={open.has(m.model)}
													className="flex items-center gap-2.5 text-left"
												>
													<ChevronIcon open={open.has(m.model)} />
													<AvailabilityRing on={available.has(m.model)} />
													<span className="whitespace-nowrap text-foam">{m.model}</span>
												</button>
											</th>
											<td className="px-3 py-2.5 text-right">
												<span className="inline-flex items-center justify-end gap-2">
													{formatCount(m.jobs)}
													<span
														aria-hidden="true"
														className="h-[5px] w-14 overflow-hidden rounded-full bg-reef"
													>
														<span
															className="block h-full bg-lumen/85"
															style={{ width: `${busiest > 0 ? (m.jobs / busiest) * 100 : 0}%` }}
														/>
													</span>
												</span>
											</td>
											<StatCells stats={m} />
										</tr>
										{open.has(m.model) &&
											m.workers.map((w) => (
												<tr key={w.workerId} className="border-b border-reef bg-trench text-mist">
													<th
														scope="row"
														className="py-2 pr-3 pl-[52px] text-left font-normal whitespace-nowrap text-foam"
													>
														{workerLabel(w.workerId, w.workerName)}
													</th>
													<td className="px-3 py-2 text-right">{formatCount(w.jobs)}</td>
													<StatCells stats={w} fastest={w.workerId === fastestWorkerId} />
												</tr>
											))}
									</Fragment>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</Section>
	);
}

/** A ring, not the overview's filled dot (which means "loaded"): filled in
 *  Lumen when a connected worker serves the model now. */
function AvailabilityRing({ on }: { on: boolean }) {
	return (
		<>
			<span
				aria-hidden="true"
				className={`size-2 shrink-0 rounded-full border-[1.5px] ${on ? "border-lumen" : "border-line-strong"}`}
			/>
			<span className="sr-only">{on ? "available now" : "not available now"}</span>
		</>
	);
}

/** Every column after Requests, for a model or one of its workers. */
function StatCells({ stats, fastest = false }: { stats: RequestStats; fastest?: boolean }) {
	const truncatedShare = stats.jobs > 0 ? stats.truncated / stats.jobs : 0;
	const cell = "px-3 py-2.5 text-right whitespace-nowrap";
	return (
		<>
			<td className={cell}>{formatNumber(stats.promptTokens)}</td>
			<td className={cell}>{formatNumber(stats.completionTokens)}</td>
			<td className={cell}>
				{stats.jobs > 0 ? formatCount(Math.round(stats.completionTokens / stats.jobs)) : "—"}
			</td>
			<td className={cell}>{formatRequestTime(stats.p50DurationMs)}</td>
			<td className={cell}>{formatRequestTime(stats.p90DurationMs)}</td>
			<td className={`${cell} ${fastest ? "text-lumen" : ""}`}>
				{stats.p50TokensPerSecond != null ? formatRate(stats.p50TokensPerSecond) : "—"}
				{fastest && <span className="sr-only"> (fastest worker)</span>}
			</td>
			<td className={cell}>
				<span
					className={`inline-block min-w-12 rounded-xs px-1.5 text-center ${TRUNCATION_PILL[truncationLevel(truncatedShare)]}`}
				>
					{formatPercent(truncatedShare)}%
				</span>
			</td>
			<td className={`${cell} text-silt`}>
				{stats.jobs > 0 ? `${formatPercent(stats.toolCalls / stats.jobs)}%` : "—"}
			</td>
		</>
	);
}

/** A model's workers with enough requests, and the figure, to rank by it. */
function ranked(
	model: ModelStats,
	pick: (worker: ModelWorkerStats) => number | null,
): Array<{ worker: ModelWorkerStats; value: number }> {
	return model.workers.flatMap((worker) => {
		const value = pick(worker);
		return worker.jobs >= MIN_RANKED_JOBS && value != null ? [{ worker, value }] : [];
	});
}

/** The model's fastest worker, when more than one is ranked to compare. */
function fastestWorker(model: ModelStats): ModelWorkerStats | undefined {
	const workers = ranked(model, (w) => w.p50TokensPerSecond);
	if (workers.length < 2) return undefined;
	return workers.reduce((best, w) => (w.value > best.value ? w : best)).worker;
}

interface LeaderboardEntry {
	key: string;
	label: string;
	value: string;
	unit: string;
	/** 0 to 1, for the bar. */
	fraction: number;
}

/** Each model's fastest ranked worker, fastest first. */
function fastest(models: ReadonlyArray<ModelStats>): LeaderboardEntry[] {
	const best = models.flatMap((m) => {
		const workers = ranked(m, (w) => w.p50TokensPerSecond);
		if (workers.length === 0) return [];
		const top = workers.reduce((a, b) => (b.value > a.value ? b : a));
		return [{ model: m.model, ...top }];
	});
	return toEntries(best, (rate) => formatRate(rate), "tok/s");
}

/** Worker and model pairs with the slowest 90th-percentile request time. */
function slowest(models: ReadonlyArray<ModelStats>): LeaderboardEntry[] {
	const pairs = models.flatMap((m) =>
		ranked(m, (w) => w.p90DurationMs).map((r) => ({ model: m.model, ...r })),
	);
	return toEntries(pairs, (ms) => formatRequestTime(ms), "");
}

/** The top entries by value, largest first, with bars relative to the top. */
function toEntries(
	rows: Array<{ model: string; worker: ModelWorkerStats; value: number }>,
	format: (value: number) => string,
	unit: string,
): LeaderboardEntry[] {
	const top = [...rows].sort((a, b) => b.value - a.value).slice(0, LEADERBOARD_SIZE);
	const max = top[0]?.value ?? 0;
	return top.map((r) => ({
		key: `${r.model}/${r.worker.workerId}`,
		label: `${r.model} on ${workerLabel(r.worker.workerId, r.worker.workerName)}`,
		value: format(r.value),
		unit,
		fraction: max > 0 ? r.value / max : 0,
	}));
}

function Leaderboard({
	title,
	caption,
	loaded,
	entries,
}: {
	title: string;
	caption: string;
	loaded: boolean;
	entries: ReadonlyArray<LeaderboardEntry>;
}) {
	return (
		<Section title={title} caption={caption}>
			{entries.length === 0 ? (
				<p className="px-[18px] py-8 text-center text-[13px] text-silt">
					{loaded ? "Not enough requests in this range to rank." : "Loading…"}
				</p>
			) : (
				<ol className="py-1.5">
					{entries.map((entry, i) => (
						<li
							key={entry.key}
							className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 px-[18px] py-2"
						>
							<span className="font-mono text-xs text-silt">{i + 1}</span>
							<span className="flex min-w-0 flex-col gap-1">
								<span className="truncate font-mono text-[13px] text-foam">{entry.label}</span>
								<span aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-reef">
									<span className="block h-full bg-lumen" style={{ width: `${entry.fraction * 100}%` }} />
								</span>
							</span>
							<span className="font-mono text-[15px] text-foam tabular-nums">
								{entry.value}
								{entry.unit && <span className="ml-1 text-[11px] text-silt">{entry.unit}</span>}
							</span>
						</li>
					))}
				</ol>
			)}
		</Section>
	);
}

const TREND_COLORS = ["var(--signal-lumen)", "var(--signal-current)", "var(--signal-amber)"];
const OTHER_COLOR = "var(--line-strong)";
const CHART = { width: 700, height: 190, left: 40, base: 160, plot: 150 };

/** Requests per bucket, stacked by model: the busiest few, then the rest. */
function Trend({ report }: { report: ModelStatsReport }) {
	const { starts, models } = report.series;
	const named = models.slice(0, TREND_MODELS);
	const rest = models.slice(TREND_MODELS);
	const layers = [
		...named.map((m, i) => ({
			// Prefixed, so a model named "other" can't collide with the rest.
			id: `model:${m.model}`,
			label: m.model,
			color: TREND_COLORS[i],
			jobs: m.jobs,
		})),
		...(rest.length > 0
			? [
					{
						id: "rest",
						label: "other",
						color: OTHER_COLOR,
						jobs: starts.map((_, i) => rest.reduce((sum, m) => sum + (m.jobs[i] ?? 0), 0)),
					},
				]
			: []),
	];
	const totals = starts.map((_, i) => layers.reduce((sum, l) => sum + (l.jobs[i] ?? 0), 0));
	// At least 3, so the thirds land on whole requests.
	const top = niceCeiling(Math.max(3, ...totals));
	const slot = (CHART.width - CHART.left - 10) / starts.length;
	const barWidth = Math.min(46, slot * 0.7);
	const hourly = report.range === "24h";
	const ticks = [0, top / 3, (top * 2) / 3, top];

	return (
		<Section
			title={hourly ? "Requests per hour" : "Requests per day"}
			caption={hourly ? "Busiest models, stacked" : "Busiest models, stacked, by UTC day"}
		>
			<div className="flex flex-col gap-3 px-[18px] pt-3.5 pb-4">
				<svg
					viewBox={`0 0 ${CHART.width} ${CHART.height}`}
					role="img"
					aria-label="Requests over time, stacked by model"
					className="h-auto w-full"
				>
					<g className="fill-silt font-mono text-[10px]">
						{ticks.map((tick) => {
							const y = CHART.base - (tick / top) * CHART.plot;
							return (
								<Fragment key={tick}>
									<line
										x1={CHART.left}
										x2={CHART.width - 10}
										y1={y}
										y2={y}
										stroke={tick === 0 ? "var(--line)" : "var(--depth-reef)"}
									/>
									<text x={CHART.left - 8} y={y + 3} textAnchor="end">
										{formatNumber(tick)}
									</text>
								</Fragment>
							);
						})}
					</g>
					{starts.map((start, i) => {
						const x = CHART.left + i * slot + (slot - barWidth) / 2;
						let y = CHART.base;
						return (
							<g key={start}>
								{layers.map((layer) => {
									const value = layer.jobs[i] ?? 0;
									const h = (value / top) * CHART.plot;
									y -= h;
									return value > 0 ? (
										<rect
											key={layer.id}
											x={x}
											y={y}
											width={barWidth}
											height={Math.max(h - 1, 0.5)}
											rx={1.5}
											fill={layer.color}
										>
											<title>{`${bucketLabel(start, report.range)} · ${layer.label}: ${formatCount(value)}`}</title>
										</rect>
									) : null;
								})}
								{showBucketLabel(i, starts.length) && (
									<text
										x={x + barWidth / 2}
										y={CHART.base + 16}
										textAnchor="middle"
										className="fill-silt font-mono text-[10px]"
									>
										{bucketLabel(start, report.range)}
									</text>
								)}
							</g>
						);
					})}
				</svg>
				<div className="flex flex-wrap gap-x-3.5 gap-y-1.5 font-mono text-[11.5px] text-mist">
					{layers.map((layer) => (
						<span key={layer.id} className="inline-flex items-center gap-1.5">
							<span
								aria-hidden="true"
								className="size-[9px] rounded-[2px]"
								style={{ background: layer.color }}
							/>
							{layer.label}
						</span>
					))}
				</div>
			</div>
		</Section>
	);
}

/** Every bucket up to two weeks; every third of 24 hours. */
function showBucketLabel(i: number, count: number): boolean {
	return count <= 14 || i % 3 === 0;
}

/** Hours in local time; days are UTC days, as the server buckets them. */
function bucketLabel(start: number, range: UsageRange): string {
	const date = new Date(start);
	if (range === "24h") return `${String(date.getHours()).padStart(2, "0")}:00`;
	return date.toLocaleDateString(
		"en-US",
		range === "7d"
			? { timeZone: "UTC", weekday: "short" }
			: { timeZone: "UTC", month: "short", day: "numeric" },
	);
}

/** A round axis maximum at or above `n`, 1, 2 or 5 times a power of ten for
 *  each third. */
function niceCeiling(n: number): number {
	const step = n / 3;
	const magnitude = 10 ** Math.floor(Math.log10(step));
	const nice = [1, 2, 5, 10].map((m) => m * magnitude).find((m) => m >= step) ?? 10 * magnitude;
	return nice * 3;
}

type TruncationLevel = "ok" | "warn" | "bad";

/** Above 2% of requests cut off at the limit needs a look; above 10% is bad. */
function truncationLevel(share: number): TruncationLevel {
	if (share <= 0.02) return "ok";
	return share > 0.1 ? "bad" : "warn";
}

const TRUNCATION_PILL: Record<TruncationLevel, string> = {
	ok: "text-mist",
	warn: "bg-amber-wash text-amber",
	bad: "bg-coral-wash text-coral",
};

/** A 0–1 share as a percentage with one decimal, without the % sign. */
function formatPercent(share: number): string {
	return (share * 100).toFixed(1);
}
