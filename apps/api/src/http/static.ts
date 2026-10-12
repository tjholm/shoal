import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http";
import { ShoalConfig } from "../config";

/** The built dashboard at every non-API path, answering unknown paths with
 *  `index.html` so the browser's router handles deep links. In development
 *  Vite serves the dashboard instead and `SHOAL_DASHBOARD_DIR` is unset. */
export const dashboardAppRoutes = Layer.unwrap(
	Effect.gen(function* () {
		const config = yield* ShoalConfig;
		if (Option.isNone(config.dashboardDir)) return Layer.empty;
		const root = config.dashboardDir.value;
		return Layer.effectDiscard(
			Effect.gen(function* () {
				const router = yield* HttpRouter.HttpRouter;
				const serveFile = yield* HttpStaticServer.make({ root, spa: true });
				yield* router.add("GET", "/*", (request) =>
					isApiPath(request.url)
						? Effect.succeed(HttpServerResponse.empty({ status: 404 }))
						: serveFile.pipe(
								Effect.map((response) =>
									HttpServerResponse.setHeader(
										response,
										"cache-control",
										request.url.includes("/assets/")
											? "public, max-age=31536000, immutable"
											: "no-cache",
									),
								),
								Effect.orDie,
							),
				);
			}),
		);
	}),
);

function isApiPath(url: string): boolean {
	return /^\/(api|ws)(\/|$|\?)/.test(url);
}
