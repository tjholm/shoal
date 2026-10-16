import { Effect, Layer, Schema, Stream } from "effect";
import { Base64 } from "effect/encoding";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Auth } from "../auth";
import { Dispatcher, type JobEvent, type JobResult, resultOf } from "../dispatch";
import { formatEvent, sseResponse } from "../http/sse";
import { WorkerRegistry } from "../workers/registry";
import {
	ApiFailure,
	authenticate,
	decodeBody,
	nowSeconds,
	openAIError,
	optionalNullable,
	renderFailures,
} from "./common";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

const ChatCompletionRequest = Schema.Struct({
	model: NonEmptyString,
	messages: Schema.Array(Schema.Unknown),
	stream: optionalNullable(Schema.Boolean),
	max_tokens: optionalNullable(Schema.Number),
	// OpenAI's replacement for `max_tokens`, sent by newer clients and SDKs.
	max_completion_tokens: optionalNullable(Schema.Number),
	temperature: optionalNullable(Schema.Number),
	tools: optionalNullable(Schema.Array(Schema.Unknown)),
	tool_choice: Schema.optionalKey(Schema.Unknown),
	stream_options: optionalNullable(
		Schema.Struct({ include_usage: optionalNullable(Schema.Boolean) }),
	),
});

const EmbeddingRequest = Schema.Struct({
	model: NonEmptyString,
	input: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
});

const ImageRequest = Schema.Struct({
	model: NonEmptyString,
	prompt: NonEmptyString,
	size: optionalNullable(Schema.String),
	n: optionalNullable(Schema.Int.check(Schema.isGreaterThan(0))),
	quality: optionalNullable(Schema.String),
	style: optionalNullable(Schema.String),
	response_format: optionalNullable(Schema.Literals(["url", "b64_json"])),
	stream: optionalNullable(Schema.Boolean),
});

const SpeechRequest = Schema.Struct({
	model: NonEmptyString,
	input: NonEmptyString,
	voice: optionalNullable(Schema.String),
	response_format: optionalNullable(Schema.String),
	speed: optionalNullable(Schema.Number),
	instructions: optionalNullable(Schema.String),
});

const definedOnly = <T extends Record<string, unknown>>(record: T) =>
	Object.fromEntries(
		Object.entries(record).filter(([, v]) => v !== undefined && v !== null),
	) as { [K in keyof T]?: Exclude<T[K], null> };

const usageBody = (usage: JobResult["usage"]) => {
	const prompt = usage?.promptTokens ?? 0;
	const completion = usage?.completionTokens ?? 0;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
	};
};

const data = (payload: unknown) => formatEvent({ data: payload });
const DONE = "data: [DONE]\n\n";

/** `chat.completion.chunk` frames for a job's events, ending with `[DONE]`.
 *  A failed job ends the stream with an error frame instead. */
const chatChunks = (
	jobId: string,
	model: string,
	created: number,
	includeUsage: boolean,
	events: Stream.Stream<JobEvent, { readonly message: string }>,
) => {
	const chunk = (delta: object, finishReason: string | null = null) =>
		data({
			id: `chatcmpl-${jobId}`,
			object: "chat.completion.chunk",
			created,
			model,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		});
	return events.pipe(
		Stream.flatMap((event): Stream.Stream<string> => {
			if (event.type === "delta") {
				const delta = definedOnly({
					content: event.content || undefined,
					tool_calls: event.toolCalls?.length
						? event.toolCalls.map((tc) => ({
								index: tc.index,
								id: tc.id,
								type: "function",
								function: { name: tc.name, arguments: tc.arguments },
							}))
						: undefined,
				});
				return Object.keys(delta).length > 0
					? Stream.succeed(chunk(delta))
					: Stream.empty;
			}
			if (event.type !== "done") return Stream.empty;
			return Stream.fromIterable([
				chunk({}, event.finishReason),
				// Per the OpenAI spec, include_usage adds a final chunk with empty
				// choices and the usage totals.
				...(includeUsage
					? [
							data({
								id: `chatcmpl-${jobId}`,
								object: "chat.completion.chunk",
								created,
								model,
								choices: [],
								usage: usageBody(event.usage),
							}),
						]
					: []),
				DONE,
			]);
		}),
		Stream.catch((err) =>
			Stream.succeed(data({ error: { message: err.message, type: "server_error" } })),
		),
	);
};

/** OpenAI's image SSE: one `image_generation.completed` event per image.
 *  The backends shoal supports render in one shot, so there are no partial
 *  images — the spec allows zero partials. */
const imageEvents = (
	result: Effect.Effect<JobResult, { readonly message: string }>,
	meta: { size?: string; quality?: string },
) =>
	Stream.fromEffect(
		Effect.gen(function* () {
			const { images } = yield* result;
			if (!images?.length) {
				return [
					data({ type: "error", error: { message: "Worker did not return any images" } }),
				];
			}
			const createdAt = yield* nowSeconds;
			return images.map((img) =>
				data(
					definedOnly({
						type: "image_generation.completed",
						created_at: createdAt,
						b64_json: img.b64,
						url: img.url,
						revised_prompt: img.revisedPrompt,
						size: meta.size,
						quality: meta.quality,
					}),
				),
			);
		}).pipe(
			Effect.catch((err) =>
				Effect.succeed([data({ type: "error", error: { message: err.message } })]),
			),
		),
	).pipe(
		Stream.flatMap(Stream.fromIterable),
		// OpenAI clients accept either `[DONE]` or socket close; send both.
		Stream.concat(Stream.succeed(DONE)),
	);

