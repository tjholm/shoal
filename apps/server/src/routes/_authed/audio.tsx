import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { workerCountsSnapshotQuery } from "../../lib/queries";

export const Route = createFileRoute("/_authed/audio")({
	loader: ({ context: { queryClient } }) =>
		queryClient.ensureQueryData(workerCountsSnapshotQuery("tts")),
	component: Audio,
});

// OpenAI's original six voices. Newer models add more (ash, ballad, coral,
// sage, verse) but these are the most widely supported across OpenAI-compatible
// backends. The "(default)" option leaves the field unset for backends that
// take their own voice names.
const VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
const FORMATS = ["mp3", "opus", "aac", "flac", "wav", "pcm"] as const;

function Audio() {
	const { data } = useSuspenseQuery(workerCountsSnapshotQuery("tts"));
	const [model, setModel] = useState(data.models[0] ?? "");
	const [text, setText] = useState("");
	const [voice, setVoice] = useState<string>("alloy");
	const [format, setFormat] = useState<string>("mp3");
	const [speed, setSpeed] = useState("1");
	const [instructions, setInstructions] = useState("");
	const [status, setStatus] = useState<"idle" | "submitting">("idle");
	const [error, setError] = useState<string | null>(null);
	const [audioUrl, setAudioUrl] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	// Revoke object URLs on unmount / when replaced so we don't leak blobs.
	useEffect(() => {
		return () => {
			if (audioUrl) URL.revokeObjectURL(audioUrl);
		};
	}, [audioUrl]);

	const submit = async () => {
		if (status === "submitting" || !model || !text.trim()) return;

		const body: Record<string, unknown> = {
			model,
			input: text,
			response_format: format,
		};
		if (voice) body.voice = voice;
		const speedValue = Number(speed);
		if (Number.isFinite(speedValue) && speedValue > 0) body.speed = speedValue;
		if (instructions.trim()) body.instructions = instructions.trim();

		setError(null);
		if (audioUrl) URL.revokeObjectURL(audioUrl);
		setAudioUrl(null);
		setStatus("submitting");
		const ctrl = new AbortController();
		abortRef.current = ctrl;

		try {
			const res = await fetch("/api/v1/audio/speech", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify(body),
				signal: ctrl.signal,
			});
			if (!res.ok) {
				// Server uses JSON for errors and binary for success — read text to
				// surface either form verbatim.
				const errText = await res.text();
				setError(`${res.status} ${res.statusText}: ${errText}`);
				return;
			}
			const blob = await res.blob();
			setAudioUrl(URL.createObjectURL(blob));
		} catch (err) {
			if ((err as Error).name === "AbortError") return;
			setError((err as Error).message);
		} finally {
			abortRef.current = null;
			setStatus("idle");
		}
	};

	const cancel = () => abortRef.current?.abort();

	const busy = status === "submitting";

	return (
		<main className="page-wrap flex min-h-[calc(100vh-64px)] flex-col px-4 pb-4 pt-10">
			<AudioHeader data={data} model={model} setModel={setModel} />

			{data.models.length === 0 ? (
				<div className="island-shell flex flex-1 items-center justify-center rounded-sm p-8">
					<NoWorkersEmpty />
				</div>
			) : (
				<div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
					<form
						onSubmit={(e) => {
							e.preventDefault();
							submit();
						}}
						className="island-shell flex flex-col gap-4 rounded-sm p-4"
					>
						<Field label="Text" htmlFor="audio-text">
							<textarea
								id="audio-text"
								value={text}
								onChange={(e) => setText(e.target.value)}
								placeholder="The quick brown fox jumps over the lazy dog."
								rows={5}
								disabled={busy}
								className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--sea-ink)] placeholder:text-[var(--sea-ink-soft)] focus:border-[var(--lagoon)] focus:outline-none"
							/>
						</Field>

						<div className="grid grid-cols-2 gap-3">
							<Field label="Voice" htmlFor="audio-voice">
								<select
									id="audio-voice"
									value={voice}
									onChange={(e) => setVoice(e.target.value)}
									disabled={busy}
									className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-sm text-[var(--sea-ink)] focus:border-[var(--lagoon)] focus:outline-none"
								>
									<option value="">(default)</option>
									{VOICES.map((v) => (
										<option key={v} value={v}>
											{v}
										</option>
									))}
								</select>
							</Field>
							<Field label="Format" htmlFor="audio-format">
								<select
									id="audio-format"
									value={format}
									onChange={(e) => setFormat(e.target.value)}
									disabled={busy}
									className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-sm text-[var(--sea-ink)] focus:border-[var(--lagoon)] focus:outline-none"
								>
									{FORMATS.map((f) => (
										<option key={f} value={f}>
											{f}
										</option>
									))}
								</select>
							</Field>
							<Field label="Speed" htmlFor="audio-speed">
								<input
									id="audio-speed"
									type="number"
									min={0.25}
									max={4}
									step={0.25}
									value={speed}
									onChange={(e) => setSpeed(e.target.value)}
									disabled={busy}
									className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-sm text-[var(--sea-ink)] focus:border-[var(--lagoon)] focus:outline-none"
								/>
							</Field>
						</div>

						<Field label="Instructions (gpt-4o-mini-tts only)" htmlFor="audio-instructions">
							<input
								id="audio-instructions"
								type="text"
								value={instructions}
								onChange={(e) => setInstructions(e.target.value)}
								placeholder="Speak in a calm, reassuring tone"
								disabled={busy}
								className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-sm text-[var(--sea-ink)] placeholder:text-[var(--sea-ink-soft)] focus:border-[var(--lagoon)] focus:outline-none"
							/>
						</Field>

						<div className="flex gap-2">
							{busy ? (
								<button
									type="button"
									onClick={cancel}
									className="flex-1 rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)]"
								>
									Cancel
								</button>
							) : (
								<button
									type="submit"
									disabled={!model || !text.trim()}
									className="flex-1 rounded-sm border border-[var(--lagoon-line)] bg-[var(--lagoon-soft)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[var(--lagoon-line)] disabled:opacity-50 disabled:hover:translate-y-0"
								>
									Synthesize
								</button>
							)}
						</div>
					</form>

					<div className="island-shell flex flex-1 flex-col rounded-sm p-4">
						<ResultsPane busy={busy} error={error} audioUrl={audioUrl} />
					</div>
				</div>
			)}
		</main>
	);
}

