import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { useChat } from "@ai-sdk/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	DirectChatTransport,
	stepCountIs,
	tool,
	ToolLoopAgent,
	type ToolSet,
	type UIMessage,
} from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { workerCountsSnapshotQuery } from "../../lib/queries";

export const Route = createFileRoute("/_authed/chat")({
	loader: ({ context: { queryClient } }) =>
		Promise.all([
			queryClient.ensureQueryData(workerCountsSnapshotQuery("chat")),
			queryClient.ensureQueryData(workerCountsSnapshotQuery("image")),
			queryClient.ensureQueryData(workerCountsSnapshotQuery("tts")),
		]),
	component: Chat,
});

type WireFormat = "openai" | "anthropic";

/**
 * Auth strategy: dashboard session cookie. Same-origin so the browser sends
 * it automatically. The provider SDKs try to inject `Authorization` /
 * `x-api-key` based on their config, which our /api/v1 route would then try
 * (and fail) to verify before falling back to the cookie. Strip those
 * headers in `internalFetch` so the cookie path wins cleanly.
 */
const internalFetch: typeof fetch = (input, init) => {
	const headers = new Headers(init?.headers);
	headers.delete("authorization");
	headers.delete("x-api-key");
	return fetch(input, { ...init, headers, credentials: "same-origin" });
};

/** Output shape returned by media-generation tools (`generate_image`,
 *  `generate_audio`). Kept narrow so ToolCallView can recognize it and render
 *  the payload inline — image vs. audio is dispatched on the mime prefix. */
interface GenerateMediaOutput {
	model: string;
	mimeType: string;
	b64: string;
}

/**
 * Read an OpenAI-compatible SSE stream from /v1/images/generations and return
 * the first completed image's base64 payload. We request `n: 1` and don't ask
 * for `partial_image` events, so a single `image_generation.completed` event
 * is the expected shape; any later events would be duplicates and are ignored
 * once we've returned.
 */
async function readImageStream(res: Response): Promise<string> {
	if (!res.body) {
		throw new Error("image stream response had no body");
	}
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";

	while (true) {
		const { value, done } = await reader.read();
		if (value) buffer += value;

		// Drain every complete \n\n-delimited event currently in the buffer.
		while (true) {
			const split = buffer.indexOf("\n\n");
			if (split === -1) break;
			const eventText = buffer.slice(0, split);
			buffer = buffer.slice(split + 2);

			// SSE comment lines start with `:` (we send `:hb` heartbeats and an
			// `:ok` flush comment). Skip anything that isn't a `data:` line.
			const dataLine = eventText
				.split("\n")
				.find((l) => l.startsWith("data: "));
			if (!dataLine) continue;

			const payload = dataLine.slice("data: ".length);
			if (payload === "[DONE]") {
				throw new Error("image stream ended without a completed event");
			}

			const event = JSON.parse(payload) as {
				type?: string;
				b64_json?: string;
				error?: { message?: string };
			};
			if (event.type === "image_generation.completed") {
				if (!event.b64_json) {
					throw new Error(
						"image generation succeeded but backend returned no b64 payload",
					);
				}
				return event.b64_json;
			}
			if (event.type === "error") {
				throw new Error(event.error?.message ?? "image generation failed");
			}
			// Unknown event types (e.g. future `image_generation.partial_image`
			// once a backend supports it) — keep reading until we see completed.
		}

		if (done) {
			throw new Error("image stream closed before sending a completed event");
		}
	}
}

/** Build a `generate_image` tool that lets the chat model invoke whichever
 *  image-purpose backend is online. The list of usable image models is
 *  encoded as an enum on `model` so the LLM picks per-call. Returns null
 *  when no image models are available — the caller should omit the tool
 *  entirely in that case so the tool schema never claims a capability we
 *  can't actually fulfill. */