/** The OpenAI-compatible inference API under `/api/v1`. */
export const openAIRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const dispatcher = yield* Dispatcher;
		const registry = yield* WorkerRegistry;
		const context = yield* Effect.context<Auth>();

		const route = (
			method: "GET" | "POST",
			path: string,
			handler: (
				request: HttpServerRequest.HttpServerRequest,
			) => Effect.Effect<
				HttpServerResponse.HttpServerResponse,
				{ readonly _tag: string; readonly message: string },
				Auth
			>,
		) =>
			router.add(
				method,
				`/api/v1${path}`,
				Effect.flatMap(HttpServerRequest.HttpServerRequest, handler).pipe(
					renderFailures(openAIError),
					Effect.provideContext(context),
				),
			);

		yield* route(
			"POST",
			"/chat/completions",
			Effect.fnUntraced(function* (request) {
				const { organizationId } = yield* authenticate(request);
				const body = yield* decodeBody(ChatCompletionRequest)(request);
				const job = {
					organizationId,
					task: "chat" as const,
					model: body.model,
					input: body.messages,
					...definedOnly({
						maxTokens: body.max_completion_tokens ?? body.max_tokens,
						temperature: body.temperature,
						tools: body.tools,
						toolChoice: body.tool_choice,
					}),
				};

				if (body.stream === true) {
					const { jobId, events } = yield* dispatcher.dispatch(job);
					return sseResponse(
						chatChunks(
							jobId,
							body.model,
							yield* nowSeconds,
							body.stream_options?.include_usage === true,
							events,
						),
					);
				}

				const { jobId, result } = yield* dispatcher.collect(job);
				return HttpServerResponse.jsonUnsafe({
					id: `chatcmpl-${jobId}`,
					object: "chat.completion",
					created: yield* nowSeconds,
					model: body.model,
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: result.content || null,
								...(result.toolCalls.length > 0
									? {
											tool_calls: result.toolCalls.map((tc) => ({
												id: tc.id,
												type: "function",
												function: { name: tc.name, arguments: tc.arguments },
											})),
										}
									: {}),
							},
							finish_reason: result.finishReason,
						},
					],
					usage: usageBody(result.usage),
				});
			}),
		);

		yield* route(
			"POST",
			"/embeddings",
			Effect.fnUntraced(function* (request) {
				const { organizationId } = yield* authenticate(request);
				const body = yield* decodeBody(EmbeddingRequest)(request);
				const { result } = yield* dispatcher.collect({
					organizationId,
					task: "embedding",
					model: body.model,
					input: body.input,
				});
				if (!result.embedding) {
					return yield* new ApiFailure({
						status: 500,
						message: "Worker did not return an embedding",
					});
				}
				return HttpServerResponse.jsonUnsafe({
					object: "list",
					data: [{ object: "embedding", index: 0, embedding: result.embedding }],
					model: body.model,
					usage: { prompt_tokens: 0, total_tokens: 0 },
				});
			}),
		);

		yield* route(
			"POST",
			"/images/generations",
			Effect.fnUntraced(function* (request) {
				const { organizationId } = yield* authenticate(request);
				const body = yield* decodeBody(ImageRequest)(request);
				const options = definedOnly({
					size: body.size,
					n: body.n,
					quality: body.quality,
					style: body.style,
					responseFormat: body.response_format,
				});
				const job = {
					organizationId,
					task: "image" as const,
					model: body.model,
					input: body.prompt,
					image: options,
				};

				if (body.stream === true) {
					// Dispatch now so a missing or busy worker is still an error
					// status, then stream headers immediately: a generation can take
					// minutes, longer than proxies wait for response headers.
					const { events } = yield* dispatcher.dispatch(job);
					return sseResponse(imageEvents(resultOf(events), options));
				}

				const { result } = yield* dispatcher.collect(job);
				if (!result.images?.length) {
					return yield* new ApiFailure({
						status: 500,
						message: "Worker did not return any images",
					});
				}
				return HttpServerResponse.jsonUnsafe({
					created: yield* nowSeconds,
					data: result.images.map((img) =>
						definedOnly({
							url: img.url,
							b64_json: img.b64,
							revised_prompt: img.revisedPrompt,
						}),
					),
				});
			}),
		);

		yield* route(
			"POST",
			"/audio/speech",
			Effect.fnUntraced(function* (request) {
				const { organizationId } = yield* authenticate(request);
				const body = yield* decodeBody(SpeechRequest)(request);
				const { result } = yield* dispatcher.collect({
					organizationId,
					task: "tts",
					model: body.model,
					input: body.input,
					tts: definedOnly({
						voice: body.voice,
						responseFormat: body.response_format,
						speed: body.speed,
						instructions: body.instructions,
					}),
				});
				if (!result.audio) {
					return yield* new ApiFailure({
						status: 500,
						message: "Worker did not return audio",
					});
				}
				const bytes = Base64.decode(result.audio.b64);
				if (bytes._tag === "Failure") {
					return yield* new ApiFailure({
						status: 500,
						message: "Worker returned malformed audio",
					});
				}
				return HttpServerResponse.uint8Array(bytes.success, {
					contentType: result.audio.mimeType,
				});
			}),
		);

		yield* route(
			"GET",
			"/models",
			Effect.fnUntraced(function* (request) {
				const { organizationId } = yield* authenticate(request);
				const ids = yield* registry.availableModels(organizationId);
				return HttpServerResponse.jsonUnsafe({
					object: "list",
					data: ids.map((id) => ({
						id,
						object: "model",
						created: 0,
						owned_by: "worker",
					})),
				});
			}),
		);
	}),
);
