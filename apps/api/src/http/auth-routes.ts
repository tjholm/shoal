import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Auth } from "../auth";

/** better-auth's endpoints, under `/api/auth/*`. */
export const authRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const auth = yield* Auth;
		const handle = Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const web = yield* HttpServerRequest.toWeb(request);
			return HttpServerResponse.fromWeb(yield* auth.handle(web));
		}).pipe(Effect.orDie);
		yield* router.add("GET", "/api/auth/*", handle);
		yield* router.add("POST", "/api/auth/*", handle);
		yield* router.add("GET", "/api/healthz", HttpServerResponse.jsonUnsafe({ status: "ok" }));
	}),
);