function makeGenerateImageTool(imageModels: string[]) {
	if (imageModels.length === 0) return null;
	const [first, ...rest] = imageModels;
	// z.enum requires a non-empty tuple; build it that way explicitly so
	// TypeScript can prove it.
	const modelEnum = z.enum([first, ...rest] as [string, ...string[]]);
	return tool({
		description:
			"Generate an image from a text prompt. Call this when the user asks " +
			"you to make, draw, generate, or visualize an image. Pick the model " +
			"whose id best fits the request, or the first one if they're equivalent.",
		inputSchema: z.object({
			model: modelEnum.describe("Image-generation model id to use."),
			prompt: z
				.string()
				.describe(
					"Concrete description of the image. Include subject, style, " +
						"composition, and notable details.",
				),
			size: z
				.enum(["256x256", "512x512", "1024x1024"])
				.default("512x512")
				.describe("Output dimensions. Use 1024x1024 for higher quality."),
		}),
		execute: async ({ model, prompt, size }): Promise<GenerateMediaOutput> => {
			// Streaming, not because we want progressive renders (the upstream
			// backends shoal proxies don't expose partials), but to get response
			// headers out of the server immediately — that prevents Cloudflare
			// and any other reverse proxy in the path from 524-ing the request
			// on slow models. See packages/server-core/openai.ts
			// streamImageJobAsSSE for the server side.
			const res = await internalFetch(
				`${window.location.origin}/api/v1/images/generations`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model,
						prompt,
						size,
						n: 1,
						response_format: "b64_json",
						stream: true,
					}),
				},
			);
			if (!res.ok) {
				const detail = await res.text();
				throw new Error(`image generation failed (${res.status}): ${detail}`);
			}
			const b64 = await readImageStream(res);
			return { model, mimeType: "image/png", b64 };
		},
	});
}

/** Build a `generate_audio` tool that lets the chat model invoke whichever
 *  tts-purpose backend is online. Voice is a free-form string because voice
 *  vocabularies vary across backends (OpenAI's six voices vs kokoro's named
 *  set). Returns null when no tts models are available. */
function makeGenerateAudioTool(ttsModels: string[]) {
	if (ttsModels.length === 0) return null;
	const [first, ...rest] = ttsModels;
	const modelEnum = z.enum([first, ...rest] as [string, ...string[]]);
	return tool({
		description:
			"Generate spoken audio from text. Call this when the user asks you " +
			"to speak, narrate, read aloud, or produce a voice clip. Pick the " +
			"model whose id best fits the request, or the first one otherwise.",
		inputSchema: z.object({
			model: modelEnum.describe("Text-to-speech model id to use."),
			input: z.string().describe("Text to speak."),
			voice: z
				.string()
				.optional()
				.describe(
					"Voice name. OpenAI-compatible backends accept one of " +
						"alloy / echo / fable / onyx / nova / shimmer; other backends " +
						"(e.g. kokoro) have their own voice catalog. Omit to use the " +
						"backend's default.",
				),
		}),
		execute: async ({ model, input, voice }): Promise<GenerateMediaOutput> => {
			const body: Record<string, unknown> = {
				model,
				input,
				response_format: "mp3",
			};
			if (voice) body.voice = voice;
			const res = await internalFetch(
				`${window.location.origin}/api/v1/audio/speech`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
			);
			if (!res.ok) {
				const detail = await res.text();
				throw new Error(`audio generation failed (${res.status}): ${detail}`);
			}
			// /v1/audio/speech returns raw audio bytes. UIMessage parts are
			// JSON-serializable, so encode to base64 for the tool output.
			const buf = await res.arrayBuffer();
			const b64 = arrayBufferToBase64(buf);
			return { model, mimeType: "audio/mpeg", b64 };
		},
	});
}

/** Base64-encode an ArrayBuffer in a way that works in both the browser and
 *  Bun. `btoa` requires a binary string; we chunk the conversion so a multi-
 *  megabyte audio clip doesn't blow the call stack via spread. */
function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	const chunkSize = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode.apply(
			null,
			bytes.subarray(i, i + chunkSize) as unknown as number[],
		);
	}
	return btoa(binary);
}

