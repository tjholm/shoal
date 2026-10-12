import type { FinishReason, ToolCallDelta, Usage } from "@shoal/protocol";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Auth } from "../auth";
import { Dispatcher, type JobEvent, type JobResult } from "../dispatch";
import { formatEvent, sseResponse } from "../http/sse";
import {
	anthropicError,
	authenticate,
	decodeBody,
	optionalNullable,
	renderFailures,
} from "./common";

const TextBlock = Schema.Struct({ type: Schema.tag("text"), text: Schema.String });
const ToolUseBlock = Schema.Struct({
	type: Schema.tag("tool_use"),
	id: Schema.String,
	name: Schema.String,
	input: Schema.Unknown,
});
const ToolResultBlock = Schema.Struct({
	type: Schema.tag("tool_result"),
	tool_use_id: Schema.String,
	content: Schema.Union([Schema.String, Schema.Array(TextBlock)]),
	is_error: Schema.optionalKey(Schema.Boolean),
});
// Block types shoal doesn't translate (images, documents, thinking) are
// accepted and dropped.
const OtherBlock = Schema.Struct({ type: Schema.String });
const ContentBlock = Schema.Union([TextBlock, ToolUseBlock, ToolResultBlock, OtherBlock]);
type ContentBlock = typeof ContentBlock.Type;

const Message = Schema.Struct({
	role: Schema.Literals(["user", "assistant"]),
	content: Schema.Union([Schema.String, Schema.Array(ContentBlock)]),
});
type Message = typeof Message.Type;

const MessagesRequest = Schema.Struct({
	model: Schema.String.check(Schema.isMinLength(1)),
	messages: Schema.Array(Message),
	system: Schema.optionalKey(
		Schema.Union([Schema.String, Schema.Array(ContentBlock)]),
	),
	stream: optionalNullable(Schema.Boolean),
	max_tokens: optionalNullable(Schema.Number),
	temperature: optionalNullable(Schema.Number),
	tools: optionalNullable(
		Schema.Array(
			Schema.Struct({
				name: Schema.String,
				description: Schema.optionalKey(Schema.String),
				input_schema: Schema.Unknown,
			}),
		),
	),
	tool_choice: Schema.optionalKey(Schema.Unknown),
});

interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

const isText = (b: ContentBlock): b is typeof TextBlock.Type => b.type === "text";
const isToolUse = (b: ContentBlock): b is typeof ToolUseBlock.Type =>
	b.type === "tool_use";
const isToolResult = (b: ContentBlock): b is typeof ToolResultBlock.Type =>
	b.type === "tool_result";

function systemMessages(system: string | ReadonlyArray<ContentBlock> | undefined) {
	const text =
		typeof system === "string"
			? system
			: (system ?? []).filter(isText).map((b) => b.text).join("");
	return text.length > 0 ? [{ role: "system" as const, content: text }] : [];
}

function toOpenAIMessages(messages: ReadonlyArray<Message>): OpenAIMessage[] {
	return messages.flatMap((msg): OpenAIMessage[] => {
		if (typeof msg.content === "string") {
			return [{ role: msg.role, content: msg.content }];
		}
		const text = msg.content.filter(isText).map((b) => b.text).join("");
		if (msg.role === "user") {
			// A user turn's tool results become separate `tool` messages after its
			// text.
			const toolResults = msg.content.filter(isToolResult).map(
				(b): OpenAIMessage => ({
					role: "tool",
					tool_call_id: b.tool_use_id,
					content:
						typeof b.content === "string"
							? b.content
							: b.content.map((c) => c.text).join(""),
				}),
			);
			return [...(text.length > 0 ? [{ role: "user" as const, content: text }] : []), ...toolResults];
		}
		const toolCalls = msg.content.filter(isToolUse).map((b) => ({
			id: b.id,
			type: "function" as const,
			function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
		}));
		return [
			{
				role: "assistant",
				content: text.length > 0 ? text : null,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			},
		];
	});
}

