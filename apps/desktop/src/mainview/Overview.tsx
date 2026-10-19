import { FitNumber } from "@shoal/ui/components/FitNumber";
import { TextMorph } from "@shoal/ui/components/TextMorph";
import { type ReactNode, useRef, useState } from "react";
import { elapsed, isPaused, statusLabel } from "../shared/format";
import type { Availability, RunningJob, WorkerState } from "../shared/rpc";
import { rpc } from "./rpc";
import {
	Body,
	Card,
	Chip,
	Dot,
	statusTone,
	describeModel,
	Empty,
	Row,
	SectionTitle,
	Sparkline,
	TASK_NAME,
	TONE_COLOR,
	type Tone,
	useNow,
} from "./ui";

const PAUSES = [
	[10, "10 min"],
	[30, "30 min"],
	[60, "1 hour"],
	[180, "3 hours"],
	[480, "8 hours"],
] as const;
/** Models shown here before "All models". */
const MODELS_SHOWN = 5;
/** One per second; the sparkline's width. */
const RATE_SAMPLES = 30;

const setAvailability = (next: Availability) => void rpc.request.setAvailability(next);

export function Overview({ state, onShowModels }: { state: WorkerState; onShowModels: () => void }) {
	const now = useNow();
	const [choosingPause, setChoosingPause] = useState(false);
	const rates = useJobRates(state.jobs, now);

	return (
		<Body>
			<Banner state={state} now={now} choosingPause={choosingPause} onTogglePause={() => setChoosingPause((c) => !c)} onChoose={() => setChoosingPause(false)} />
			{choosingPause && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="mr-1 text-sm text-mist">
						{isPaused(state.availability) ? "Pause instead for" : "Pause for"}
					</span>
					{PAUSES.map(([minutes, label]) => (
						<button
							key={minutes}
							type="button"
							onClick={() => {
								setChoosingPause(false);
								setAvailability({ pausedUntil: Date.now() + minutes * 60_000 });
							}}
							className="rounded-full border border-line-strong bg-shelf px-3 py-1 text-sm hover:border-lumen"
						>
							{label}
						</button>
					))}
				</div>
			)}
			<Stats state={state} />
			<Running jobs={state.jobs} rates={rates} now={now} />
			<ModelSummary state={state} onShowModels={onShowModels} />
		</Body>
	);
}

function Banner({
	state,
	now,
	choosingPause,
	onTogglePause,
	onChoose,
}: {
	state: WorkerState;
	now: number;
	choosingPause: boolean;
	onTogglePause: () => void;
	onChoose: () => void;
}) {
	const online = state.status === "online";
	const tone = statusTone(state.status);
	const title = online ? "Accepting work" : statusLabel(state);
	const detail = online
		? `Connected for ${elapsed(now - (state.onlineSince ?? now))} · ${state.jobs.length} of ${state.concurrency} slots busy`
		: state.detail;
	const segment = (label: string, active: boolean, onClick: () => void) => (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className="h-[30px] rounded-[7px] px-3.5 text-[13px] text-mist hover:text-foam aria-pressed:bg-lumen aria-pressed:font-semibold aria-pressed:text-lumen-ink"
		>
			{label}
		</button>
	);
	return (
		<section
			className={`flex items-center justify-between gap-5 rounded-xl border px-[22px] py-5 ${online ? "border-lumen-edge bg-lumen-wash" : "border-line bg-shelf"}`}
		>
			<div className="flex min-w-0 items-center gap-4">
				<span
					className="size-3 flex-none rounded-full"
					style={{ background: TONE_COLOR[tone], boxShadow: online ? "0 0 0 5px var(--signal-lumen-wash)" : undefined }}
				/>
				<div className="flex min-w-0 flex-col gap-1">
					<div className="text-[22px] font-semibold tracking-[-0.02em]">{title}</div>
					{detail && <div className="text-[13px] text-mist">{detail}</div>}
				</div>
			</div>
			<div role="group" aria-label="Availability" className="flex flex-none gap-0.5 rounded-[9px] border border-line bg-trench p-[3px]">
				{segment("On", state.availability === "on", () => {
					onChoose();
					setAvailability("on");
				})}
				{segment(choosingPause ? "Pause ▴" : "Pause ▾", isPaused(state.availability), onTogglePause)}
				{segment("Off", state.availability === "off", () => {
					onChoose();
					setAvailability("off");
				})}
			</div>
		</section>
	);
}

