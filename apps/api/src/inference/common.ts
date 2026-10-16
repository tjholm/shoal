import { Clock, Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { Auth, type Principal } from "../auth";

/** Names a failure clients may handle differently, such as retrying when
 *  workers are busy but not when no worker serves the model. */
export type ErrorCode = "model_not_found" | "model_offline" | "workers_busy";

/** How an API dialect renders an error body. */
export type ErrorBody = (message: string, status: number, code?: ErrorCode) => unknown;

export const openAIError: ErrorBody = (message, status, code) => ({
	error: { message, type: "error", code: code ?? status },
});

/** Anthropic has no `code` field; its error `type` carries the distinction. */
const anthropicErrorType: Record<ErrorCode, string> = {
	model_not_found: "not_found_error",
	model_offline: "api_error",
	workers_busy: "overloaded_error",
};

export const anthropicError: ErrorBody = (message, _status, code) => ({
	type: "error",
	error: {
		type: code === undefined ? "invalid_request_error" : anthropicErrorType[code],
		message,
	},
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

/** Render failures of an inference handler: API errors with their status, a
 *  model no worker serves as 404, a model only offline workers serve or busy
 *  workers as 503, anything else (a failed job) as 500. */
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
				const { status, code } = httpFailure(err);
				return Effect.succeed(
					HttpServerResponse.jsonUnsafe(
						status === 401
							? { error: { message: err.message, type: "auth_error", code: 401 } }
							: errorBody(err.message, status, code),
						{ status },
					),
				);
			}),
		);

function httpFailure(err: { readonly _tag: string }): { status: number; code?: ErrorCode } {
	if (err instanceof ApiFailure) return { status: err.status };
	switch (err._tag) {
		case "ModelNotServed":
			return { status: 404, code: "model_not_found" };
		case "ModelOffline":
			return { status: 503, code: "model_offline" };
		case "WorkersBusy":
			return { status: 503, code: "workers_busy" };
		default:
			return { status: 500 };
	}
}

/** A schema for an optional request field that clients may also send as
 *  `null`. */
export const optionalNullable = <S extends Schema.Top>(schema: S) =>
	Schema.optionalKey(Schema.NullOr(schema));

export const nowSeconds = Clock.currentTimeMillis.pipe(
	Effect.map((ms) => Math.floor(ms / 1000)),
);