function Chat() {
	const { data } = useSuspenseQuery(workerCountsSnapshotQuery("chat"));
	const { data: imageData } = useSuspenseQuery(
		workerCountsSnapshotQuery("image"),
	);
	const { data: ttsData } = useSuspenseQuery(workerCountsSnapshotQuery("tts"));
	const [model, setModel] = useState(data.models[0] ?? "");
	const [format, setFormat] = useState<WireFormat>("openai");
	const [input, setInput] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);

	// Defer agent (and any browser-only logic) until after hydration. The SSR
	// pass and the first client render must produce the same tree — otherwise
	// hydration mismatches in nested router-context hooks tear down the route.
	const [hydrated, setHydrated] = useState(false);
	useEffect(() => setHydrated(true), []);

	// Rebuild the agent whenever the model, wire format, or image-model set
	// change. useChat's transport prop is read at hook-init time, so we also
	// force-remount the hook by keying on these values below. tanstack-query
	// gives us a stable `imageData.models` reference until the snapshot
	// refetches, so depending on it directly doesn't churn the agent.
	const agent = useMemo(() => {
		if (!hydrated || !model) return null;
		// openai-compat constructs request URLs with `new URL(...)`, which rejects
		// relative bases. Resolve against the current origin.
		const baseURL = `${window.location.origin}/api/v1`;
		const languageModel =
			format === "anthropic"
				? createAnthropic({
						baseURL,
						apiKey: "shoal-internal", // stripped by internalFetch
						fetch: internalFetch,
					})(model)
				: createOpenAICompatible({
						baseURL,
						name: "shoal",
						fetch: internalFetch,
					})(model);

		const generateImage = makeGenerateImageTool(imageData.models);
		const generateAudio = makeGenerateAudioTool(ttsData.models);
		// Widen to ToolSet at construction: ToolLoopAgent is invariant over its
		// tool set, so the union of present/absent media tools can't be assigned
		// to ChatInnerProps without a widening cast. ChatInner never indexes
		// tools by name, so the looser type loses nothing it needs. When neither
		// image nor tts models are online the agent runs with no tools at all,
		// which is the same shape as a plain chat session.
		const tools: ToolSet = {
			...(generateImage ? { generate_image: generateImage } : {}),
			...(generateAudio ? { generate_audio: generateAudio } : {}),
		};

		return new ToolLoopAgent({
			model: languageModel,
			tools,
			stopWhen: stepCountIs(5),
		});
	}, [hydrated, model, format, imageData.models, ttsData.models]);

	if (agent) {
		return (
			<ChatInner
				key={`${format}:${model}`}
				agent={agent}
				data={data}
				model={model}
				setModel={setModel}
				format={format}
				setFormat={setFormat}
				input={input}
				setInput={setInput}
				scrollRef={scrollRef}
			/>
		);
	}

	return (
		<main className="page-wrap flex h-[calc(100vh-64px)] flex-col px-4 pb-4 pt-10">
			<ChatHeader
				data={data}
				model={model}
				setModel={setModel}
				format={format}
				setFormat={setFormat}
			/>
			<div className="island-shell flex flex-1 items-center justify-center rounded-sm p-8">
				{data.models.length === 0 ? (
					<NoWorkersEmpty />
				) : (
					<p className="text-sm text-[var(--sea-ink-soft)]">Loading chat…</p>
				)}
			</div>
		</main>
	);
}

function NoWorkersEmpty() {
	return (
		<div className="max-w-md text-center">
			<p className="island-kicker mb-3">No models available</p>
			<p className="text-sm text-[var(--sea-ink-soft)]">
				At least one worker needs to be connected to chat. Head to the{" "}
				<Link to="/workers" className="text-link">
					workers page
				</Link>{" "}
				for instructions on connecting one.
			</p>
		</div>
	);
}

interface ChatInnerProps {
	agent: ToolLoopAgent<never, ToolSet>;
	data: { models: string[] };
	model: string;
	setModel: (m: string) => void;
	format: WireFormat;
	setFormat: (f: WireFormat) => void;
	input: string;
	setInput: (s: string) => void;
	scrollRef: React.RefObject<HTMLDivElement | null>;
}

