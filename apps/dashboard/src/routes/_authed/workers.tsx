import type { WorkerInfo, WorkerUsageSeries } from "@shoal/contracts";
import type { ModelPurpose, WorkerModel } from "@shoal/protocol";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ConnectSteps } from "../../components/ConnectWorker";
import {
	ChevronIcon,
	KIND_LABEL,
	KindIcon,
	ToolsIcon,
	VisionIcon,
} from "../../components/icons";
import { Fact, Page, TableHead } from "../../components/Page";
import { Segmented } from "../../components/Segmented";
import { Sparkline } from "../../components/Sparkline";
import { Button } from "../../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "../../components/ui/dialog";
import { useCollections } from "../../lib/collections";
import { formatNumber, workerLabel } from "../../lib/format";
import { serverConfigQuery, workerSeriesQuery } from "../../lib/queries";

const SERIES_DAYS = 14;

export const Route = createFileRoute("/_authed/workers")({
	loader: ({ context: { queryClient } }) =>
		queryClient.ensureQueryData(serverConfigQuery()),
	component: Workers,
});

type Filter = "all" | "online" | "offline";

function Workers() {
	const { data: config } = useSuspenseQuery(serverConfigQuery());
	const { workers: workersCollection } = useCollections();
	const { data: liveWorkers, isReady } = useLiveQuery(
		(q) =>
			q
				.from({ worker: workersCollection })
				.orderBy(({ worker }) => worker.lastSeenAt, "desc"),
		[workersCollection],
	);
	const workers = liveWorkers ?? [];

	if (!isReady) return <Page title="Workers">{null}</Page>;
	if (workers.length === 0) return <FirstFish serverWsUrl={config.serverWsUrl} />;
	return <Fleet workers={workers} />;
}

function Fleet({ workers }: { workers: ReadonlyArray<WorkerInfo> }) {
	const [filter, setFilter] = useState<Filter>("all");
	const [expanded, setExpanded] = useState<string | null>(
		() => workers.find((w) => w.online)?.workerId ?? null,
	);
	const { data: series } = useQuery(workerSeriesQuery(SERIES_DAYS));
	const seriesById = new Map((series ?? []).map((s) => [s.workerId, s]));

	const online = workers.filter((w) => w.online);
	const slots = online.reduce((n, w) => n + (w.maxConcurrent ?? 0), 0);
	const busy = online.reduce((n, w) => n + w.inFlight, 0);
	const tokens = (series ?? []).reduce(
		(n, s) => n + s.days.reduce((m, d) => m + d.promptTokens + d.completionTokens, 0),
		0,
	);
	const shown = workers.filter((w) =>
		filter === "all" ? true : filter === "online" ? w.online : !w.online,
	);

	return (
		<Page
			title="Workers"
			stats={
				<>
					<Fact value={online.length}>of {workers.length} in the school</Fact>
					<Fact value={`${busy} / ${slots}`}>slots busy</Fact>
					<Fact value={formatNumber(tokens)}>tokens · {SERIES_DAYS}d</Fact>
				</>
			}
			controls={
				<Segmented
					label="Filter workers"
					value={filter}
					onChange={setFilter}
					options={[
						{ value: "all", label: "All", count: workers.length },
						{ value: "online", label: "Online", count: online.length },
						{ value: "offline", label: "Offline", count: workers.length - online.length },
					]}
				/>
			}
		>
			<div className="flex flex-col gap-3">
				{shown.map((w) => (
					<WorkerCard
						key={w.workerId}
						worker={w}
						series={seriesById.get(w.workerId)}
						expanded={expanded === w.workerId}
						onToggle={() => setExpanded(expanded === w.workerId ? null : w.workerId)}
					/>
				))}
				{shown.length === 0 && (
					<p className="py-6 text-center text-[13px] text-silt">No {filter} workers.</p>
				)}
			</div>
		</Page>
	);
}