function toolChoice(choice: unknown): unknown {
	if (typeof choice !== "object" || choice === null || !("type" in choice)) {
		return undefined;
	}
	switch (choice.type) {
		case "auto":
			return "auto";
		case "any":
			return "required";
		case "none":
			return "none";
		case "tool":
			return "name" in choice && typeof choice.name === "string"
				? { type: "function", function: { name: choice.name } }
				: undefined;
		default:
			return undefined;
	}
}

const STOP_REASON: Record<FinishReason, string> = {
	stop: "end_turn",
	length: "max_tokens",
	tool_calls: "tool_use",
};

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** A tool call's accumulated arguments as an object. Backends occasionally
 *  emit empty or truncated JSON; Anthropic clients expect an object either
 *  way, so those become `{}`. */
const toolInput = (json: string): unknown =>
	Option.getOrElse(decodeJson(json), () => ({}));

function toAnthropicMessage(jobId: string, model: string, r: JobResult) {
	return {
		id: `msg_${jobId}`,
		type: "message",
		role: "assistant",
		model,
		content: [
			...(r.content.length > 0 ? [{ type: "text", text: r.content }] : []),
			...r.toolCalls.map((tc) => ({
				type: "tool_use",
				id: tc.id,
				name: tc.name,
				input: toolInput(tc.arguments),
			})),
		],
		stop_reason: STOP_REASON[r.finishReason],
		stop_sequence: null,
		usage: {
			input_tokens: r.usage?.promptTokens ?? 0,
			output_tokens: r.usage?.completionTokens ?? 0,
		},
	};
}

const frame = (event: string, data: object) =>
	formatEvent({ event, data: { type: event, ...data } });

interface ToolBlock {
	readonly blockIndex: number;
	id: string;
	name: string;
	/** Argument fragments that arrived before the call's id and name. */
	pendingArgs: string;
	started: boolean;
}

/**
 * Translates a chat job's events into Anthropic's ordered content blocks:
 * `message_start`, an optional text block, one `tool_use` block per call (in
 * first-seen order, streaming `input_json_delta` as arguments arrive), then
 * `message_delta` and `message_stop`. OpenAI tool-call fragments can
 * interleave with text, so a tool call closes any open text block.
 */
class AnthropicStream {
	private nextBlock = 0;
	private textBlock: number | undefined;
	private readonly tools = new Map<number, ToolBlock>();