function Stats({ state }: { state: WorkerState }) {
	const models = new Set(state.backends.flatMap((b) => b.models.map((m) => m.id)));
	const loaded = new Set(state.backends.flatMap((b) => b.loaded));
	const stat = (label: string, value: ReactNode, of?: number) => (
		<div className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-shelf px-4 py-3.5">
			<span className="text-xs text-silt">{label}</span>
			<span className="flex min-w-0 items-baseline font-mono text-[22px]">
				{value}
				{of !== undefined && <span className="text-[15px] text-silt">/{of}</span>}
			</span>
		</div>
	);
	return (
		<section className="grid grid-cols-4 gap-3">
			{stat("Running", <TextMorph as="span">{state.jobs.length}</TextMorph>, state.concurrency)}
			{stat("Completed", <FitNumber value={state.jobsCompleted} className="flex-1" />)}
			{stat(
				"Tokens out",
				// Running jobs' streamed tokens too, so the count moves while they stream.
				<FitNumber value={state.tokensOut + state.jobs.reduce((sum, job) => sum + job.tokens, 0)} className="flex-1" />,
			)}
			{stat("Models loaded", <TextMorph as="span">{loaded.size}</TextMorph>, models.size)}
		</section>
	);
}

/** Tokens per second for each running job, sampled once a second. */
const useJobRates = (jobs: ReadonlyArray<RunningJob>, now: number) => {
	const seen = useRef(new Map<string, { at: number; tokens: number; samples: Array<number> }>());
	const sampledAt = useRef(0);
	if (now !== sampledAt.current) {
		sampledAt.current = now;
		const next = new Map<string, { at: number; tokens: number; samples: Array<number> }>();
		for (const job of jobs) {
			const last = seen.current.get(job.id) ?? { at: job.startedAt, tokens: 0, samples: [] };
			const seconds = (now - last.at) / 1000;
			const samples = seconds > 0 ? [...last.samples, (job.tokens - last.tokens) / seconds].slice(-RATE_SAMPLES) : last.samples;
			next.set(job.id, { at: now, tokens: job.tokens, samples });
		}
		seen.current = next;
	}
	return seen.current;
};

function Running({
	jobs,
	rates,
	now,
}: {
	jobs: ReadonlyArray<RunningJob>;
	rates: ReturnType<typeof useJobRates>;
	now: number;
}) {
	return (
		<section className="flex flex-col gap-2.5">
			<SectionTitle>Running now</SectionTitle>
			{jobs.length === 0 ? (
				<Empty>No jobs running. They appear here as the server sends them.</Empty>
			) : (
				<Card>
					{jobs.map((job) => {
						const samples = rates.get(job.id)?.samples ?? [];
						const recent = samples.slice(-5);
						const speed = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
						const tone: Tone = job.thinking ? "amber" : "lumen";
						return (
							<Row key={job.id} className="py-3.5">
								<div className="flex min-w-0 flex-1 flex-col gap-1.5">
									<div className="flex items-center gap-2">
										<span className="truncate font-mono text-sm">{job.model}</span>
										<Chip tone={job.thinking ? "amber" : "current"}>{job.thinking ? "thinking" : TASK_NAME[job.task]}</Chip>
									</div>
									{job.task === "chat" && <Sparkline samples={samples} tone={tone} />}
								</div>
								<span className="flex w-[110px] flex-none gap-1 font-mono text-[13px] text-mist">
									<FitNumber value={job.tokens} className="flex-1 text-right" /> tokens
								</span>
								<span className="w-[100px] flex-none font-mono text-[13px]" style={{ color: TONE_COLOR[tone] }}>
									{speed === null ? "–" : <TextMorph as="span">{`${speed.toFixed(1)} tok/s`}</TextMorph>}
								</span>
								<span className="w-[60px] flex-none text-right font-mono text-[13px] text-silt">{elapsed(now - job.startedAt)}</span>
							</Row>
						);
					})}
				</Card>
			)}
		</section>
	);
}

function ModelSummary({ state, onShowModels }: { state: WorkerState; onShowModels: () => void }) {
	const loaded = new Set(state.backends.flatMap((b) => b.loaded));
	const seen = new Set<string>();
	const models = state.backends
		.flatMap((b) => b.models)
		.filter((m) => !seen.has(m.id) && seen.add(m.id))
		.slice(0, MODELS_SHOWN);
	return (
		<section className="flex flex-col gap-2.5">
			<div className="flex items-baseline justify-between">
				<SectionTitle>Models</SectionTitle>
				<button type="button" onClick={onShowModels} className="text-xs text-lumen">
					All models →
				</button>
			</div>
			{models.length === 0 ? (
				<Empty>No models found yet. Check the backends in Settings.</Empty>
			) : (
				<Card>
					{models.map((model) => {
						const isLoaded = loaded.has(model.id);
						return (
							<Row key={model.id}>
								<Dot tone="lumen" hollow={!isLoaded} />
								<span className="min-w-0 flex-1 truncate font-mono text-[13px]">{model.id}</span>
								<span className="text-xs text-mist">{describeModel(model)}</span>
								<span className={`w-[74px] text-right text-xs ${isLoaded ? "text-lumen" : "text-silt"}`}>
									{isLoaded ? "Loaded" : "Idle"}
								</span>
							</Row>
						);
					})}
				</Card>
			)}
		</section>
	);
}
