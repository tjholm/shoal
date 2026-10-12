import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Pencil, RefreshCw } from "lucide-react";
import { useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import {
	StatusBadge,
	StatusGlyph,
	workerStatus,
} from "../../components/StatusBadge";
import { Button } from "../../components/ui/button";
import {
	serverConfigQuery,
	workerDetailQuery,
	workerRecentEventsQuery,
	workerUsageByModelQuery,
	workerUsageDailyQuery,
} from "../../lib/queries";
import type {
	ModelUsage,
	UsageBucket,
	UsageEventRow,
	WorkerDetail,
} from "@shoal/contracts";
import { api } from "../../lib/api";

const CHART_DAYS_CAP = 14;
const USAGE_CHART_HEIGHT = 224;
const RECENT_LIMIT = 25;

export const Route = createFileRoute("/_authed/workers_/$workerId")({
	loader: ({ context: { queryClient }, params }) =>
		Promise.all([
			queryClient.ensureQueryData(workerDetailQuery(params.workerId)),
			queryClient.ensureQueryData(
				workerUsageDailyQuery(params.workerId, CHART_DAYS_CAP),
			),
			queryClient.ensureQueryData(workerUsageByModelQuery(params.workerId)),
			queryClient.ensureQueryData(
				workerRecentEventsQuery(params.workerId, RECENT_LIMIT),
			),
			queryClient.ensureQueryData(serverConfigQuery()),
		]),
	component: WorkerDetailPage,
});

function WorkerDetailPage() {
	const { workerId } = Route.useParams();
	const queryClient = useQueryClient();
	const { data: detail } = useSuspenseQuery(workerDetailQuery(workerId));
	const { data: daily } = useSuspenseQuery(
		workerUsageDailyQuery(workerId, CHART_DAYS_CAP),
	);
	const { data: byModel } = useSuspenseQuery(workerUsageByModelQuery(workerId));
	const { data: recent } = useSuspenseQuery(
		workerRecentEventsQuery(workerId, RECENT_LIMIT),
	);
	const { data: config } = useSuspenseQuery(serverConfigQuery());

	// Invalidate every query scoped to this worker so detail/usage/events all
	// refetch from a single Refresh action.
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["worker", workerId] });

	const chartDays = Math.min(config.usageRetentionDays, CHART_DAYS_CAP);
	const retentionLabel = `last ${config.usageRetentionDays}d`;

	if (!detail) {
		return (
			<main className="flex min-w-0 flex-col gap-6 px-5 pt-8 pb-16 sm:px-9">
				<BackLink />
				<section className="island-shell p-6 text-center">
					<p className="text-[var(--sea-ink-soft)]">Worker not found.</p>
				</section>
			</main>
		);
	}

	return (
		<main className="flex min-w-0 flex-col gap-6 px-5 pt-8 pb-16 sm:px-9">
			<BackLink />
			<Header detail={detail} onRenamed={refresh} onRefresh={refresh} />
			<SummaryCards detail={detail} retentionLabel={retentionLabel} />
			<ChartCard
				title={`Usage — last ${chartDays} ${chartDays === 1 ? "day" : "days"}`}
			>
				<UsageChart data={daily.slice(-chartDays)} />
			</ChartCard>
			<ChartCard title="Models served">
				{byModel.length === 0 ? (
					<Empty message="No completions recorded yet." />
				) : (
					<ModelBreakdown rows={byModel} />
				)}
			</ChartCard>
			<ChartCard title="Recent completions">
				{recent.length === 0 ? (
					<Empty message="No completions yet." />
				) : (
					<RecentTable rows={recent} />
				)}
			</ChartCard>
		</main>
	);
}

function BackLink() {
	return (
		<Link
			to="/workers"
			className="rise-in -mb-3 inline-flex w-fit items-center gap-1.5 text-[13px] text-mist hover:text-foam"
		>
			<ArrowLeft className="size-4" /> All workers
		</Link>
	);
}