function WorkerCard({
	worker,
	series,
	expanded,
	onToggle,
}: {
	worker: WorkerInfo;
	series: WorkerUsageSeries | undefined;
	expanded: boolean;
	onToggle: () => void;
}) {
	const status = !worker.online ? "offline" : worker.inFlight > 0 ? "working" : "idle";
	const badge = {
		working: "border-lumen-edge bg-lumen-wash text-lumen",
		idle: "border-line-strong bg-reef text-mist",
		offline: "border-coral-edge bg-coral-wash text-coral",
	}[status];
	const loaded = worker.availableModels.filter((m) => worker.loadedModels.includes(m.id)).length;
	const days = series?.days ?? [];
	const tokens = days.reduce((n, d) => n + d.promptTokens + d.completionTokens, 0);
	const jobs = days.reduce((n, d) => n + d.jobs, 0);
	const maxSlots = worker.maxConcurrent ?? 0;

	return (
		<article
			className={`rise-in overflow-hidden rounded-md border bg-shelf ${expanded ? "border-lumen/50" : "border-line"} ${worker.online ? "" : "opacity-[0.72]"}`}
		>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={expanded}
				className="flex w-full flex-wrap items-center gap-x-6 gap-y-3.5 px-[18px] py-4 text-left"
			>
				<span className="flex min-w-0 flex-[1_1_220px] flex-col gap-[5px]">
					<span className="flex items-center gap-2">
						<span className="truncate font-mono text-[15px] font-medium text-foam">
							{workerLabel(worker.workerId, worker.name)}
						</span>
						<span
							className={`inline-flex h-5 shrink-0 items-center rounded-xs border px-1.5 font-mono text-[11px] ${badge}`}
						>
							{status === "offline" ? "× offline" : `● ${status}`}
						</span>
					</span>
					<span className="truncate text-xs text-silt">
						{worker.online
							? `${worker.availableModels.length} ${worker.availableModels.length === 1 ? "model" : "models"} · ${loaded} loaded`
							: `Last seen ${formatAgo(worker.lastSeenAt)} ago`}
					</span>
				</span>
				<span className="flex w-[92px] flex-col gap-1.5">
					<span aria-hidden="true" className="flex gap-[3px]">
						{Array.from({ length: Math.min(maxSlots, 8) }, (_, i) => (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: slot positions
								key={i}
								className={`h-3.5 flex-1 rounded-xs border ${
									worker.online && i < worker.inFlight
										? "border-lumen bg-lumen"
										: worker.online
											? "border-line-strong"
											: "border-line"
								}`}
							/>
						))}
					</span>
					<span className="font-mono text-[11px] text-silt">
						{worker.online ? `${worker.inFlight} / ${maxSlots} busy` : `0 / ${maxSlots || "—"}`}
					</span>
				</span>
				<span className="flex w-28 flex-col gap-1.5">
					<Sparkline values={days.map((d) => d.promptTokens + d.completionTokens)} height={22} />
					<span className="font-mono text-[11px] text-silt">
						{formatNumber(tokens)} tok · {SERIES_DAYS}d
					</span>
				</span>
				<span className="flex w-[84px] flex-col gap-1">
					<span className="font-mono text-[15px] text-foam tabular-nums">
						{jobs.toLocaleString("en-US")}
					</span>
					<span className="font-mono text-[11px] text-silt">jobs · {SERIES_DAYS}d</span>
				</span>
				<span className="flex w-[84px] flex-col gap-1">
					<span className="font-mono text-[15px] text-foam tabular-nums">
						{worker.online && worker.connectedMs !== null
							? formatDuration(worker.connectedMs)
							: "—"}
					</span>
					<span className="font-mono text-[11px] text-silt">
						{worker.online ? "connected" : "socket closed"}
					</span>
				</span>
				<ChevronIcon open={expanded} />
			</button>
			{expanded ? (
				<WorkerDetails worker={worker} />
			) : (
				worker.availableModels.length > 0 && (
					<div className="flex flex-wrap gap-1.5 px-[18px] pb-4">
						{worker.availableModels.map((m) => (
							<ModelTag key={m.id} model={m} hot={worker.loadedModels.includes(m.id)} />
						))}
					</div>
				)
			)}
		</article>
	);
}

function ModelTag({ model, hot }: { model: WorkerModel; hot: boolean }) {
	return (
		<span
			className={`inline-flex h-6 items-center gap-1.5 rounded-xs border px-2 font-mono text-[11.5px] ${
				hot ? "border-lumen/40 bg-lumen/6 text-foam" : "border-line text-mist"
			}`}
		>
			<span className="text-mist">
				<KindIcon purpose={model.purpose} size={12} />
			</span>
			{model.id}
			{hot && <span className="text-lumen">hot</span>}
		</span>
	);
}

const MODEL_COLUMNS = "minmax(0,2.2fr) 110px 140px 96px";

