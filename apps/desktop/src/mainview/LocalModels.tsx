import { Button } from "@shoal/ui/components/button";
import { useEffect, useState } from "react";
import { SUGGESTED_MODELS } from "../shared/local-models";
import type { LocalModel, LocalModelsState } from "../shared/rpc";
import { ModelPicker } from "./ModelPicker";
import { rpc } from "./rpc";
import { Card, Chip, Empty, Row, type Tone } from "./ui";

const PHASE: Record<LocalModelsState["phase"], { tone: Tone; label: string }> = {
	off: { tone: "silt", label: "Off" },
	installing: { tone: "amber", label: "Installing" },
	starting: { tone: "amber", label: "Starting" },
	running: { tone: "lumen", label: "Running" },
	failed: { tone: "coral", label: "Failed" },
};

const STATUS_TONE: Record<string, Tone> = {
	loaded: "lumen",
	loading: "amber",
	downloading: "amber",
	incomplete: "coral",
};

// Downloads report progress only through /models/sse; polling the list is enough for status.
const POLL_MS = 1_500;

/** Downloads and removes the models the app's own llama-server runs. */
export function LocalModels({ state }: { state: LocalModelsState }) {
	const [models, setModels] = useState<ReadonlyArray<LocalModel>>([]);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (state.phase !== "running") return;
		let live = true;
		const poll = async () => {
			const next = await rpc.request.listLocalModels().catch((e: Error) => {
				setError(e.message);
				return null;
			});
			if (live && next) setModels(next);
		};
		void poll();
		const timer = setInterval(poll, POLL_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [state.phase]);

	const download = async (repo: string) => setError(await rpc.request.downloadLocalModel({ repo }));

	const phase = PHASE[state.phase];
	const have = new Set(models.map((m) => m.id));
	return (
		<section className="flex flex-col gap-2.5">
			<div className="flex items-center gap-2">
				<span className="text-sm font-medium">On this computer</span>
				<span className="text-xs text-silt">llama.cpp, run by Shoal</span>
				<span className="flex-1" />
				<Chip tone={phase.tone}>{phase.label}</Chip>
			</div>
			{state.detail && (
				<pre className={`m-0 whitespace-pre-wrap text-xs ${state.phase === "failed" ? "text-coral" : "text-mist"}`}>
					{state.detail}
				</pre>
			)}
			{error && (
				<p role="alert" className="m-0 text-sm text-coral">
					{error}
				</p>
			)}
			{state.phase === "running" && (
				<>
					{models.length === 0 ? (
						<Empty>No models downloaded yet.</Empty>
					) : (
						<Card>
							{models.map((model) => (
								<Row key={model.id}>
									<span className="min-w-0 flex-1 truncate font-mono text-[13px]">{model.id}</span>
									<Chip tone={STATUS_TONE[model.status] ?? "silt"}>{model.status}</Chip>
									<Button
										variant="outline"
										size="xs"
										onClick={async () => setError(await rpc.request.deleteLocalModel({ id: model.id }))}
									>
										Delete
									</Button>
								</Row>
							))}
						</Card>
					)}
					<ModelPicker onDownload={download} />
					<div className="flex flex-wrap gap-1.5">
						{SUGGESTED_MODELS.filter((id) => !have.has(id)).map((id) => (
							<Button
								key={id}
								variant="outline"
								size="xs"
								onClick={() => download(id)}
							>
								{id}
							</Button>
						))}
					</div>
				</>
			)}
		</section>
	);
}
