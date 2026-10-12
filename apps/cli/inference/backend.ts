import { Effect, type Schema } from "effect";
import {
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/http";
import { BackendError } from "./errors";

/** Execute a request against a backend, failing with `BackendError` (carrying
 *  the response body) on transport errors or non-2xx statuses. */
export const execute = Effect.fnUntraced(function* (
	request: HttpClientRequest.HttpClientRequest,
) {
	const client = yield* HttpClient.HttpClient;
	const response = yield* client.execute(request).pipe(
		Effect.mapError(
			(cause) =>
				new BackendError({ url: request.url, message: cause.message, cause }),
		),
	);
	if (response.status < 200 || response.status >= 300) {
		const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
		return yield* new BackendError({
			url: request.url,
			message: `Backend returned ${response.status}: ${body}`,
		});
	}
	return response;
});

/** Decode a successful response body as JSON against `schema`. */
export const bodyJson = <S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
) =>
	Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
		return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
			Effect.mapError(
				(cause) =>
					new BackendError({
						url: response.request.url,
						message: `Unexpected response body: ${cause.message}`,
						cause,
					}),
			),
		);
	});

export const getJson = <S extends Schema.ConstraintDecoder<unknown>>(
	url: string,
	schema: S,
) => execute(HttpClientRequest.get(url)).pipe(Effect.flatMap(bodyJson(schema)));

export const postJson = <S extends Schema.ConstraintDecoder<unknown>>(
	url: string,
	body: unknown,
	schema: S,
) =>
	execute(
		HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
	).pipe(Effect.flatMap(bodyJson(schema)));
