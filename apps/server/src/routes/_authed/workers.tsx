import { useLiveQuery } from "@tanstack/react-db";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, createFileRoute, Link } from "@tanstack/react-router";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { ModelChip } from "../../components/ModelChip";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "../../components/ui/dialog";
import { workersCollection } from "../../lib/collections";
import { serverConfigQuery } from "../../lib/queries";
import type { WorkerInfo } from "../../server/functions/workers";

export const Route = createFileRoute("/_authed/workers")({
	loader: ({ context: { queryClient } }) =>
		queryClient.ensureQueryData(serverConfigQuery()),
	component: Workers,
});

function Workers() {
	const { data: config } = useSuspenseQuery(serverConfigQuery());
	const retentionLabel = `last ${config.usageRetentionDays}d`;

	return (
		<main className="page-wrap px-4 pb-8 pt-10">
			<ClientOnly fallback={<WorkersHeader onlineCount={0} total={0} />}>
				<WorkersLive retentionLabel={retentionLabel} />
			</ClientOnly>
			<ConnectWorkerSection serverWsUrl={config.serverWsUrl} />
		</main>
	);
}

function WorkersHeader({
	onlineCount,
	total,
}: {
	onlineCount: number;
	total: number;
}) {
	return (
		<header className="rise-in mb-8 flex flex-wrap items-start justify-between gap-4">
			<div>
				<h1 className="display-title text-3xl text-[var(--sea-ink)] sm:text-4xl">
					Workers
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					{onlineCount} online · {total} total · serving inference requests for
					this organization
				</p>
			</div>
		</header>
	);
}

function WorkersLive({ retentionLabel }: { retentionLabel: string }) {
	const { data: workers, isLoading } = useLiveQuery((q) =>
		q
			.from({ worker: workersCollection })
			.orderBy(({ worker }) => worker.lastSeenAt, "desc"),
	);

	const list: WorkerInfo[] = workers ?? [];
	const onlineCount = list.filter((w) => w.online).length;

	return (
		<>
			<WorkersHeader onlineCount={onlineCount} total={list.length} />
			{isLoading ? null : list.length === 0 ? (
				<section className="island-shell rounded-sm p-6 text-center">
					<p className="text-[var(--sea-ink-soft)]">
						No workers have connected yet.
					</p>
				</section>
			) : (
				<section className="grid gap-4">
					{list.map((worker) => (
						<WorkerCard
							key={worker.workerId}
							worker={worker}
							retentionLabel={retentionLabel}
						/>
					))}
				</section>
			)}
		</>
	);
}

function ConnectWorkerSection({ serverWsUrl }: { serverWsUrl: string }) {
	const command = `npx @shoal.sh/cli worker start \\\n  --server ${serverWsUrl} \\\n  --token sk_...`;
	return (
		<section className="island-shell mt-8 rounded-sm p-6">
			<p className="island-kicker mb-3">Connect a worker</p>
			<ol className="space-y-3 text-sm text-[var(--sea-ink-soft)]">
				<li>
					<span className="font-mono text-xs font-semibold text-[var(--sea-ink)]">
						1.
					</span>{" "}
					Create an API key on the{" "}
					<Link to="/api-keys" className="text-link">
						API keys
					</Link>{" "}
					page.
				</li>
				<li>
					<span className="font-mono text-xs font-semibold text-[var(--sea-ink)]">
						2.
					</span>{" "}
					Start an inference backend the worker can reach. Defaults to Ollama at{" "}
					<code className="rounded-sm bg-[var(--surface-strong)] px-1 py-0.5 font-mono text-xs text-[var(--sea-ink)]">
						http://localhost:11434
					</code>
					; pass{" "}
					<code className="rounded-sm bg-[var(--surface-strong)] px-1 py-0.5 font-mono text-xs text-[var(--sea-ink)]">
						--backend
					</code>{" "}
					to point elsewhere.
				</li>
				<li>
					<span className="font-mono text-xs font-semibold text-[var(--sea-ink)]">
						3.
					</span>{" "}
					Run the worker pointing at this server:
					<pre className="mt-2 min-w-0 overflow-x-auto rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] p-4 text-xs leading-6 text-[var(--sea-ink)]">
						<code className="font-mono">{command}</code>
					</pre>
				</li>
			</ol>
			<p className="mt-4 text-xs text-[var(--sea-ink-soft)]">
				Hosts without Node? Grab the{" "}
				<code className="rounded-sm bg-[var(--surface-strong)] px-1 py-0.5 font-mono text-xs text-[var(--sea-ink)]">
					shoal
				</code>{" "}
				binary from{" "}
				<a
					href="https://github.com/nitrictech/shoal/releases"
					className="text-link"
				>
					GitHub Releases
				</a>
				.
			</p>
		</section>
	);
}