function Field({
	label,
	htmlFor,
	children,
}: {
	label: string;
	htmlFor: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5 text-sm">
			<label
				htmlFor={htmlFor}
				className="text-xs font-medium uppercase tracking-wide text-[var(--sea-ink-soft)]"
			>
				{label}
			</label>
			{children}
		</div>
	);
}

function ResultsPane({
	busy,
	error,
	audioUrl,
}: {
	busy: boolean;
	error: string | null;
	audioUrl: string | null;
}) {
	if (error) {
		return (
			<div className="rounded-sm bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
				<pre className="m-0 whitespace-pre-wrap font-mono text-xs">{error}</pre>
			</div>
		);
	}
	if (busy && !audioUrl) {
		return (
			<div className="flex flex-1 items-center justify-center text-sm text-[var(--sea-ink-soft)]">
				Synthesizing…
			</div>
		);
	}
	if (!audioUrl) {
		return (
			<div className="flex flex-1 items-center justify-center text-sm text-[var(--sea-ink-soft)]">
				Output will appear here.
			</div>
		);
	}
	return (
		<div className="flex flex-1 items-center justify-center">
			{/* biome-ignore lint/a11y/useMediaCaption: synthesized speech has no separate caption track */}
			<audio
				src={audioUrl}
				controls
				autoPlay
				className="w-full"
			/>
		</div>
	);
}

function NoWorkersEmpty() {
	return (
		<div className="max-w-md text-center">
			<p className="island-kicker mb-3">No models available</p>
			<p className="text-sm text-[var(--sea-ink-soft)]">
				At least one worker needs to be connected to synthesize speech. Head to the{" "}
				<Link to="/workers" className="text-link">
					workers page
				</Link>{" "}
				for instructions on connecting one.
			</p>
		</div>
	);
}

function AudioHeader({
	data,
	model,
	setModel,
}: {
	data: { models: string[] };
	model: string;
	setModel: (m: string) => void;
}) {
	return (
		<header className="rise-in mb-6 flex flex-wrap items-start justify-between gap-4">
			<div>
				<h1 className="display-title text-3xl text-[var(--sea-ink)] sm:text-4xl">
					Audio
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					Test text-to-speech against connected workers
				</p>
			</div>
			<div className="flex items-center gap-3">
				<label
					htmlFor="model-select"
					className="text-sm font-medium text-[var(--sea-ink-soft)]"
				>
					Model
				</label>
				<select
					id="model-select"
					value={model}
					onChange={(e) => setModel(e.target.value)}
					className="rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-sm text-[var(--sea-ink)]"
				>
					{data.models.length === 0 && (
						<option value="">No models available</option>
					)}
					{data.models.map((m) => (
						<option key={m} value={m}>
							{m}
						</option>
					))}
				</select>
			</div>
		</header>
	);
}