function ChatInner({
	agent,
	data,
	model,
	setModel,
	format,
	setFormat,
	input,
	setInput,
	scrollRef,
}: ChatInnerProps) {
	const transport = useMemo(() => new DirectChatTransport({ agent }), [agent]);
	const { messages, sendMessage, status, error, stop } = useChat({ transport });

	const submit = () => {
		const text = input.trim();
		if (!text || status === "submitted" || status === "streaming") return;
		setInput("");
		sendMessage({ text });
	};

	const busy = status === "submitted" || status === "streaming";

	return (
		<main className="page-wrap flex h-[calc(100vh-64px)] flex-col px-4 pb-4 pt-10">
			<ChatHeader
				data={data}
				model={model}
				setModel={setModel}
				format={format}
				setFormat={setFormat}
			/>

			<div
				ref={scrollRef}
				className="island-shell flex-1 overflow-y-auto rounded-sm p-4"
			>
				{messages.length === 0 && (
					<p className="text-center text-sm text-[var(--sea-ink-soft)]">
						Send a message to get started.
					</p>
				)}
				{messages.map((m, i) => (
					<MessageBubble
						key={m.id}
						message={m}
						// Show a pulsing caret on the trailing text of the last
						// assistant message while tokens are still coming in.
						streaming={
							status === "streaming" &&
							i === messages.length - 1 &&
							m.role === "assistant"
						}
					/>
				))}
				{/* Submitted but no assistant message yet — model is warming up. */}
				{status === "submitted" &&
					messages[messages.length - 1]?.role === "user" && (
						<ThinkingIndicator />
					)}
				{error && (
					<div className="mb-3 text-left">
						<div className="inline-block max-w-[80%] rounded-sm bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
							{error.message}
						</div>
					</div>
				)}
			</div>

			<form
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
				className="mt-4 flex gap-2"
			>
				<input
					type="text"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder={model ? "Type a message..." : "No model selected"}
					disabled={!model || busy}
					className="flex-1 rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-2.5 text-sm text-[var(--sea-ink)] placeholder:text-[var(--sea-ink-soft)] focus:border-[var(--lagoon)] focus:outline-none"
				/>
				{busy ? (
					<button
						type="button"
						onClick={() => stop()}
						className="rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)]"
					>
						Stop
					</button>
				) : (
					<button
						type="submit"
						disabled={!model || !input.trim()}
						className="rounded-sm border border-[var(--lagoon-line)] bg-[var(--lagoon-soft)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[var(--lagoon-line)] disabled:opacity-50 disabled:hover:translate-y-0"
					>
						Send
					</button>
				)}
			</form>
		</main>
	);
}

function ChatHeader({
	data,
	model,
	setModel,
	format,
	setFormat,
}: {
	data: { models: string[] };
	model: string;
	setModel: (m: string) => void;
	format: WireFormat;
	setFormat: (f: WireFormat) => void;
}) {
	return (
		<header className="rise-in mb-6 flex flex-wrap items-start justify-between gap-4">
			<div>
				<h1 className="display-title text-3xl text-[var(--sea-ink)] sm:text-4xl">
					Chat
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					Test inference and tool calling against connected workers
				</p>
			</div>
			<div className="flex items-center gap-3">
				<div className="flex items-center rounded-sm border border-[var(--line)] bg-[var(--surface-strong)] p-0.5 text-xs">
					<FormatToggle current={format} value="openai" onClick={setFormat}>
						OpenAI
					</FormatToggle>
					<FormatToggle current={format} value="anthropic" onClick={setFormat}>
						Anthropic
					</FormatToggle>
				</div>
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

function FormatToggle({
	current,
	value,
	onClick,
	children,
}: {
	current: WireFormat;
	value: WireFormat;
	onClick: (v: WireFormat) => void;
	children: React.ReactNode;
}) {
	const active = current === value;
	return (
		<button
			type="button"
			onClick={() => onClick(value)}
			className={`rounded-sm px-2.5 py-1 transition ${
				active
					? "bg-[var(--lagoon-soft)] text-[var(--lagoon-deep)]"
					: "text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
			}`}
		>
			{children}
		</button>
	);
}

function MessageBubble({
	message,
	streaming = false,
}: {
	message: UIMessage;
	streaming?: boolean;
}) {
	const isUser = message.role === "user";
	// Index of the last text part — that's the only one that should get the
	// streaming caret (subsequent tool/reasoning parts shouldn't).
	let lastTextIdx = -1;
	for (let i = 0; i < message.parts.length; i++) {
		if (message.parts[i].type === "text") lastTextIdx = i;
	}
	return (
		<div className={`mb-3 ${isUser ? "text-right" : "text-left"}`}>
			<div
				className={`inline-block max-w-[80%] space-y-2 rounded-sm px-4 py-2.5 text-left text-sm ${
					isUser
						? "bg-[var(--lagoon-soft)] text-[var(--sea-ink)]"
						: "bg-[var(--surface-strong)] text-[var(--sea-ink)]"
				}`}
			>
				{message.parts.map((part, i) => {
					// Parts within a message don't have stable IDs from the SDK, but
					// their (type, index) pair is stable across renders of the same
					// message and is unique within the message scope.
					const partKey = `${message.id}:${i}:${part.type}`;
					if (part.type === "text") {
						const showCaret = streaming && i === lastTextIdx;
						return (
							<pre key={partKey} className="m-0 whitespace-pre-wrap font-sans">
								{part.text}
								{showCaret && <span className="animate-pulse">|</span>}
							</pre>
						);
					}
					if (part.type === "reasoning") {
						return (
							<pre
								key={partKey}
								className="m-0 whitespace-pre-wrap font-sans text-xs italic text-[var(--sea-ink-soft)]"
							>
								{part.text}
							</pre>
						);
					}
					if (part.type.startsWith("tool-")) {
						return <ToolCallView key={partKey} part={part} />;
					}
					return null;
				})}
				{/* Streaming but no text part yet (e.g. model emitted only a tool
            call so far) — show a caret in an empty trailing line. */}
				{streaming && lastTextIdx === -1 && (
					<pre className="m-0 whitespace-pre-wrap font-sans">
						<span className="animate-pulse">|</span>
					</pre>
				)}
			</div>
		</div>
	);
}

function ThinkingIndicator() {
	return (
		<div className="mb-3 text-left">
			<div className="inline-flex items-center gap-1.5 rounded-sm bg-[var(--surface-strong)] px-4 py-2.5 text-sm text-[var(--sea-ink-soft)]">
				<Dot delay={0} />
				<Dot delay={150} />
				<Dot delay={300} />
			</div>
		</div>
	);
}

function Dot({ delay }: { delay: number }) {
	return (
		<span
			className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--sea-ink-soft)]"
			style={{ animationDelay: `${delay}ms` }}
		/>
	);
}

