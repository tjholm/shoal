import type {
	FinishReason,
	InferOptions,
	ToolCallDelta,
	Usage,
} from "@shoal/protocol";
import { Effect, Option, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClientRequest } from "effect/http";
import { execute } from "./backend";
import { BackendError } from "./errors";

export type ChatChunk =
	| {
			readonly _tag: "Delta";
			readonly content?: string;
			readonly toolCalls?: ReadonlyArray<ToolCallDelta>;
	  }
	| {
			readonly _tag: "Done";
			readonly finishReason: FinishReason;
			readonly usage?: Usage;
	  };

const optionalNullable = <S extends Schema.Top>(schema: S) =>
	Schema.optionalKey(Schema.NullOr(schema));

const CompletionChunk = Schema.Struct({
	usage: optionalNullable(
		Schema.Struct({
			prompt_tokens: Schema.Number,
			completion_tokens: Schema.Number,
		}),
	),
	choices: optionalNullable(
		Schema.Array(
			Schema.Struct({
				finish_reason: optionalNullable(Schema.String),
				delta: optionalNullable(
					Schema.Struct({
						content: optionalNullable(Schema.String),
						tool_calls: optionalNullable(
							Schema.Array(
								Schema.Struct({
									index: Schema.Number,
									id: optionalNullable(Schema.String),
									function: optionalNullable(
										Schema.Struct({
											name: optionalNullable(Schema.String),
											arguments: optionalNullable(Schema.String),
										}),
									),
								}),
							),
						),
					}),
				),
			}),
		),
	),
});
type CompletionChunk = typeof CompletionChunk.Type;

const decodeCompletionChunk = Schema.decodeUnknownOption(
	Schema.fromJsonString(CompletionChunk),
);

const isFinishReason = (s: string | null | undefined): s is FinishReason =>
	s === "stop" || s === "length" || s === "tool_calls";

function toDelta(chunk: CompletionChunk): Option.Option<ChatChunk> {
	const delta = chunk.choices?.[0]?.delta;
	if (!delta) return Option.none();
	const content =
		typeof delta.content === "string" && delta.content.length > 0
			? delta.content
			: undefined;
	const toolCalls =
		delta.tool_calls && delta.tool_calls.length > 0
			? delta.tool_calls.map(
					(tc): ToolCallDelta => ({
						index: tc.index,
						...(tc.id != null ? { id: tc.id } : {}),
						...(tc.function?.name != null ? { name: tc.function.name } : {}),
						...(tc.function?.arguments != null
							? { arguments: tc.function.arguments }
							: {}),
					}),
				)
			: undefined;
	if (content === undefined && toolCalls === undefined) return Option.none();
	return Option.some({
		_tag: "Delta",
		...(content !== undefined ? { content } : {}),
		...(toolCalls !== undefined ? { toolCalls } : {}),
	});
}

/**
 * Run chat inference via the backend. Emits OpenAI-shaped delta fragments
 * (content text and/or tool_call slices) as they stream in, then a single
 * terminal `Done` chunk.
 */
export const chatInference = (
	backendUrl: string,
	model: string,
	messages: ReadonlyArray<unknown>,
	options: InferOptions | undefined,
) => {
	const url = `${backendUrl}/v1/chat/completions`;
	const body = {
		model,
		messages,
		stream: true,
		// Ask the backend to emit a final usage chunk. Supported by Ollama's
		// OpenAI shim, vLLM, llama.cpp server, OpenAI itself. Backends that
		// don't recognize it ignore the field, and we report no usage.
		stream_options: { include_usage: true },
		max_tokens: options?.maxTokens,
		temperature: options?.temperature,
		...(options?.tools && options.tools.length > 0
			? { tools: options.tools }
			: {}),
		...(options?.toolChoice !== undefined
			? { tool_choice: options.toolChoice }
			: {}),
	};

	let finishReason: FinishReason = "stop";
	let usage: Usage | undefined;

	const chunks = execute(
		HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
	).pipe(
		Effect.map((response) => response.stream),
		Stream.unwrap,
		Stream.decodeText,
		Stream.pipeThroughChannel(Sse.decode()),
		Stream.mapError(
			(cause) =>
				new BackendError({
					url,
					message:
						cause._tag === "Retry"
							? "Chat stream ended with an SSE retry directive"
							: `Chat stream failed: ${cause.message}`,
					cause,
				}),
		),
		Stream.filter((event) => event.data !== "[DONE]"),
		Stream.mapEffect((event) => {
			const decoded = decodeCompletionChunk(event.data);
			if (Option.isNone(decoded)) {
				return Effect.logWarning(
					`skipping malformed chat chunk from ${backendUrl}: ${event.data}`,
				).pipe(Effect.as(Option.none<ChatChunk>()));
			}
			const chunk = decoded.value;
			// Terminal usage chunk: choices is empty/absent, usage is set.
			if (chunk.usage) {
				usage = {
					promptTokens: chunk.usage.prompt_tokens,
					completionTokens: chunk.usage.completion_tokens,
				};
			}
			const reason = chunk.choices?.[0]?.finish_reason;
			if (isFinishReason(reason)) finishReason = reason;
			return Effect.succeed(toDelta(chunk));
		}),
		Stream.filter(Option.isSome),
		Stream.map((delta) => delta.value),
	);

	return Stream.concat(
		chunks,
		Stream.sync(
			(): ChatChunk => ({
				_tag: "Done",
				finishReason,
				...(usage !== undefined ? { usage } : {}),
			}),
		),
	);
};