function Header({
	detail,
	onRenamed,
	onRefresh,
}: {
	detail: WorkerDetail;
	onRenamed: () => void;
	onRefresh: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(detail.name ?? "");
	const headline = detail.name?.trim() || detail.workerId.slice(0, 8);
	const status = workerStatus(detail);

	const submit = async () => {
		const trimmed = draft.trim();
		await api((c) =>
			c.workers.rename({
				params: { workerId: detail.workerId },
				payload: { name: trimmed.length > 0 ? trimmed : null },
			}),
		);
		setEditing(false);
		onRenamed();
	};

	return (
		<header className="rise-in flex flex-wrap items-start justify-between gap-4">
			<div className="min-w-0">
				<div className="flex items-center gap-3">
					<StatusGlyph status={status} />
					{editing ? (
						<input
							ref={(el) => el?.focus()}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onBlur={submit}
							onKeyDown={(e) => {
								if (e.key === "Enter") submit();
								if (e.key === "Escape") setEditing(false);
							}}
							className="min-w-0 rounded-sm border border-input bg-trench px-2 py-0.5 font-mono text-[32px] font-medium text-foam"
							placeholder={detail.workerId.slice(0, 8)}
						/>
					) : (
						<button
							type="button"
							onClick={() => {
								setDraft(detail.name ?? "");
								setEditing(true);
							}}
							className="group flex min-w-0 items-center gap-2"
							title="Rename worker"
						>
							<h1 className="truncate font-mono text-[40px] leading-none font-medium tracking-[-0.03em] text-foam">
								{headline}
							</h1>
							<Pencil className="size-4 opacity-0 group-hover:opacity-60" />
						</button>
					)}
				</div>
				<p className="mt-1 font-mono text-xs text-[var(--sea-ink-soft)]">
					{detail.workerId}
				</p>
				{detail.keyName && (
					<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
						via key{" "}
						<span className="text-[var(--sea-ink)]">{detail.keyName}</span>
					</p>
				)}
			</div>
			<div className="flex items-center gap-2">
				<StatusBadge
					status={status}
					label={
						detail.online
							? `${detail.inFlight} / ${detail.maxConcurrent} active`
							: "offline"
					}
				/>
				<Button
					variant="ghost"
					size="icon"
					onClick={onRefresh}
					aria-label="Refresh"
				>
					<RefreshCw className="size-4" />
				</Button>
			</div>
		</header>
	);
}

function SummaryCards({
	detail,
	retentionLabel,
}: {
	detail: WorkerDetail;
	retentionLabel: string;
}) {
	const totalTokens = detail.totalPromptTokens + detail.totalCompletionTokens;
	const avgTokens =
		detail.totalJobs > 0
			? Math.round(detail.totalCompletionTokens / detail.totalJobs)
			: 0;
	const avgDuration =
		detail.avgDurationMs != null
			? `${(detail.avgDurationMs / 1000).toFixed(1)}s`
			: "—";

	return (
		<section className="rise-in grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-px overflow-hidden rounded-md border border-line bg-line">
			<Stat
				label={`Jobs (${retentionLabel})`}
				value={formatNumber(detail.totalJobs)}
			/>
			<Stat
				label={`Tokens (${retentionLabel})`}
				value={formatNumber(totalTokens)}
			>
				{formatNumber(detail.totalPromptTokens)} prompt ·{" "}
				{formatNumber(detail.totalCompletionTokens)} completion
			</Stat>
			<Stat label="Avg Output / Job" value={formatNumber(avgTokens)} />
			<Stat
				label={detail.online ? "Connected" : "Last Seen"}
				value={
					detail.online
						? formatDuration(detail.connectedMs ?? 0)
						: `${formatDuration(Date.now() - detail.lastSeenAt)} ago`
				}
			>
				avg {avgDuration} per job
			</Stat>
		</section>
	);
}

function Stat({
	label,
	value,
	children,
}: {
	label: string;
	value: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5 bg-shelf px-5 py-[18px]">
			<p className="label">{label}</p>
			<p className="metric text-[28px] leading-8 text-foam">
				{value}
			</p>
			{children && (
				<p className="text-xs text-mist">{children}</p>
			)}
		</div>
	);
}

function ChartCard({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="island-shell rise-in p-5">
			<h2 className="mb-4 text-[15px] font-semibold text-[var(--sea-ink)]">
				{title}
			</h2>
			{children}
		</section>
	);
}

function Empty({ message }: { message: string }) {
	return (
		<p className="py-8 text-center text-sm text-[var(--sea-ink-soft)]">
			{message}
		</p>
	);
}

function UsageChart({ data }: { data: ReadonlyArray<UsageBucket> }) {
	const display = data.map((d) => ({
		...d,
		label: d.date.slice(5), // MM-DD
	}));
	return (
		<ResponsiveContainer width="100%" height={USAGE_CHART_HEIGHT}>
			<BarChart
				data={display}
				margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
			>
				<CartesianGrid
					stroke="var(--line)"
					strokeDasharray="3 3"
					vertical={false}
				/>
				<XAxis
					dataKey="label"
					stroke="var(--sea-ink-soft)"
					fontSize={11}
					tickLine={false}
					axisLine={false}
				/>
				<YAxis
					stroke="var(--sea-ink-soft)"
					fontSize={11}
					tickLine={false}
					axisLine={false}
					tickFormatter={(v: number) => formatNumber(v)}
				/>
				<Tooltip
					cursor={{ fill: "var(--surface-strong)" }}
					contentStyle={{
						background: "var(--surface-strong)",
						border: "1px solid var(--line-strong)",
						fontFamily: "var(--font-mono)",
						borderRadius: 4,
						fontSize: 12,
					}}
					formatter={(value) => formatNumber(Number(value))}
					labelStyle={{ color: "var(--sea-ink-soft)" }}
				/>
				<Bar dataKey="promptTokens" stackId="t" fill="var(--signal-lumen)"
					fillOpacity={0.45} name="Prompt" />
				<Bar
					dataKey="completionTokens"
					stackId="t"
					fill="var(--signal-current)"
					name="Completion"
					radius={[3, 3, 0, 0]}
				/>
			</BarChart>
		</ResponsiveContainer>
	);
}

function ModelBreakdown({ rows }: { rows: ReadonlyArray<ModelUsage> }) {
	const total = rows.reduce(
		(sum, r) => sum + r.promptTokens + r.completionTokens,
		0,
	);
	return (
		<div className="space-y-3">
			{rows.map((row) => {
				const tokens = row.promptTokens + row.completionTokens;
				const pct = total > 0 ? (tokens / total) * 100 : 0;
				return (
					<div key={row.model}>
						<div className="mb-1 flex items-center justify-between text-sm">
							<span className="font-medium text-[var(--sea-ink)]">
								{row.model}
							</span>
							<span className="text-[var(--sea-ink-soft)]">
								{formatNumber(row.jobs)} jobs · {formatNumber(tokens)} tokens
							</span>
						</div>
						<div className="h-1.5 overflow-hidden rounded-xs border border-line bg-trench">
							<div
								className="h-full bg-lumen"
								style={{ width: `${pct}%` }}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}

function RecentTable({ rows }: { rows: ReadonlyArray<UsageEventRow> }) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full font-mono text-[12.5px] tabular-nums">
				<thead>
					<tr className="label border-b border-[var(--line)] text-left">
						<th className="py-2 pr-3 font-medium">When</th>
						<th className="py-2 pr-3 font-medium">Model</th>
						<th className="py-2 pr-3 text-right font-medium">Prompt</th>
						<th className="py-2 pr-3 text-right font-medium">Completion</th>
						<th className="py-2 pr-3 text-right font-medium">Duration</th>
						<th className="py-2 font-medium">Finish</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr
							key={row.id}
							className="border-b border-[var(--line)]/50 last:border-b-0"
						>
							<td className="py-2 pr-3 text-[var(--sea-ink-soft)]">
								{formatDuration(Date.now() - row.createdAt)} ago
							</td>
							<td className="py-2 pr-3 text-[var(--sea-ink)]">
								{row.model}
							</td>
							<td className="py-2 pr-3 text-right text-[var(--sea-ink)]">
								{formatNumber(row.promptTokens)}
							</td>
							<td className="py-2 pr-3 text-right text-[var(--sea-ink)]">
								{formatNumber(row.completionTokens)}
							</td>
							<td className="py-2 pr-3 text-right text-[var(--sea-ink-soft)]">
								{row.durationMs != null
									? `${(row.durationMs / 1000).toFixed(1)}s`
									: "—"}
							</td>
							<td className="py-2 text-[var(--sea-ink-soft)]">
								{row.finishReason ?? "—"}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function formatDuration(ms: number): string {
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ${min % 60}m`;
	const day = Math.floor(hr / 24);
	return `${day}d ${hr % 24}h`;
}

function formatNumber(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	if (n < 1_000_000_000)
		return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
	return `${(n / 1_000_000_000).toFixed(1)}B`;
}