function ToolCallView({ part }: { part: UIMessage["parts"][number] }) {
	// Tool parts have shape: { type: "tool-<name>", state, input, output?, errorText? }
	const p = part as {
		type: string;
		state?: string;
		input?: unknown;
		output?: unknown;
		errorText?: string;
	};
	const name = p.type.replace(/^tool-/, "");
	const stateLabel =
		p.state === "output-available"
			? "✓"
			: p.state === "output-error"
				? "✗"
				: p.state === "input-streaming" || p.state === "input-available"
					? "…"
					: "";
	return (
		<div className="rounded-sm border border-[var(--line)] bg-[var(--chip-bg)] p-2 text-xs">
			<div className="mb-1 flex items-center justify-between font-mono text-[var(--sea-ink-soft)]">
				<span>
					<span className="mr-1">{stateLabel}</span>
					<span className="font-semibold text-[var(--sea-ink)]">{name}</span>
				</span>
			</div>
			{p.input !== undefined && (
				<pre className="mb-1 m-0 overflow-x-auto whitespace-pre-wrap font-mono text-[var(--sea-ink)]">
					{JSON.stringify(p.input, null, 2)}
				</pre>
			)}
			{p.output !== undefined &&
				(isMediaOutput(p.output) ? (
					<MediaOutputView output={p.output} />
				) : (
					<pre className="m-0 overflow-x-auto whitespace-pre-wrap font-mono text-emerald-300">
						→ {JSON.stringify(p.output, null, 2)}
					</pre>
				))}
			{p.errorText && (
				<pre className="m-0 overflow-x-auto whitespace-pre-wrap font-mono text-red-300">
					⚠ {p.errorText}
				</pre>
			)}
		</div>
	);
}

/** True for media-generation tool results (`generate_image`,
 *  `generate_audio`) — both carry a base64 payload + mime type. Lets
 *  ToolCallView render the media inline instead of dumping a 100k-character
 *  base64 blob into the chat transcript. */
function isMediaOutput(
	output: unknown,
): output is { b64: string; mimeType: string; model?: string } {
	if (output === null || typeof output !== "object") return false;
	const o = output as Record<string, unknown>;
	return typeof o.b64 === "string" && typeof o.mimeType === "string";
}

function MediaOutputView({
	output,
}: {
	output: { b64: string; mimeType: string; model?: string };
}) {
	const src = `data:${output.mimeType};base64,${output.b64}`;
	return (
		<div className="mt-1">
			{output.mimeType.startsWith("image/") ? (
				<img
					src={src}
					alt="Generated"
					className="max-w-full rounded-sm border border-[var(--line)]"
				/>
			) : output.mimeType.startsWith("audio/") ? (
				// biome-ignore lint/a11y/useMediaCaption: generated audio has no caption track
				<audio
					src={src}
					controls
					className="w-full"
				/>
			) : (
				<pre className="m-0 overflow-x-auto whitespace-pre-wrap font-mono text-emerald-300">
					→ [{output.mimeType}, {output.b64.length} bytes base64]
				</pre>
			)}
			{output.model && (
				<p className="mt-1 font-mono text-[var(--sea-ink-soft)]">
					→ {output.model}
				</p>
			)}
		</div>
	);
}