	start(jobId: string, model: string): string[] {
		return [
			frame("message_start", {
				message: {
					id: `msg_${jobId}`,
					type: "message",
					role: "assistant",
					content: [],
					model,
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			}),
		];
	}

	event(event: JobEvent): string[] {
		if (event.type === "done") return this.finish(event.finishReason, event.usage);
		if (event.type !== "delta") return [];
		const out: string[] = [];
		if (event.content) {
			if (this.textBlock === undefined) {
				this.textBlock = this.nextBlock++;
				out.push(
					frame("content_block_start", {
						index: this.textBlock,
						content_block: { type: "text", text: "" },
					}),
				);
			}
			out.push(
				frame("content_block_delta", {
					index: this.textBlock,
					delta: { type: "text_delta", text: event.content },
				}),
			);
		}
		if (event.toolCalls) {
			out.push(...this.closeText());
			for (const tc of event.toolCalls) out.push(...this.toolDelta(tc));
		}
		return out;
	}

	private closeText(): string[] {
		if (this.textBlock === undefined) return [];
		const index = this.textBlock;
		this.textBlock = undefined;
		return [frame("content_block_stop", { index })];
	}

	private toolDelta(tc: ToolCallDelta): string[] {
		let tool = this.tools.get(tc.index);
		if (!tool) {
			tool = {
				blockIndex: this.nextBlock++,
				id: tc.id ?? "",
				name: tc.name ?? "",
				pendingArgs: "",
				started: false,
			};
			this.tools.set(tc.index, tool);
		} else {
			if (tc.id) tool.id = tc.id;
			if (tc.name) tool.name = tc.name;
		}
		const out: string[] = [];
		if (!tool.started && tool.id && tool.name) out.push(...this.startTool(tool));
		if (tc.arguments) {
			if (tool.started) out.push(this.argsDelta(tool, tc.arguments));
			else tool.pendingArgs += tc.arguments;
		}
		return out;
	}

	private startTool(tool: ToolBlock): string[] {
		tool.started = true;
		const out = [
			frame("content_block_start", {
				index: tool.blockIndex,
				content_block: {
					type: "tool_use",
					// A sane backend always sends both; fall back so the block is
					// still well-formed.
					id: tool.id || `toolu_${tool.blockIndex}`,
					name: tool.name || "unknown",
					input: {},
				},
			}),
		];
		if (tool.pendingArgs.length > 0) {
			out.push(this.argsDelta(tool, tool.pendingArgs));
			tool.pendingArgs = "";
		}
		return out;
	}

	private argsDelta(tool: ToolBlock, partial: string): string {
		return frame("content_block_delta", {
			index: tool.blockIndex,
			delta: { type: "input_json_delta", partial_json: partial },
		});
	}

	private finish(reason: FinishReason, usage: Usage | undefined): string[] {
		const out = this.closeText();
		for (const tool of this.tools.values()) {
			if (!tool.started) out.push(...this.startTool(tool));
			out.push(frame("content_block_stop", { index: tool.blockIndex }));
		}
		out.push(
			frame("message_delta", {
				delta: { stop_reason: STOP_REASON[reason], stop_sequence: null },
				// Anthropic puts input_tokens on message_start, but we only know them
				// at the end; clients ignore the extra field here.
				usage: {
					input_tokens: usage?.promptTokens ?? 0,
					output_tokens: usage?.completionTokens ?? 0,
				},
			}),
			frame("message_stop", {}),
		);
		return out;
	}
}

/** The Anthropic Messages API at `/api/v1/messages`. */
export const anthropicRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const dispatcher = yield* Dispatcher;
		const context = yield* Effect.context<Auth>();

		yield* router.add(
			"POST",
			"/api/v1/messages",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const { organizationId } = yield* authenticate(request);
				const body = yield* decodeBody(MessagesRequest)(request);
				const tools = body.tools?.length
					? body.tools.map((t) => ({
							type: "function",
							function: {
								name: t.name,
								description: t.description,
								parameters: t.input_schema,
							},
						}))
					: undefined;
				const job = {
					organizationId,
					task: "chat" as const,
					model: body.model,
					input: [...systemMessages(body.system), ...toOpenAIMessages(body.messages)],
					...(body.max_tokens != null ? { maxTokens: body.max_tokens } : {}),
					...(body.temperature != null ? { temperature: body.temperature } : {}),
					...(tools !== undefined ? { tools } : {}),
					...(toolChoice(body.tool_choice) !== undefined
						? { toolChoice: toolChoice(body.tool_choice) }
						: {}),
				};

				if (body.stream === true) {
					const { jobId, events } = yield* dispatcher.dispatch(job);
					const translator = new AnthropicStream();
					return sseResponse(
						Stream.fromIterable(translator.start(jobId, body.model)).pipe(
							Stream.concat(
								events.pipe(Stream.flatMap((e) => Stream.fromIterable(translator.event(e)))),
							),
							Stream.catch((err) =>
								Stream.succeed(
									frame("error", { error: { type: "api_error", message: err.message } }),
								),
							),
						),
					);
				}

				const { jobId, result } = yield* dispatcher.collect(job);
				return HttpServerResponse.jsonUnsafe(toAnthropicMessage(jobId, body.model, result));
			}).pipe(renderFailures(anthropicError), Effect.provideContext(context)),
		);
	}),
);
