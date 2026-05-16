import { mergeModelViews, type WorkerModel } from "@shoal/protocol";
import { useLiveQuery } from "@tanstack/react-db";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, createFileRoute, Link } from "@tanstack/react-router";
import {
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { ModelChip } from "../../components/ModelChip";
import { workersCollection } from "../../lib/collections";
import {
	dashboardAggregatesQuery,
	orgUsageByModelQuery,
	serverConfigQuery,
	usageDailyQuery,
	workerCountsSnapshotQuery,
	workerLeaderboardQuery,
} from "../../lib/queries";
import type {
	OrgModelUsage,
	UsageBucket,
	WorkerCountsSnapshot,
	WorkerLeaderboardEntry,
} from "../../server/functions/usage";

const CHART_DAYS_CAP = 14;
const USAGE_CHART_HEIGHT = 224;
const MODEL_CHART_HEIGHT = 256;
const LEADERBOARD_LIMIT = 10;

export const Route = createFileRoute("/_authed/")({
	loader: ({ context: { queryClient } }) =>
		Promise.all([
			queryClient.ensureQueryData(dashboardAggregatesQuery()),
			queryClient.ensureQueryData(usageDailyQuery(CHART_DAYS_CAP)),
			queryClient.ensureQueryData(orgUsageByModelQuery()),
			queryClient.ensureQueryData(workerLeaderboardQuery(LEADERBOARD_LIMIT)),
			queryClient.ensureQueryData(serverConfigQuery()),
			queryClient.ensureQueryData(workerCountsSnapshotQuery()),
		]),
	component: Dashboard,
});

function Dashboard() {
	const { data: agg } = useSuspenseQuery(dashboardAggregatesQuery());
	const { data: daily } = useSuspenseQuery(usageDailyQuery(CHART_DAYS_CAP));
	const { data: models } = useSuspenseQuery(orgUsageByModelQuery());
	const { data: leaderboard } = useSuspenseQuery(
		workerLeaderboardQuery(LEADERBOARD_LIMIT),
	);
	const { data: config } = useSuspenseQuery(serverConfigQuery());
	const { data: counts } = useSuspenseQuery(workerCountsSnapshotQuery());

	const totalTokens = agg.totalPromptTokens + agg.totalCompletionTokens;
	const chartDays = Math.min(config.usageRetentionDays, CHART_DAYS_CAP);
	const retentionLabel = `last ${config.usageRetentionDays}d`;

	return (
		<main className="page-wrap px-4 pb-8 pt-10">
			<header className="rise-in mb-8">
				<h1 className="display-title text-3xl text-[var(--sea-ink)] sm:text-4xl">
					Dashboard
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					Overview of workers and inference activity for this organization
				</p>
			</header>

			<section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<ClientOnly fallback={<WorkerStatCards counts={counts} />}>
					<LiveWorkerStatCards />
				</ClientOnly>
				<StatCard
					label={`Jobs (${retentionLabel})`}
					value={formatNumber(agg.totalJobs)}
					sub={`${formatNumber(agg.jobsLastDay)} in last 24h`}
				/>
				<StatCard
					label={`Tokens (${retentionLabel})`}
					value={formatNumber(totalTokens)}
					sub={`${formatNumber(agg.tokensLastDay)} in last 24h`}
				/>
			</section>

			<section className="island-shell rise-in mt-6 rounded-sm p-4">
				<h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--sea-ink-soft)]">
					Usage — last {chartDays} {chartDays === 1 ? "day" : "days"}
				</h2>
				<UsageChart data={daily} days={chartDays} />
			</section>

			<div className="mt-6 grid gap-4 lg:grid-cols-2">
				<section className="island-shell rise-in rounded-sm p-4">
					<h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--sea-ink-soft)]">
						Model popularity
					</h2>
					{models.length === 0 ? (
						<Empty message="No completions recorded yet." />
					) : (
						<ModelChart rows={models} />
					)}
				</section>

				<section className="island-shell rise-in rounded-sm p-4">
					<h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--sea-ink-soft)]">
						Top workers
					</h2>
					{leaderboard.length === 0 ? (
						<Empty message="No workers have served jobs yet." />
					) : (
						<ClientOnly fallback={<Leaderboard rows={leaderboard} />}>
							<LiveLeaderboard rows={leaderboard} />
						</ClientOnly>
					)}
				</section>
			</div>

			<ClientOnly
				fallback={
					<>
						{/* SSR fallback: snapshot only carries ids; capability icons appear
						    once the SSE-backed `LiveBottomSections` swaps in. */}
						<AvailableModelsSection
							models={counts.models.map((id) => ({ id }))}
						/>
						<GettingStartedSection totalWorkerCount={counts.totalWorkerCount} />
					</>
				}
			>
				<LiveBottomSections />
			</ClientOnly>
		</main>
	);
}

