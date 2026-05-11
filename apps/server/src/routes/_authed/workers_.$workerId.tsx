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
import { Button } from "../../components/ui/button";
import {
	serverConfigQuery,
	workerDetailQuery,
	workerRecentEventsQuery,
	workerUsageByModelQuery,
	workerUsageDailyQuery,
} from "../../lib/queries";
import type { UsageBucket } from "../../server/functions/usage";
import {
	renameWorker,
	type WorkerDetail,
	type WorkerEventRow,
	type WorkerModelUsage,
} from "../../server/functions/workers";

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
			<main className="page-wrap px-4 pb-8 pt-10">
				<BackLink />
				<section className="island-shell rounded-sm p-6 text-center">
					<p className="text-[var(--sea-ink-soft)]">Worker not found.</p>
				</section>
			</main>
		);
	}

	return (
		<main className="page-wrap px-4 pb-8 pt-10">
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
			className="rise-in mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
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
	const busy = detail.online && detail.inFlight > 0;
	const dotClass = !detail.online
		? "bg-[var(--sea-ink-soft)]/40"
		: busy
			? "bg-amber-400"
			: "bg-[linear-gradient(90deg,#56c6be,#7ed3bf)]";

	const submit = async () => {
		const trimmed = draft.trim();
		await renameWorker({
			data: {
				workerId: detail.workerId,
				name: trimmed.length > 0 ? trimmed : null,
			},
		});
		setEditing(false);
		onRenamed();
	};

	return (
		<header className="rise-in mb-8 flex flex-wrap items-start justify-between gap-4">
			<div className="min-w-0">
				<div className="flex items-center gap-3">
					<span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass}`} />
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
							className="display-title min-w-0 rounded-sm border border-[var(--line)] bg-transparent px-2 py-0.5 text-3xl text-[var(--sea-ink)]"
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
							<h1 className="display-title truncate text-3xl text-[var(--sea-ink)] sm:text-4xl">
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
				<span
					className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
						!detail.online
							? "border-[var(--line)] bg-[var(--chip-bg)] text-[var(--sea-ink-soft)]"
							: busy
								? "border-amber-500/30 bg-amber-500/10 text-amber-300"
								: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
					}`}
				>
					{detail.online
						? `${detail.inFlight} / ${detail.maxConcurrent} active`
						: "offline"}
				</span>
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
		<section className="rise-in mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
		<div className="island-shell rounded-sm p-4">
			<p className="text-xs font-semibold uppercase tracking-wider text-[var(--sea-ink-soft)]">
				{label}
			</p>
			<p className="mt-1 text-2xl font-semibold text-[var(--sea-ink)]">
				{value}
			</p>
			{children && (
				<p className="mt-1 text-xs text-[var(--sea-ink-soft)]">{children}</p>
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
		<section className="island-shell rise-in mb-4 rounded-sm p-4">
			<h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--sea-ink-soft)]">
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

function UsageChart({ data }: { data: UsageBucket[] }) {
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
					contentStyle={{
						background: "var(--surface-strong)",
						border: "1px solid var(--line)",
						borderRadius: 4,
						fontSize: 12,
					}}
					formatter={(value) => formatNumber(Number(value))}
					labelStyle={{ color: "var(--sea-ink-soft)" }}
				/>
				<Bar dataKey="promptTokens" stackId="t" fill="#56c6be" name="Prompt" />
				<Bar
					dataKey="completionTokens"
					stackId="t"
					fill="#7ed3bf"
					name="Completion"
					radius={[3, 3, 0, 0]}
				/>
			</BarChart>
		</ResponsiveContainer>
	);
}

function ModelBreakdown({ rows }: { rows: WorkerModelUsage[] }) {
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
						<div className="h-1.5 overflow-hidden rounded-full bg-[var(--chip-bg)]">
							<div
								className="h-full bg-[linear-gradient(90deg,#56c6be,#7ed3bf)]"
								style={{ width: `${pct}%` }}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}

function RecentTable({ rows }: { rows: WorkerEventRow[] }) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wider text-[var(--sea-ink-soft)]">
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
							<td className="py-2 pr-3 font-mono text-xs text-[var(--sea-ink)]">
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
