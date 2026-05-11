import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { useChat } from "@ai-sdk/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	DirectChatTransport,
	stepCountIs,
	ToolLoopAgent,
	tool,
	type UIMessage,
} from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { workerCountsSnapshotQuery } from "../../lib/queries";

export const Route = createFileRoute("/_authed/chat")({
	loader: ({ context: { queryClient } }) =>
		queryClient.ensureQueryData(workerCountsSnapshotQuery()),
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

const browserTools = {
	get_current_time: tool({
		description: "Get the current time as an ISO-8601 timestamp.",
		inputSchema: z.object({}),
		execute: async () => ({ now: new Date().toISOString() }),
	}),
	evaluate_math: tool({
		description:
			"Evaluate a basic arithmetic expression. Supports + - * / parentheses and decimal numbers. No variables, no functions.",
		inputSchema: z.object({
			expression: z.string().describe('e.g. "(2 + 3) * 4"'),
		}),
		execute: async ({ expression }) => {
			if (!/^[\d+\-*/().\s]+$/.test(expression)) {
				return { error: "expression contains unsupported characters" };
			}
			try {
				const value = Function(`"use strict"; return (${expression});`)();
				return { result: value };
			} catch (err) {
				return { error: (err as Error).message };
			}
		},
	}),
};

function Chat() {
	const { data } = useSuspenseQuery(workerCountsSnapshotQuery());
	const [model, setModel] = useState(data.models[0] ?? "");
	const [format, setFormat] = useState<WireFormat>("openai");
	const [input, setInput] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);

	// Defer agent (and any browser-only logic) until after hydration. The SSR
	// pass and the first client render must produce the same tree — otherwise
	// hydration mismatches in nested router-context hooks tear down the route.
	const [hydrated, setHydrated] = useState(false);
	useEffect(() => setHydrated(true), []);

	// Rebuild the agent whenever the model or wire format change. useChat's
	// transport prop is read at hook-init time, so we also force-remount the
	// hook by keying on these values below.
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

		return new ToolLoopAgent({
			model: languageModel,
			tools: browserTools,
			stopWhen: stepCountIs(5),
		});
	}, [hydrated, model, format]);

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
	agent: ToolLoopAgent<never, typeof browserTools>;
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
						Send a message to get started. Try “What is (12+7)*3?” to exercise
						tool calling.
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
			{p.output !== undefined && (
				<pre className="m-0 overflow-x-auto whitespace-pre-wrap font-mono text-emerald-300">
					→ {JSON.stringify(p.output, null, 2)}
				</pre>
			)}
			{p.errorText && (
				<pre className="m-0 overflow-x-auto whitespace-pre-wrap font-mono text-red-300">
					⚠ {p.errorText}
				</pre>
			)}
		</div>
	);
}
