import type { BackendDialect } from "@shoal/client-core/inference";
import type { WorkerModel } from "@shoal/protocol";
import { type ReactNode, useEffect, useState } from "react";
import type { JobTask, WorkerState } from "../shared/rpc";

export type Tone = "lumen" | "amber" | "coral" | "current" | "silt";

const CHIP: Record<Tone, string> = {
	lumen: "border-lumen-edge bg-lumen-wash text-lumen",
	amber: "border-amber-edge bg-amber-wash text-amber",
	coral: "border-coral-edge bg-coral-wash text-coral",
	current: "border-current-edge bg-current-wash text-[var(--signal-current)]",
	silt: "border-line-strong bg-reef text-mist",
};

export const TONE_COLOR: Record<Tone, string> = {
	lumen: "var(--signal-lumen)",
	amber: "var(--signal-amber)",
	coral: "var(--signal-coral)",
	current: "var(--signal-current)",
	silt: "var(--text-tertiary)",
};

export const DIALECT_NAME: Record<BackendDialect, string> = {
	ollama: "Ollama",
	lmstudio: "LM Studio",
	llamacpp: "llama.cpp",
	llamaswap: "llama-swap",
	vllm: "vLLM",
	lemonade: "Lemonade",
};

export const TASK_NAME: Record<JobTask, string> = {
	chat: "chat",
	embedding: "embedding",
	image: "image",
	tts: "speech",
};

/** "chat · tools · thinking", or "" when the backend didn't say. */
export const describeModel = (model: WorkerModel) =>
	[model.purpose === "tts" ? "speech" : model.purpose, ...(model.capabilities ?? [])]
		.filter((part) => part !== undefined)
		.join(" · ");

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
	return (
		<span className={`shrink-0 rounded-full border px-[7px] py-0.5 text-[11px] ${CHIP[tone]}`}>
			{children}
		</span>
	);
}

/** A status light: filled for active, a hollow ring for idle. */
/** The colour that goes with the worker's status, wherever it's shown. */
export const statusTone = (status: WorkerState["status"]): Tone => {
	switch (status) {
		case "online":
			return "lumen";
		case "stopped":
			return "coral";
		case "connecting":
		case "reconnecting":
			return "amber";
		default:
			return "silt";
	}
};

/** One word or two for the worker's status, where there's no room for the full line. */
export const STATUS_WORD: Record<WorkerState["status"], string> = {
	online: "Connected",
	paused: "Paused",
	off: "Off",
	stopped: "Stopped",
	connecting: "Connecting…",
	reconnecting: "Reconnecting…",
	"not-configured": "Not set up",
};

export function Dot({ tone, hollow = false }: { tone: Tone; hollow?: boolean }) {
	return hollow ? (
		<span className="size-2 shrink-0 rounded-full border-[1.5px] border-line-strong" />
	) : (
		<span className="size-2 shrink-0 rounded-full" style={{ background: TONE_COLOR[tone] }} />
	);
}

export function Card({ children }: { children: ReactNode }) {
	return <div className="overflow-hidden rounded-[10px] border border-line bg-shelf">{children}</div>;
}

export function Row({ children, className = "" }: { children: ReactNode; className?: string }) {
	return (
		<div className={`flex items-center gap-3 border-b border-line px-4 py-[11px] last:border-b-0 ${className}`}>
			{children}
		</div>
	);
}

export function Empty({ children }: { children: ReactNode }) {
	return (
		<Card>
			<p className="m-0 px-4 py-4 text-sm text-silt">{children}</p>
		</Card>
	);
}

export function SectionTitle({ children }: { children: ReactNode }) {
	return <h2 className="m-0 text-xs font-medium tracking-[0.08em] text-silt uppercase">{children}</h2>;
}

export function PageTitle({ children }: { children: ReactNode }) {
	return <h1 className="m-0 text-xl font-semibold tracking-[-0.02em]">{children}</h1>;
}

/** A scrolling page body. */
export function Body({ children }: { children: ReactNode }) {
	return <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-[30px] py-[26px]">{children}</div>;
}

export function Sparkline({ samples, tone }: { samples: ReadonlyArray<number>; tone: Tone }) {
	const width = 220;
	const height = 18;
	if (samples.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
	const max = Math.max(...samples, 1);
	const step = width / (samples.length - 1);
	const points = samples.map((v, i) => `${i * step},${height - 2 - (v / max) * (height - 4)}`).join(" ");
	return (
		<svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none" aria-hidden="true">
			<polyline points={points} stroke={TONE_COLOR[tone]} strokeWidth="1.5" strokeLinejoin="round" />
		</svg>
	);
}

/** The current time, updated every `intervalMs`, for running clocks. */
export const useNow = (intervalMs = 1000) => {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
};

export const hostOf = (url: string | null) => (url === null ? "" : new URL(url).host);
