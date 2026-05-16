import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { workerCountsSnapshotQuery } from "../../lib/queries";

export const Route = createFileRoute("/_authed/images")({
	loader: ({ context: { queryClient } }) =>
		queryClient.ensureQueryData(workerCountsSnapshotQuery("image")),
	component: Images,
});

interface GeneratedImage {
	id: string;
	b64?: string;
	url?: string;
	revisedPrompt?: string;
}

type Quality = "" | "standard" | "hd";
type Style = "" | "vivid" | "natural";
type ResponseFormat = "b64_json" | "url";

const DIMENSIONS = ["256", "512", "768", "1024", "1536", "1792"] as const;

function Images() {
	const { data } = useSuspenseQuery(workerCountsSnapshotQuery("image"));
	const [model, setModel] = useState(data.models[0] ?? "");
	const [prompt, setPrompt] = useState("");
	const [width, setWidth] = useState("");
	const [height, setHeight] = useState("");
	const [n, setN] = useState("1");
	const [quality, setQuality] = useState<Quality>("");
	const [style, setStyle] = useState<Style>("");
	// Default to b64_json so the inline preview always works without depending
	// on the backend serving a browser-reachable URL. The user can switch to
	// "url" if their backend returns hosted URLs.
	const [responseFormat, setResponseFormat] = useState<ResponseFormat>("b64_json");
	const [status, setStatus] = useState<"idle" | "submitting">("idle");
	const [error, setError] = useState<string | null>(null);
	const [images, setImages] = useState<GeneratedImage[]>([]);
	const abortRef = useRef<AbortController | null>(null);

	const submit = async () => {
		if (status === "submitting" || !model || !prompt.trim()) return;

		const body: Record<string, unknown> = {
			model,
			prompt: prompt.trim(),
			response_format: responseFormat,
		};
		// Only forward `size` when both dimensions are set — partial selections
		// would force a silent default on one axis.
		if (width && height) body.size = `${width}x${height}`;
		const nValue = Number(n);
		if (Number.isFinite(nValue) && nValue > 0) body.n = nValue;
		if (quality) body.quality = quality;
		if (style) body.style = style;

		setError(null);
		setImages([]);
		setStatus("submitting");
		const ctrl = new AbortController();
		abortRef.current = ctrl;

		try {
			const res = await fetch("/api/v1/images/generations", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify(body),
				signal: ctrl.signal,
			});
			const text = await res.text();
			if (!res.ok) {
				// Surface whatever the server sent — no silent rewriting.
				setError(`${res.status} ${res.statusText}: ${text}`);
				return;
			}
			const json = JSON.parse(text) as {
				data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
			};
			const list = (json.data ?? []).map((d) => ({
				id: crypto.randomUUID(),
				b64: d.b64_json,
				url: d.url,
				revisedPrompt: d.revised_prompt,
			}));
			setImages(list);
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
			<ImagesHeader data={data} model={model} setModel={setModel} />

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
						<Field label="Prompt" htmlFor="img-prompt">
							<textarea
								id="img-prompt"
								value={prompt}
								onChange={(e) => setPrompt(e.target.value)}
								placeholder="A koi swimming through a coral reef at dusk, soft volumetric light"
								rows={4}
								disabled={busy}
								className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--sea-ink)] placeholder:text-[var(--sea-ink-soft)] focus:border-[var(--lagoon)] focus:outline-none"
							/>
						</Field>

						<div className="grid grid-cols-2 gap-3">
							<Field label="Width" htmlFor="img-width">
								<DimensionSelect
									id="img-width"
									value={width}
									onChange={setWidth}
									disabled={busy}
								/>
							</Field>
							<Field label="Height" htmlFor="img-height">
								<DimensionSelect
									id="img-height"
									value={height}
									onChange={setHeight}
									disabled={busy}
								/>
							</Field>
							<Field label="N" htmlFor="img-n">
								<input
									id="img-n"
									type="number"
									min={1}
									max={10}
									value={n}
									onChange={(e) => setN(e.target.value)}
									disabled={busy}
									className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-sm text-[var(--sea-ink)] focus:border-[var(--lagoon)] focus:outline-none"
								/>
							</Field>
							<Field label="Quality" htmlFor="img-quality">
								<select
									id="img-quality"
									value={quality}
									onChange={(e) => setQuality(e.target.value as Quality)}
									disabled={busy}
									className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-sm text-[var(--sea-ink)] focus:border-[var(--lagoon)] focus:outline-none"
								>
									<option value="">(default)</option>
									<option value="standard">standard</option>
									<option value="hd">hd</option>
								</select>
							</Field>
							<Field label="Style" htmlFor="img-style">
								<select
									id="img-style"
									value={style}
									onChange={(e) => setStyle(e.target.value as Style)}
									disabled={busy}
									className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-sm text-[var(--sea-ink)] focus:border-[var(--lagoon)] focus:outline-none"
								>
									<option value="">(default)</option>
									<option value="vivid">vivid</option>
									<option value="natural">natural</option>
								</select>
							</Field>
							<Field label="Response format" htmlFor="img-response-format">
								<select
									id="img-response-format"
									value={responseFormat}
									onChange={(e) => setResponseFormat(e.target.value as ResponseFormat)}
									disabled={busy}
									className="col-span-2 w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-sm text-[var(--sea-ink)] focus:border-[var(--lagoon)] focus:outline-none"
								>
									<option value="b64_json">b64_json</option>
									<option value="url">url</option>
								</select>
							</Field>
						</div>

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
									disabled={!model || !prompt.trim()}
									className="flex-1 rounded-sm border border-[var(--lagoon-line)] bg-[var(--lagoon-soft)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[var(--lagoon-line)] disabled:opacity-50 disabled:hover:translate-y-0"
								>
									Generate
								</button>
							)}
						</div>
					</form>

					<div className="island-shell flex flex-1 flex-col rounded-sm p-4">
						<ResultsPane busy={busy} error={error} images={images} />
					</div>
				</div>
			)}
		</main>
	);
}