function WorkerStatCards({ counts }: { counts: WorkerCountsSnapshot }) {
	return (
		<>
			<StatCard
				label="Workers Online"
				value={String(counts.onlineCount)}
				sub={`${counts.busyCount} busy · ${counts.idleCount} idle`}
			/>
			<StatCard
				label="Total Workers"
				value={String(counts.totalWorkerCount)}
				sub={
					counts.totalWorkerCount > counts.onlineCount
						? `${counts.totalWorkerCount - counts.onlineCount} offline`
						: "all online"
				}
			/>
		</>
	);
}

function LiveWorkerStatCards() {
	const { data: workers } = useLiveQuery((q) =>
		q.from({ worker: workersCollection }),
	);
	const list = workers ?? [];
	const onlineCount = list.filter((w) => w.online).length;
	const busyCount = list.filter((w) => w.online && w.inFlight > 0).length;
	const idleCount = onlineCount - busyCount;
	const total = list.length;

	return (
		<>
			<StatCard
				label="Workers Online"
				value={String(onlineCount)}
				sub={`${busyCount} busy · ${idleCount} idle`}
			/>
			<StatCard
				label="Total Workers"
				value={String(total)}
				sub={
					total > onlineCount
						? `${total - onlineCount} offline`
						: total > 0
							? "all online"
							: "—"
				}
			/>
		</>
	);
}

function LiveBottomSections() {
	const { data: workers } = useLiveQuery((q) =>
		q.from({ worker: workersCollection }),
	);
	const list = workers ?? [];

	// Group every online worker's view of each model id, then collapse each
	// group to a single chip via the conservative merge (only show what all
	// advertising workers agree on).
	const byId = new Map<string, WorkerModel[]>();
	for (const w of list) {
		if (!w.online) continue;
		for (const m of w.availableModels) {
			const arr = byId.get(m.id);
			if (arr) arr.push(m);
			else byId.set(m.id, [m]);
		}
	}
	const models = [...byId.values()].map(mergeModelViews);

	return (
		<>
			<AvailableModelsSection models={models} />
			<GettingStartedSection totalWorkerCount={list.length} />
		</>
	);
}

function AvailableModelsSection({ models }: { models: WorkerModel[] }) {
	if (models.length === 0) return null;
	return (
		<section className="island-shell mt-6 rounded-sm p-6">
			<p className="island-kicker mb-3">Available Models</p>
			<div className="flex flex-wrap gap-2">
				{models.map((model) => (
					<ModelChip key={model.id} model={model} size="md" />
				))}
			</div>
		</section>
	);
}

function GettingStartedSection({
	totalWorkerCount,
}: {
	totalWorkerCount: number;
}) {
	if (totalWorkerCount > 0) return null;
	return (
		<section className="island-shell mt-6 rounded-sm p-6">
			<p className="island-kicker mb-2">Getting Started</p>
			<p className="text-sm text-[var(--sea-ink-soft)]">
				No workers connected. Start a worker to begin:
			</p>
			<pre className="mt-3 rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] p-4 text-sm text-[var(--sea-ink)]">
				<code>bun run dev:worker</code>
			</pre>
		</section>
	);
}

