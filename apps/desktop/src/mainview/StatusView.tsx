import { Button } from "@shoal/ui/components/button";
import { ModelChip } from "@shoal/ui/components/ModelChip";
import { Fact, Section } from "@shoal/ui/components/Page";
import { StatusGlyph, type WorkerStatus } from "@shoal/ui/components/StatusBadge";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import type { BackendState, WorkerState } from "../shared/rpc";
import { rpc } from "./rpc";

const HEADLINE: Record<WorkerState["status"], { title: string; detail: string; glyph: WorkerStatus }> = {
	"not-configured": {
		title: "not set up",
		detail: "Connect this computer to your shoal server to start sharing its models.",
		glyph: "paused",
	},
	connecting: {
		title: "connecting",
		detail: "Reaching your shoal server…",
		glyph: "busy",
	},
	sharing: {
		title: "sharing",
		detail: "Your shoal server can send work to the models on this computer.",
		glyph: "online",
	},
	reconnecting: {
		title: "reconnecting",
		detail: "Can't reach your shoal server. Shoal keeps retrying.",
		glyph: "offline",
	},
	pausing: {
		title: "pausing",
		detail: "Finishing the current jobs, then shoal will stop taking work.",
		glyph: "busy",
	},
	paused: {
		title: "paused",
		detail: "Shoal won't send any work to this computer until you resume.",
		glyph: "paused",
	},
	stopped: {
		title: "stopped",
		detail: "Shoal stopped sharing. Check your settings, then save to try again.",
		glyph: "offline",
	},
};

export function StatusView({ state, onSetUp }: { state: WorkerState; onSetUp: () => void }) {
	const headline = HEADLINE[state.status];
	const configured = state.status !== "not-configured";
	const paused = state.status === "paused" || state.status === "pausing";
	const loadedCount = state.backends.reduce((n, b) => n + b.loaded.length, 0);
	const [error, setError] = useState<string | null>(null);

	const report = (result: Promise<string | null>) => {
		setError(null);
		void result.then(setError);
	};

	return (
		<main className="flex flex-col gap-6 px-5 pt-7 pb-10">
			<div className="rise-in flex flex-col gap-2.5">
				<div className="flex items-center gap-3">
					<StatusGlyph status={headline.glyph} />
					<h1 className="font-mono text-[32px] leading-none font-medium tracking-[-0.03em] text-foam">
						{headline.title}
					</h1>
				</div>
				{configured && state.serverUrl && (
					<p className="flex flex-wrap gap-x-[18px] gap-y-1.5 font-mono text-[13px] text-mist">
						<span>{new URL(state.serverUrl).host}</span>
						<Fact value={state.jobsRunning}>running</Fact>
						<Fact value={loadedCount}>in memory</Fact>
					</p>
				)}
				<p className="text-sm text-mist">{headline.detail}</p>
				{state.detail && <p className="font-mono text-xs text-coral">{state.detail}</p>}
			</div>

			<div className="rise-in flex flex-wrap gap-2">
				{state.status === "not-configured" || state.status === "stopped" ? (
					<Button onClick={onSetUp}>{configured ? "Open settings" : "Set up shoal"}</Button>
				) : (
					<>
						<Button onClick={() => rpc.request.setPaused({ paused: !paused })}>
							{paused ? "Resume sharing" : "Pause sharing"}
						</Button>
						<Button
							variant="outline"
							disabled={loadedCount === 0}
							onClick={() => report(rpc.request.freeMemory())}
						>
							Free up memory
						</Button>
					</>
				)}
			</div>

			{error && (
				<p role="alert" className="text-sm text-coral">
					{error}
				</p>
			)}

			{state.backends.length > 0 && (
				<Section title="Models in memory" caption="Unload a model to give its memory back to this computer.">
					<ul>
						{state.backends.map((backend) => (
							<BackendRow
								key={backend.url}
								backend={backend}
								onUnload={(id) => report(rpc.request.unloadModel({ backend: backend.url, id }))}
							/>
						))}
					</ul>
				</Section>
			)}

			{state.serverUrl && (
				<button
					type="button"
					onClick={() => rpc.request.openWebDashboard()}
					className="text-link inline-flex items-center gap-1.5 self-start text-sm"
				>
					Manage on the web
					<ExternalLink className="size-3.5" aria-hidden="true" />
				</button>
			)}
		</main>
	);
}

function BackendRow({ backend, onUnload }: { backend: BackendState; onUnload: (id: string) => void }) {
	return (
		<li className="border-b border-line px-[18px] py-3 last:border-b-0">
			<p className="mb-2 font-mono text-xs text-silt">{new URL(backend.url).host}</p>
			{!backend.reachable ? (
				<p className="text-sm text-coral">Can't reach this model server.</p>
			) : backend.loaded.length === 0 ? (
				<p className="text-sm text-mist">Nothing loaded.</p>
			) : (
				<ul className="flex flex-col gap-2">
					{backend.loaded.map((id) => (
						<li key={id} className="flex items-center justify-between gap-3">
							<ModelChip model={{ id }} loaded />
							{backend.canUnload ? (
								<Button variant="ghost" size="sm" onClick={() => onUnload(id)}>
									Unload
								</Button>
							) : (
								<span className="text-xs text-silt">Always loaded</span>
							)}
						</li>
					))}
				</ul>
			)}
		</li>
	);
}
