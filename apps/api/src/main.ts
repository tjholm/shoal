import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Database } from "@shoal/db/database";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { Auth } from "./auth";
import { usagePruning } from "./background";
import { ShoalConfig } from "./config";
import { Dispatcher } from "./dispatch";
import { Email } from "./email";
import { authRoutes } from "./http/auth-routes";
import { dashboardRoutes } from "./http/dashboard";
import { liveRoutes } from "./http/live";
import { dashboardAppRoutes } from "./http/static";
import { anthropicRoutes } from "./inference/anthropic";
import { openAIRoutes } from "./inference/openai";
import { Usage } from "./usage";
import { workerGatewayRoutes } from "./workers/gateway";
import { WorkerRegistry } from "./workers/registry";

const Domain = Dispatcher.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(WorkerRegistry.layer, Usage.layer)),
	Layer.provideMerge(Auth.layer),
	Layer.provideMerge(Email.layer),
	Layer.provideMerge(Database.layer),
	Layer.provideMerge(ShoalConfig.layer),
	Layer.provide([FetchHttpClient.layer, BunCrypto.layer]),
);

const Routes = Layer.mergeAll(
	authRoutes,
	dashboardRoutes,
	openAIRoutes,
	anthropicRoutes,
	workerGatewayRoutes,
	liveRoutes,
	dashboardAppRoutes,
);

const Server = Layer.unwrap(
	Effect.map(ShoalConfig, (config) =>
		HttpRouter.serve(Routes).pipe(
			Layer.provide(
				BunHttpServer.layer({
					port: config.port,
					// Streams carry their own keepalives; this only bounds dead sockets.
					idleTimeout: 60,
				}),
			),
		),
	),
);

Layer.mergeAll(Server, usagePruning).pipe(
	Layer.provide(Domain),
	Layer.launch,
	BunRuntime.runMain,
);