function StatCard({
	label,
	value,
	sub,
}: {
	label: string;
	value: string;
	sub?: string;
}) {
	return (
		<article className="island-shell feature-card rise-in rounded-sm p-5">
			<p className="text-xs font-semibold uppercase tracking-wider text-[var(--sea-ink-soft)]">
				{label}
			</p>
			<p className="mt-1 text-3xl font-bold text-[var(--sea-ink)]">{value}</p>
			{sub && <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">{sub}</p>}
		</article>
	);
}

function UsageChart({ data, days }: { data: UsageBucket[]; days: number }) {
	// Backfill missing days for a continuous axis.
	const byDate = new Map(data.map((d) => [d.date, d]));
	const display: Array<UsageBucket & { label: string }> = [];
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
		const key = d.toISOString().slice(0, 10);
		const r = byDate.get(key);
		display.push({
			date: key,
			label: key.slice(5),
			promptTokens: r?.promptTokens ?? 0,
			completionTokens: r?.completionTokens ?? 0,
			jobs: r?.jobs ?? 0,
		});
	}

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

function ModelChart({ rows }: { rows: OrgModelUsage[] }) {
	// Show top 8; if there are more, group the tail into "other" so the chart
	// doesn't get noisy.
	const top = rows.slice(0, 8);
	const tail = rows.slice(8);
	const display = top.map((r) => ({
		model: r.model,
		jobs: r.jobs,
		tokens: r.promptTokens + r.completionTokens,
	}));
	if (tail.length > 0) {
		display.push({
			model: `other (${tail.length})`,
			jobs: tail.reduce((s, r) => s + r.jobs, 0),
			tokens: tail.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0),
		});
	}

	return (
		<ResponsiveContainer width="100%" height={MODEL_CHART_HEIGHT}>
			<BarChart
				data={display}
				layout="vertical"
				margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
			>
				<CartesianGrid
					stroke="var(--line)"
					strokeDasharray="3 3"
					horizontal={false}
				/>
				<XAxis
					type="number"
					stroke="var(--sea-ink-soft)"
					fontSize={11}
					tickLine={false}
					axisLine={false}
					tickFormatter={(v: number) => formatNumber(v)}
				/>
				<YAxis
					type="category"
					dataKey="model"
					stroke="var(--sea-ink-soft)"
					fontSize={11}
					tickLine={false}
					axisLine={false}
					width={120}
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
				<Bar dataKey="jobs" fill="#56c6be" name="Jobs" radius={[0, 3, 3, 0]} />
			</BarChart>
		</ResponsiveContainer>
	);
}

function LiveLeaderboard({ rows }: { rows: WorkerLeaderboardEntry[] }) {
	const { data: workers } = useLiveQuery((q) =>
		q.from({ worker: workersCollection }),
	);
	const onlineByWorker = new Map(
		(workers ?? []).map((w) => [w.workerId, w.online]),
	);
	const merged = rows.map((row) => ({
		...row,
		online: onlineByWorker.get(row.workerId) ?? row.online,
	}));
	return <Leaderboard rows={merged} />;
}

function Leaderboard({ rows }: { rows: WorkerLeaderboardEntry[] }) {
	return (
		<ol className="space-y-2">
			{rows.map((row, i) => {
				const tokens = row.promptTokens + row.completionTokens;
				const headline = row.name?.trim() || row.workerId.slice(0, 8);
				return (
					<li
						key={row.workerId}
						className="flex items-center gap-3 rounded-sm border border-[var(--line)]/50 px-3 py-2"
					>
						<span className="w-6 text-center font-mono text-xs text-[var(--sea-ink-soft)]">
							{i + 1}
						</span>
						<span
							className={`h-2 w-2 shrink-0 rounded-full ${
								row.online
									? "bg-[linear-gradient(90deg,#56c6be,#7ed3bf)]"
									: "bg-[var(--sea-ink-soft)]/40"
							}`}
						/>
						<Link
							to="/workers/$workerId"
							params={{ workerId: row.workerId }}
							className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--sea-ink)] hover:underline"
						>
							{headline}
						</Link>
						<span className="text-right text-xs text-[var(--sea-ink-soft)]">
							<span className="font-medium text-[var(--sea-ink)]">
								{formatNumber(row.jobs)}
							</span>{" "}
							jobs · {formatNumber(tokens)} tokens
						</span>
					</li>
				);
			})}
		</ol>
	);
}

function Empty({ message }: { message: string }) {
	return (
		<p className="py-8 text-center text-sm text-[var(--sea-ink-soft)]">
			{message}
		</p>
	);
}

function formatNumber(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	if (n < 1_000_000_000)
		return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
	return `${(n / 1_000_000_000).toFixed(1)}B`;
}
