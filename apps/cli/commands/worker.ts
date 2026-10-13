import { FetchHttpClient } from "effect/http";
import { Array as Arr, Config, Effect, Layer, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { Socket } from "effect/socket";
import { IdentityStore } from "@shoal/client-core/identity";
import { InferenceClient } from "@shoal/client-core/inference";
import { runWorker } from "@shoal/client-core/worker";

class NoBackendsConfigured extends Schema.TaggedError<NoBackendsConfigured>()(
	"NoBackendsConfigured",
	{},
) {
	get message(): string {
		return "No backend URLs configured. Pass --backend <url> (repeat or comma-separate for multiple) or set BACKEND_URL.";
	}
}

const server = Flag.String("server").pipe(
	Flag.withDescription(
		"WebSocket URL of the Shoal server (e.g. wss://server.example.com/ws/workers)",
	),
);

const token = Flag.Redacted("token").pipe(
	Flag.withDescription(
		"API key. Falls back to SHOAL_TOKEN env var. Create one with Connect worker or on the API keys page of the dashboard.",
	),
	Flag.withFallbackConfig(Config.Redacted("SHOAL_TOKEN")),
);

const backends = Flag.String("backend").pipe(
	Flag.withDescription(
		"Inference backend URL. Repeat the flag or comma-separate to use multiple backends; jobs are routed per-model. Falls back to BACKEND_URL (comma-separated).",
	),
	Flag.atLeast(1),
	Flag.withFallbackConfig(
		Config.String("BACKEND_URL").pipe(
			Config.withDefault("http://localhost:11434"),
			Config.map((url) => [url]),
		),
	),
	Flag.map((values) =>
		values
			.flatMap((value) => value.split(","))
			.map((part) => part.trim())
			.filter((part) => part.length > 0),
	),
);

const concurrency = Flag.Int("concurrency").pipe(
	Flag.withDescription("Max concurrent jobs"),
	Flag.withSchema(Schema.Int.check(Schema.isGreaterThan(0))),
	Flag.withDefault(1),
);

const name = Flag.String("name").pipe(
	Flag.withDescription(
		"Friendly name advertised to the server. Overwrites any name set via the dashboard on every connect.",
	),
	Flag.optional,
);

const start = Command.make(
	"start",
	{ server, token, backends, concurrency, name },
	Effect.fn(function* (args) {
		if (!Arr.isReadonlyArrayNonEmpty(args.backends)) {
			return yield* new NoBackendsConfigured();
		}
		yield* Effect.log(`using backend(s): ${args.backends.join(", ")}`);
		yield* runWorker({
			serverUrl: args.server,
			token: Redacted.value(args.token),
			maxConcurrent: args.concurrency,
			name: args.name,
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					InferenceClient.layer(args.backends),
					IdentityStore.layer(args.server),
					Socket.layerWebSocketConstructorGlobal,
				).pipe(Layer.provide(FetchHttpClient.layer)),
			),
		);
	}),
).pipe(
	Command.withDescription("Start a worker that connects to a Shoal server"),
);

export const workerCommand = Command.make("worker").pipe(
	Command.withDescription("Run a Shoal inference worker"),
	Command.withSubcommands([start]),
);