function WorkerCard({
	worker,
	retentionLabel,
}: {
	worker: WorkerInfo;
	retentionLabel: string;
}) {
	const [editingName, setEditingName] = useState(false);
	const [draftName, setDraftName] = useState(worker.name ?? "");

	const busy = worker.online && worker.inFlight > 0;
	const dotClass = !worker.online
		? "bg-[var(--sea-ink-soft)]/40"
		: busy
			? "bg-amber-400"
			: "bg-[linear-gradient(90deg,#56c6be,#7ed3bf)]";

	const headline = worker.name?.trim() || worker.workerId.slice(0, 8);

	const totalTokens = worker.totalPromptTokens + worker.totalCompletionTokens;

	const submitName = () => {
		const trimmed = draftName.trim();
		const next = trimmed.length > 0 ? trimmed : null;
		setEditingName(false);
		if (next === worker.name) return;
		workersCollection.update(worker.workerId, (draft) => {
			draft.name = next;
		});
	};

	return (
		<article
			className={`island-shell rise-in rounded-sm p-6 ${
				worker.online ? "" : "opacity-70"
			}`}
		>
			<div className="mb-4 flex items-center justify-between gap-4">
				<div className="flex min-w-0 items-center gap-3">
					<span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass}`} />
					{editingName ? (
						<input
							ref={(el) => el?.focus()}
							value={draftName}
							onChange={(e) => setDraftName(e.target.value)}
							onBlur={submitName}
							onKeyDown={(e) => {
								if (e.key === "Enter") submitName();
								if (e.key === "Escape") setEditingName(false);
							}}
							className="min-w-0 rounded-sm border border-[var(--line)] bg-transparent px-2 py-0.5 text-base font-semibold text-[var(--sea-ink)]"
							placeholder={worker.workerId.slice(0, 8)}
						/>
					) : (
						<div className="group flex min-w-0 items-center gap-1.5">
							<Link
								to="/workers/$workerId"
								params={{ workerId: worker.workerId }}
								className="min-w-0 truncate text-base font-semibold text-[var(--sea-ink)] hover:underline"
							>
								{headline}
							</Link>
							<button
								type="button"
								onClick={() => {
									setDraftName(worker.name ?? "");
									setEditingName(true);
								}}
								className="rounded-sm p-0.5 opacity-0 transition group-hover:opacity-60 hover:bg-[var(--chip-bg)]"
								title="Rename worker"
								aria-label="Rename worker"
							>
								<Pencil className="size-3.5" />
							</button>
						</div>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<span
						className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
							!worker.online
								? "border-[var(--line)] bg-[var(--chip-bg)] text-[var(--sea-ink-soft)]"
								: busy
									? "border-amber-500/30 bg-amber-500/10 text-amber-300"
									: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
						}`}
					>
						{worker.online
							? `${worker.inFlight} / ${worker.maxConcurrent}`
							: "offline"}
					</span>
					<DeleteWorkerDialog worker={worker} />
				</div>
			</div>

			<div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
				<Detail
					label={`Jobs (${retentionLabel})`}
					value={String(worker.totalJobs)}
				/>
				<Detail
					label={`Tokens (${retentionLabel})`}
					value={formatNumber(totalTokens)}
				/>
				<Detail
					label={worker.online ? "Connected" : "Last Seen"}
					value={
						worker.online
							? formatDuration(worker.connectedMs ?? 0)
							: `${formatDuration(Date.now() - worker.lastSeenAt)} ago`
					}
				/>
				<Detail label="Loaded Model" value={worker.loadedModel ?? "—"} />
			</div>

			{worker.online && worker.availableModels.length > 0 && (
				<div className="mt-4 border-t border-[var(--line)] pt-4">
					<p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--sea-ink-soft)]">
						Available Models
					</p>
					<div className="flex flex-wrap gap-1.5">
						{worker.availableModels.map((model) => (
							<ModelChip key={model.id} model={model} size="sm" />
						))}
					</div>
				</div>
			)}
		</article>
	);
}

function DeleteWorkerDialog({ worker }: { worker: WorkerInfo }) {
	const [open, setOpen] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	const label = worker.name?.trim() || worker.workerId.slice(0, 8);

	const handleDelete = async () => {
		setSubmitting(true);
		try {
			const tx = workersCollection.delete(worker.workerId);
			await tx.isPersisted.promise;
			setOpen(false);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !submitting && setOpen(next)}>
			<DialogTrigger asChild>
				<button
					type="button"
					className="rounded-sm p-1 text-[var(--sea-ink-soft)] transition hover:bg-[var(--chip-bg)] hover:text-red-400"
					title="Delete worker"
					aria-label="Delete worker"
				>
					<Trash2 className="size-3.5" />
				</button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete worker "{label}"?</DialogTitle>
					<DialogDescription>
						{worker.online
							? "This worker is currently online. Deleting it will disconnect the active session and permanently remove its usage history for this organization."
							: "This permanently removes the worker registration and its usage history for this organization."}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<button
						type="button"
						onClick={() => setOpen(false)}
						disabled={submitting}
						className="rounded-sm border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--sea-ink-soft)] hover:bg-[var(--surface)] disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleDelete}
						disabled={submitting}
						className="rounded-sm border border-red-500/40 bg-red-500/10 px-4 py-1.5 text-sm font-semibold text-red-300 hover:bg-red-500/20 disabled:opacity-50"
					>
						{submitting ? "Deleting..." : "Delete worker"}
					</button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<span className="text-[var(--sea-ink-soft)]">{label}: </span>
			<span className="font-medium text-[var(--sea-ink)]">{value}</span>
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
