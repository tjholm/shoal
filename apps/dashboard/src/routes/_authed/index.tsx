import type {
	ActiveJob,
	ModelUsage,
	UsageEventRow,
	UsageRange,
	UsageSummary,
	UsageTotals,
	WorkerInfo,
} from "@shoal/contracts";
import type { ModelPurpose } from "@shoal/protocol";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FitNumber } from "../../components/FitNumber";
import { KIND_LABEL, KindIcon } from "../../components/icons";
import { Fact, Page, Section, TableHead } from "../../components/Page";
import { Segmented } from "../../components/Segmented";
import { Sparkline } from "../../components/Sparkline";
import { TextMorph } from "../../components/TextMorph";
import { jobTokens, useActivity } from "../../lib/activity";
import { workersCollection } from "../../lib/collections";
import {
	authContextQuery,
	membersQuery,
	modelUsageQuery,
	recentEventsQuery,
	usageSummaryQuery,
} from "../../lib/queries";

const DEFAULT_RANGE: UsageRange = "24h";
const RECENT_LIMIT = 8;

export const Route = createFileRoute("/_authed/")({
	loader: ({ context: { queryClient } }) =>
		Promise.all([
			queryClient.ensureQueryData(usageSummaryQuery(DEFAULT_RANGE)),
			queryClient.ensureQueryData(modelUsageQuery(DEFAULT_RANGE)),
			queryClient.ensureQueryData(recentEventsQuery(RECENT_LIMIT)),
		]),
	component: Overview,
});