function WorkerDetails({ worker }: { worker: WorkerInfo }) {
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState(worker.name ?? "");
	const { workers: workersCollection } = useCollections();

	const rename = () => {
		const next = draft.trim() || null;
		setRenaming(false);
		if (next === worker.name) return;
		workersCollection.update(worker.workerId, (w) => {
			w.name = next;
		});
	};

	return (
		<div className="border-t border-line bg-trench">
			{worker.availableModels.length > 0 && (
				<div className="overflow-x-auto">
					<div className="min-w-[560px]">
						<TableHead columns={MODEL_COLUMNS}>
							<span>Model</span>
							<span>Kind</span>
							<span>Can</span>
							<span className="text-right">State</span>
						</TableHead>
						{worker.availableModels.map((m) => (
							<ModelLine key={m.id} model={m} hot={worker.loadedModels.includes(m.id)} />
						))}
					</div>
				</div>
			)}
			<div className="flex flex-wrap items-center gap-2.5 px-[18px] py-3.5">
				{renaming ? (
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							rename();
						}}
					>
						<label htmlFor={`rename-${worker.workerId}`} className="sr-only">
							Worker name
						</label>
						<input
							id={`rename-${worker.workerId}`}
							// biome-ignore lint/a11y/noAutofocus: opened by an explicit Rename click
							autoFocus
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
							placeholder={worker.workerId.slice(0, 8)}
							className="h-8 rounded-sm border border-input bg-abyss px-2.5 font-mono text-[13px] text-foam"
						/>
						<Button type="submit" size="sm">
							Save
						</Button>
					</form>
				) : (
					<span className="font-mono text-[11px] text-silt">
						id {worker.workerId.slice(0, 8)} ·{" "}
						{worker.online && worker.connectedMs !== null
							? `connected ${formatDuration(worker.connectedMs)} ago`
							: `last seen ${formatAgo(worker.lastSeenAt)} ago`}
					</span>
				)}
				<div className="grow" />
				<Button asChild variant="secondary" size="sm">
					<Link to="/workers/$workerId" params={{ workerId: worker.workerId }}>
						Usage
					</Link>
				</Button>
				{!renaming && (
					<Button
						variant="secondary"
						size="sm"
						onClick={() => {
							setDraft(worker.name ?? "");
							setRenaming(true);
						}}
					>
						Rename
					</Button>
				)}
				<DeleteWorkerDialog worker={worker} />
			</div>
		</div>
	);
}

function ModelLine({ model, hot }: { model: WorkerModel; hot: boolean }) {
	const capability = (show: boolean, label: string, icon: React.ReactNode) =>
		show && (
			<span className="inline-flex h-5 items-center gap-1 rounded-xs border border-line-strong px-1.5 text-[11px] text-mist">
				{icon}
				{label}
			</span>
		);
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
				<KindIcon purpose={model.purpose} />
				{model.purpose ? KIND_LABEL[model.purpose as ModelPurpose] : "unknown"}
			</span>
			<span className="flex gap-1.5">
				{capability(model.capabilities?.includes("tools") ?? false, "tools", <ToolsIcon />)}
				{capability(model.capabilities?.includes("vision") ?? false, "vision", <VisionIcon />)}
				{capability(model.capabilities?.includes("thinking") ?? false, "thinking", null)}
			</span>
			<span className={`text-right text-xs ${hot ? "text-lumen" : "text-silt"}`}>
				{hot ? "● hot" : "cold"}
			</span>
		</div>
	);
}

function DeleteWorkerDialog({ worker }: { worker: WorkerInfo }) {
	const [open, setOpen] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const { workers: workersCollection } = useCollections();

	const handleDelete = async () => {
		setSubmitting(true);
		try {
			await workersCollection.delete(worker.workerId).isPersisted.promise;
			setOpen(false);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !submitting && setOpen(next)}>
			<DialogTrigger asChild>
				<Button variant="destructive" size="sm">
					Delete
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete worker "{workerLabel(worker.workerId, worker.name)}"?</DialogTitle>
					<DialogDescription>
						{worker.online
							? "This worker is online. Deleting it disconnects the session and permanently removes its usage history for this organization."
							: "This permanently removes the worker registration and its usage history for this organization."}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={handleDelete} disabled={submitting}>
						{submitting ? "Deleting…" : "Delete worker"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** First run: no worker has ever connected. */
function FirstFish({ serverWsUrl }: { serverWsUrl: string }) {
	return (
		<main className="px-5 pt-14 pb-[72px] sm:px-10">
			<div className="mx-auto flex max-w-[800px] flex-col gap-8">
				<div className="rise-in flex flex-col gap-3">
					<span className="font-mono text-xs tracking-[0.08em] text-lumen uppercase">
						Workers · 0 connected
					</span>
					<h1 className="font-mono text-[44px] leading-[1.08] font-medium tracking-[-0.03em] text-foam">
						The router is up.
						<br />
						It needs a school.
					</h1>
					<p className="max-w-[600px] text-base leading-relaxed text-mist">
						A worker runs next to a model backend and dials out to this server over a
						WebSocket, so laptops behind NAT and boxes on other networks join without
						opening a port.
					</p>
				</div>
				<ConnectSteps serverWsUrl={serverWsUrl} />
				<div className="flex items-center gap-3 rounded-sm border border-line bg-trench px-4 py-3.5 font-mono text-[12.5px] text-mist">
					<span aria-hidden="true" className="live-pulse size-2 shrink-0 rounded-full bg-lumen" />
					<span className="min-w-0">
						Listening on <span className="text-foam">{serverWsUrl}</span>. This page updates the
						moment the first worker connects.
					</span>
				</div>
			</div>
		</main>
	);
}

function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatAgo(epochMs: number): string {
	return formatDuration(Math.max(0, Date.now() - epochMs));
}
