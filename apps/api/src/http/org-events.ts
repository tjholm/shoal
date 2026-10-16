import { Effect, Option, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Auth } from "../auth";
import { formatEvent, sseResponse } from "./sse";

/** A route handler that streams `events` for the signed-in session's active
 *  organization as server-sent events, each named by its `type`. */
export const orgEventStream = <A extends { readonly type: string }>(
	auth: Auth["Service"],
	events: (organizationId: string) => Stream.Stream<A>,
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const session = yield* auth.getSession(new Headers(request.headers));
		if (Option.isNone(session)) {
			return HttpServerResponse.text("unauthorized", { status: 401 });
		}
		const organizationId = session.value.activeOrganizationId;
		if (organizationId === null) {
			return HttpServerResponse.text("no active organization", { status: 400 });
		}
		return sseResponse(
			events(organizationId).pipe(
				Stream.map((event) => formatEvent({ event: event.type, data: event })),
			),
		);
	});