function Overview() {
	const [range, setRange] = useState<UsageRange>(DEFAULT_RANGE);
	const summary = useQuery(usageSummaryQuery(range));
	const modelUsage = useQuery(modelUsageQuery(range));
	const { data: recent } = useSuspenseQuery(recentEventsQuery(RECENT_LIMIT));
	const { data: auth } = useQuery(authContextQuery());
	const { data: members } = useQuery(membersQuery());
	const { data: liveWorkers } = useLiveQuery((q) => q.from({ worker: workersCollection }));
	const workers = liveWorkers ?? [];
	const models = reachableModels(workers, modelUsage.data ?? []);
	const online = workers.filter((w) => w.online).length;
	const reachable = models.filter((m) => m.servedBy > 0).length;

	return (
		<Page
			title="Overview"
			stats={
				<>
					<span>
						<span className="text-foam">{auth?.activeOrg?.name ?? "—"}</span>
						{members && ` · ${members.length} ${members.length === 1 ? "member" : "members"}`}
					</span>
					<Fact value={online}>{online === 1 ? "worker" : "workers"} online</Fact>
					<Fact value={reachable}>{reachable === 1 ? "model" : "models"} reachable</Fact>
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
			<Kpis summary={summary.data} organizationId={auth?.activeOrg?.id} />
			<RunningNow organizationId={auth?.activeOrg?.id} workers={workers} />
			<div className="flex flex-wrap items-start gap-6">
				<ModelsReachable models={models} range={range} />
				<RecentRequests rows={recent} />
			</div>
		</Page>
	);
}

function Kpis({
	summary,
	organizationId,
}: {
	summary: UsageSummary | undefined;
	organizationId: string | undefined;
}) {
	// Running jobs' output ticks into "Tokens out" until usage records it.
	const { unrecordedOutputTokens } = useActivity(organizationId);
	const buckets = summary?.buckets ?? [];
	const current = summary?.current;
	const previous = summary?.previous;
	const series = (pick: (t: UsageTotals) => number) => buckets.map(pick);
	const avgSeconds = (t: UsageTotals | undefined) =>
		t?.avgDurationMs != null ? t.avgDurationMs / 1000 : null;
	return (
		<section
			aria-label="Usage"
			className="rise-in grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-px overflow-hidden rounded-md border border-line bg-line"
		>
			<Kpi
				label="Requests"
				value={current?.jobs}
				bars={series((b) => b.jobs)}
				note={change(current?.jobs, previous?.jobs)}
			/>
			<Kpi
				label="Tokens out"
				value={current && current.completionTokens + unrecordedOutputTokens}
				bars={series((b) => b.completionTokens)}
				note={change(current?.completionTokens, previous?.completionTokens)}
			/>
			<Kpi
				label="Tokens in"
				value={current?.promptTokens}
				bars={series((b) => b.promptTokens)}
				note={change(current?.promptTokens, previous?.promptTokens)}
			/>
			<Kpi
				label="Avg request"
				value={avgSeconds(current)?.toFixed(1) ?? "—"}
				unit="s"
				bars={series((b) => b.avgDurationMs ?? 0)}
				note={{
					text:
						avgSeconds(previous) != null
							? `previously ${avgSeconds(previous)?.toFixed(1)} s`
							: "no earlier requests",
					tone: "text-mist",
				}}
			/>
		</section>
	);
}

/** The change from the previous window, as the design's "▲ 12% vs previous". */
function change(
	current: number | undefined,
	previous: number | undefined,
): { text: string; tone: string } {
	if (current === undefined || previous === undefined) return { text: " ", tone: "text-mist" };
	if (previous === 0) {
		return current === 0
			? { text: "no activity yet", tone: "text-mist" }
			: { text: "new this period", tone: "text-lumen" };
	}
	const pct = Math.round(((current - previous) / previous) * 100);
	if (pct === 0) return { text: "flat vs previous", tone: "text-mist" };
	return pct > 0
		? { text: `▲ ${pct}% vs previous`, tone: "text-lumen" }
		: { text: `▼ ${Math.abs(pct)}% vs previous`, tone: "text-mist" };
}

function Kpi({
	label,
	value,
	unit,
	bars,
	note,
}: {
	label: string;
	/** A count shows as many digits as fit; a string morphs as it changes. */
	value: number | string | undefined;
	unit?: string;
	bars: ReadonlyArray<number>;
	note: { text: string; tone: string };
}) {
	return (
		<div className="flex flex-col gap-2.5 bg-shelf px-[18px] py-4">
			<span className="label">{label}</span>
			<span className="metric flex min-w-0 items-baseline text-[28px] leading-8 text-foam">
				{typeof value === "number" ? (
					<FitNumber value={value} className="flex-1" />
				) : (
					<TextMorph as="span">{value ?? "—"}</TextMorph>
				)}
				{unit && <span className="ml-1.5 text-[13px] tracking-normal text-silt">{unit}</span>}
			</span>
			<Sparkline values={bars} />
			<span className={`text-xs ${note.tone}`}>{note.text}</span>
		</div>
	);
}

interface ReachableModel {
	id: string;
	purpose: ModelPurpose | undefined;
	/** Online workers advertising the model. */
	servedBy: number;
	/** Online workers with it loaded right now. */
	hot: number;
	requests: number;
}

/** Every model an online worker serves, plus any requested in the window
 *  that no worker serves now, hot first then busiest. */
function reachableModels(
	workers: ReadonlyArray<WorkerInfo>,
	usage: ReadonlyArray<ModelUsage>,
): ReachableModel[] {
	const requests = new Map(usage.map((u) => [u.model, u.jobs]));
	const byId = new Map<string, ReachableModel>();
	for (const w of workers) {
		if (!w.online) continue;
		for (const m of w.availableModels) {
			const entry = byId.get(m.id) ?? {
				id: m.id,
				purpose: m.purpose,
				servedBy: 0,
				hot: 0,
				requests: requests.get(m.id) ?? 0,
			};
			entry.servedBy++;
			if (w.loadedModels.includes(m.id)) entry.hot++;
			entry.purpose ??= m.purpose;
			byId.set(m.id, entry);
		}
	}
	for (const u of usage) {
		if (!byId.has(u.model)) {
			byId.set(u.model, { id: u.model, purpose: undefined, servedBy: 0, hot: 0, requests: u.jobs });
		}
	}
	return [...byId.values()].sort(
		(a, b) => Number(b.hot > 0) - Number(a.hot > 0) || b.requests - a.requests,
	);
}

const MODEL_COLUMNS = "minmax(0,2fr) 100px 130px 90px 70px";

function ModelsReachable({ models, range }: { models: ReachableModel[]; range: UsageRange }) {
	return (
		<Section
			title="Models reachable now"
			actions={
				<span className="font-mono text-[11px] text-silt">
					use the id as <span className="text-mist">model</span>
				</span>
			}
			className="min-w-0 flex-[999_1_520px]"
		>
			{models.length === 0 ? (
				<Empty>No worker is serving a model yet.</Empty>
			) : (
				<div className="overflow-x-auto">
					<div className="min-w-[560px]">
						<TableHead columns={MODEL_COLUMNS}>
							<span>Model id</span>
							<span>Kind</span>
							<span>Served by</span>
							<span className="text-right">Req · {range}</span>
							<span className="text-right">State</span>
						</TableHead>
						{models.map((m) => (
							<ModelRow key={m.id} model={m} />
						))}
					</div>
				</div>
			)}
		</Section>
	);
}

function ModelRow({ model }: { model: ReachableModel }) {
	const hot = model.hot > 0;
	const servedTone =
		model.servedBy === 0 ? "text-coral" : model.servedBy === 1 ? "text-amber" : "text-mist";
	return (
		<div
			className="grid items-center gap-4 border-b border-reef px-[18px] py-2.5 font-mono text-[12.5px] last:border-b-0"
			style={{ gridTemplateColumns: MODEL_COLUMNS }}
		>
			<span className="flex min-w-0 items-center gap-2.5">
				<span
					aria-hidden="true"
					className={`size-1.5 shrink-0 rounded-full ${hot ? "bg-lumen" : "bg-line-strong"}`}
				/>
				<span className={`truncate ${hot ? "text-foam" : "text-mist"}`}>{model.id}</span>
			</span>
			<span className="flex items-center gap-1.5 text-xs text-mist">
				<KindIcon purpose={model.purpose} size={13} />
				{model.purpose ? KIND_LABEL[model.purpose] : "—"}
			</span>
			<span className="flex items-center gap-1.5">
				<span aria-hidden="true" className="flex gap-0.5">
					{[0, 1, 2].map((i) => (
						<span
							key={i}
							className={`size-2 rounded-[1px] border ${
								i < model.hot
									? "border-lumen bg-lumen"
									: i < model.servedBy
										? "border-line-strong"
										: "border-reef"
							}`}
						/>
					))}
				</span>
				<span className={`text-[11px] ${servedTone}`}>
					{model.servedBy === 0
						? "none"
						: `${model.servedBy} ${model.servedBy === 1 ? "worker" : "workers"}`}
				</span>
			</span>
			<span className="text-right tabular-nums">{formatCount(model.requests)}</span>
			<span className={`text-right text-xs ${hot ? "text-lumen" : "text-silt"}`}>
				{hot ? "● hot" : "cold"}
			</span>
		</div>
	);
}

const RUNNING_COLUMNS = "minmax(0,2fr) minmax(0,1fr) 80px 110px 90px";

/** Live jobs. Subscribes here, not in the page, so only this section and the
 *  KPIs re-render as counts tick. */
function RunningNow({
	organizationId,
	workers,
}: {
	organizationId: string | undefined;
	workers: ReadonlyArray<WorkerInfo>;
}) {
	const { jobs, serverClockOffset } = useActivity(organizationId);
	const now = useNow(jobs.length > 0 ? 500 : null) + serverClockOffset;
	const names = new Map(workers.map((w) => [w.workerId, w.name]));
	return (
		<Section
			title="Running now"
			actions={
				<span className="font-mono text-[11px] text-silt">
					<TextMorph as="span">{jobs.length}</TextMorph> live
				</span>
			}
		>
			{jobs.length === 0 ? (
				<p className="px-[18px] py-4 text-[13px] text-silt">Nothing running right now.</p>
			) : (
				// Rolling digits briefly overflow their cell vertically; clip that so
				// it can't flash a scrollbar, while narrow screens still scroll sideways.
				<div className="overflow-x-auto overflow-y-hidden">
					<div className="min-w-[560px]">
						<TableHead columns={RUNNING_COLUMNS}>
							<span>Model</span>
							<span>Worker</span>
							<span className="text-right">Elapsed</span>
							<span className="text-right">Tokens out</span>
							<span className="text-right">Avg tok/s</span>
						</TableHead>
						{jobs.map((job) => (
							<RunningRow
								key={job.jobId}
								job={job}
								workerName={names.get(job.workerId) ?? null}
								now={now}
							/>
						))}
					</div>
				</div>
			)}
		</Section>
	);
}

function RunningRow({
	job,
	workerName,
	now,
}: {
	job: ActiveJob;
	workerName: string | null;
	now: number;
}) {
	// `now` is on the server's clock; the floor avoids dividing by zero.
	const seconds = Math.max(0.1, (now - job.startedAt) / 1000);
	const tokens = jobTokens(job);
	const rate = tokens > 0 ? Math.round(tokens / seconds) : null;
	return (
		<div
			className="rise-in grid items-center gap-4 border-b border-reef px-[18px] py-2.5 font-mono text-[12.5px] last:border-b-0"
			style={{ gridTemplateColumns: RUNNING_COLUMNS }}
		>
			<span className="flex min-w-0 items-center gap-2.5">
				<span
					aria-hidden="true"
					className="live-pulse size-1.5 shrink-0 rounded-full bg-lumen"
				/>
				<span className="truncate text-foam">{job.model}</span>
			</span>
			<Link
				to="/workers/$workerId"
				params={{ workerId: job.workerId }}
				className="truncate text-mist hover:text-foam"
			>
				{workerName ?? job.workerId.slice(0, 8)}
			</Link>
			<span className="text-right text-mist tabular-nums">{formatElapsed(seconds)}</span>
			<span className="text-right text-foam tabular-nums">
				<FitNumber value={tokens} />
			</span>
			<span className="text-right text-mist tabular-nums">
				{rate === null ? "—" : <TextMorph as="span">{rate}</TextMorph>}
			</span>
		</div>
	);
}

/** The current time, refreshed every `intervalMs`; frozen while null. */
function useNow(intervalMs: number | null): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (intervalMs === null) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	return `${Math.floor(seconds / 60)}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

const FINISH = {
	stop: { glyph: "●", tone: "text-lumen", text: "done" },
	length: { glyph: "◇", tone: "text-amber", text: "hit max tokens" },
	tool_calls: { glyph: "→", tone: "text-[var(--signal-current)]", text: "called tools" },
} as const;

function RecentRequests({ rows }: { rows: ReadonlyArray<UsageEventRow> }) {
	return (
		<Section
			title="Recent requests"
			actions={<span className="font-mono text-[11px] text-silt">this org</span>}
			className="min-w-0 flex-[1_1_320px]"
		>
			{rows.length === 0 ? (
				<Empty>No requests yet.</Empty>
			) : (
				<ol className="py-1.5">
					{rows.map((row) => {
						const finish =
							FINISH[(row.finishReason ?? "stop") as keyof typeof FINISH] ?? FINISH.stop;
						return (
							<li
								key={row.id}
								className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-baseline gap-2.5 px-[18px] py-[9px]"
							>
								<span className={`font-mono text-xs ${finish.tone}`}>{finish.glyph}</span>
								<span className="text-[13px] leading-[1.45] text-mist">
									<span className="font-mono text-foam">{row.model}</span> on{" "}
									<Link
										to="/workers/$workerId"
										params={{ workerId: row.workerId }}
										className="font-mono text-mist hover:text-foam"
									>
										{row.workerName ?? row.workerId.slice(0, 8)}
									</Link>{" "}
									· {formatNumber(row.promptTokens + row.completionTokens)} tok, {finish.text}
								</span>
								<span className="font-mono text-[11px] whitespace-nowrap text-silt">
									{formatAgo(row.createdAt)}
								</span>
							</li>
						);
					})}
				</ol>
			)}
		</Section>
	);
}

function Empty({ children }: { children: React.ReactNode }) {
	return <p className="px-[18px] py-10 text-center text-[13px] text-silt">{children}</p>;
}

function formatCount(n: number): string {
	return n.toLocaleString("en-US");
}

function formatNumber(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
	if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	return `${(n / 1_000_000_000).toFixed(1)}B`;
}

function formatAgo(epochMs: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