function DimensionSelect({
	id,
	value,
	onChange,
	disabled,
}: {
	id: string;
	value: string;
	onChange: (v: string) => void;
	disabled: boolean;
}) {
	return (
		<select
			id={id}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			disabled={disabled}
			className="w-full rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-sm text-[var(--sea-ink)] focus:border-[var(--lagoon)] focus:outline-none"
		>
			<option value="">(default)</option>
			{DIMENSIONS.map((d) => (
				<option key={d} value={d}>
					{d}
				</option>
			))}
		</select>
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
	images,
}: {
	busy: boolean;
	error: string | null;
	images: GeneratedImage[];
}) {
	if (error) {
		return (
			<div className="rounded-sm bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
				<pre className="m-0 whitespace-pre-wrap font-mono text-xs">{error}</pre>
			</div>
		);
	}
	if (busy && images.length === 0) {
		return (
			<div className="flex flex-1 items-center justify-center text-sm text-[var(--sea-ink-soft)]">
				Generating…
			</div>
		);
	}
	if (images.length === 0) {
		return (
			<div className="flex flex-1 items-center justify-center text-sm text-[var(--sea-ink-soft)]">
				Output will appear here.
			</div>
		);
	}
	return (
		<div className="grid gap-4 sm:grid-cols-2">
			{images.map((img) => (
				<ImageCard key={img.id} image={img} />
			))}
		</div>
	);
}

function ImageCard({ image }: { image: GeneratedImage }) {
	const src = image.b64
		? `data:image/png;base64,${image.b64}`
		: image.url;
	return (
		<div className="flex flex-col gap-2 rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] p-2">
			{src ? (
				<img
					src={src}
					alt=""
					className="h-auto w-full rounded-sm"
				/>
			) : (
				<div className="flex aspect-square items-center justify-center text-xs text-[var(--sea-ink-soft)]">
					No image data
				</div>
			)}
			{image.revisedPrompt && (
				<p className="text-xs italic text-[var(--sea-ink-soft)]">
					{image.revisedPrompt}
				</p>
			)}
		</div>
	);
}

function NoWorkersEmpty() {
	return (
		<div className="max-w-md text-center">
			<p className="island-kicker mb-3">No models available</p>
			<p className="text-sm text-[var(--sea-ink-soft)]">
				At least one worker needs to be connected to generate images. Head to the{" "}
				<Link to="/workers" className="text-link">
					workers page
				</Link>{" "}
				for instructions on connecting one.
			</p>
		</div>
	);
}

function ImagesHeader({
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
					Images
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					Test image generation against connected workers
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
