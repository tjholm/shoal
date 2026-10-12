import { Clock, Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { Auth, type Principal } from "../auth";

/** How an API dialect renders an error body. */
export type ErrorBody = (message: string, status: number) => unknown;

export const openAIError: ErrorBody = (message, status) => ({
	error: { message, type: "error", code: status },
});

export const anthropicError: ErrorBody = (message) => ({
	type: "error",
	error: { type: "invalid_request_error", message },
});

/** An HTTP error to render in the caller's API dialect. */
export class ApiFailure extends Schema.TaggedError<ApiFailure>()("ApiFailure", {
	status: Schema.Number,
	message: Schema.String,
}) {}

/**
 * The principal for an inference request, from (in order) an
 * `Authorization: Bearer` key, an Anthropic-style `x-api-key`, or a dashboard
 * session with an active organization.
 */
export const authenticate = Effect.fnUntraced(function* (
	request: HttpServerRequest.HttpServerRequest,
) {
	const auth = yield* Auth;
	const authorization = request.headers.authorization;
	const key = authorization?.startsWith("Bearer ")
		? authorization.slice("Bearer ".length)
		: request.headers["x-api-key"];
	const principal: Option.Option<Principal> =
		key !== undefined
			? yield* auth.verifyApiKey(key)
			: yield* auth.getSession(new Headers(request.headers)).pipe(
					Effect.map(
						Option.flatMap((s) =>
							s.activeOrganizationId !== null
								? Option.some({ organizationId: s.activeOrganizationId, keyId: null })
								: Option.none(),
						),
					),
				);
	if (Option.isNone(principal)) {
		return yield* new ApiFailure({
			status: 401,
			message: key !== undefined ? "Invalid API key" : "Unauthorized",
		});
	}
	return principal.value;
});

/** Decode the JSON body against `schema`, failing with a 400. */
export const decodeBody = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
		const json = yield* request.json.pipe(
			Effect.mapError(() => new ApiFailure({ status: 400, message: "Invalid JSON body" })),
		);
		return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
			Effect.mapError(
				(issue) => new ApiFailure({ status: 400, message: issue.message }),
			),
		);
	});

/** Render failures of an inference handler: API errors with their status,
 *  no-capacity as 503, anything else (a failed job) as 500. */
export const renderFailures =
	(errorBody: ErrorBody) =>
	<R>(
		handler: Effect.Effect<
			HttpServerResponse.HttpServerResponse,
			{ readonly _tag: string; readonly message: string },
			R
		>,
	) =>
		handler.pipe(
			Effect.catch((err) => {
				const status =
					err instanceof ApiFailure
						? err.status
						: err._tag === "NoWorkerAvailable"
							? 503
							: 500;
				return Effect.succeed(
					HttpServerResponse.jsonUnsafe(
						status === 401
							? { error: { message: err.message, type: "auth_error", code: 401 } }
							: errorBody(err.message, status),
						{ status },
					),
				);
			}),
		);

/** A schema for an optional request field that clients may also send as
 *  `null`. */
export const optionalNullable = <S extends Schema.Top>(schema: S) =>
	Schema.optionalKey(Schema.NullOr(schema));

export const nowSeconds = Clock.currentTimeMillis.pipe(
	Effect.map((ms) => Math.floor(ms / 1000)),
);
