import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeServices } from "@effect/platform-node";
import { createHost, type Host, isPaused, type SettingsOverrides } from "@shoal/client-core/host";
import { fileTokens } from "@shoal/client-core/settings";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { isLoopback, startUiServer } from "../ui-server";

// Replaced at bundle time by `bun build --define` in the publish workflow.
declare const __SHOAL_VERSION__: string | undefined;

class NotConfigured extends Schema.TaggedError<NotConfigured>()("NotConfigured", {}) {
	get message(): string {
		return "No server or API key set. Pass --server and --token (or set SHOAL_TOKEN), or run with --ui to set the worker up from a browser.";
	}
}

class WorkerStopped extends Schema.TaggedError<WorkerStopped>()("WorkerStopped", { reason: Schema.String }) {
	get message(): string {
		return `The worker stopped: ${this.reason}`;
	}
}

class BadOption extends Schema.TaggedError<BadOption>()("BadOption", { reason: Schema.String }) {
	get message(): string {
		return this.reason;
	}
}

const server = Flag.String("server").pipe(
	Flag.withDescription(
		"The Shoal server: its web address (https://shoal.example.com) or worker WebSocket URL (wss://shoal.example.com/ws/workers). Overrides the saved server.",
	),
	Flag.optional,
);

const token = Flag.Redacted("token").pipe(
	Flag.withDescription(
		"API key. Falls back to SHOAL_TOKEN, then the saved key. Create one with Connect worker or on the API keys page of the dashboard.",
	),
	Flag.optional,
);

const backends = Flag.String("backend").pipe(
	Flag.withDescription(
		"Inference backend URL. Repeat the flag or comma-separate to use multiple backends; jobs are routed per-model. Falls back to BACKEND_URL (comma-separated), then the saved backends, then http://localhost:11434.",
	),
	Flag.atLeast(0),
);

const concurrency = Flag.Int("concurrency").pipe(
	Flag.withDescription("Max concurrent jobs. Overrides the saved setting; 1 when nothing is saved."),
	Flag.withSchema(Schema.Int.check(Schema.isGreaterThan(0))),
	Flag.optional,
);

const name = Flag.String("name").pipe(
	Flag.withDescription(
		"Friendly name advertised to the server. Overwrites any name set via the dashboard on every connect.",
	),
	Flag.optional,
);

const ui = Flag.Boolean("ui").pipe(
	Flag.withDescription(
		"Serve a web page for watching and setting up this worker. Starts even before a server and API key are set.",
	),
	Flag.withDefault(false),
);

const uiHost = Flag.String("ui-host").pipe(
	Flag.withDescription(
		"Address the web page listens on. Falls back to SHOAL_UI_HOST, then 127.0.0.1. Anything but loopback needs --ui-tls-cert and --ui-tls-key, or --ui-insecure.",
	),
	Flag.withFallbackConfig(Config.String("SHOAL_UI_HOST")),
	Flag.withDefault("127.0.0.1"),
);

const uiPort = Flag.Int("ui-port").pipe(
	Flag.withDescription("Port the web page listens on. Falls back to SHOAL_UI_PORT, then 7337."),
	Flag.withFallbackConfig(Config.Int("SHOAL_UI_PORT")),
	Flag.withDefault(7337),
);

const uiTlsCert = Flag.String("ui-tls-cert").pipe(
	Flag.withDescription("PEM certificate file for serving the web page over HTTPS."),
	Flag.optional,
);

const uiTlsKey = Flag.String("ui-tls-key").pipe(
	Flag.withDescription("PEM private key file for --ui-tls-cert."),
	Flag.optional,
);

const uiInsecure = Flag.Boolean("ui-insecure").pipe(
	Flag.withDescription(
		"Allow plain HTTP on an address other than loopback, for when TLS ends at a proxy or tunnel in front of the worker. Otherwise the access token and API keys cross the network unencrypted.",
	),
	Flag.withDefault(false),
);

/** Where the built web UI is: beside the published bundle, or the workspace package's build in development. */
const uiAssetsDir = () =>
	typeof __SHOAL_VERSION__ === "string"
		? path.join(import.meta.dirname, "ui")
		: path.resolve(import.meta.dirname, "../../../packages/worker-ui/dist");

/** The server's web address, from either it or its worker WebSocket URL. */
const serverOrigin = (input: string) => {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error(`--server ${input} isn't a URL.`);
	}
	const protocol = { "ws:": "http:", "wss:": "https:", "http:": "http:", "https:": "https:" }[url.protocol];
	if (protocol === undefined || !["/", "/ws/workers"].includes(url.pathname.replace(/\/$/, "") || "/")) {
		throw new Error(`--server ${input} should be the server's web address or its /ws/workers URL.`);
	}
	return `${protocol}//${url.host}`;
};

/** The UI's access token: SHOAL_UI_TOKEN, else one kept in `dir`, made on first use. */
const loadAccessToken = (dir: string, fromEnv: Option.Option<Redacted.Redacted<string>>) =>
	Effect.tryPromise(async () => {
		if (Option.isSome(fromEnv)) return { token: Redacted.value(fromEnv.value), file: null };
		const file = path.join(dir, "ui-token");
		try {
			return { token: (await readFile(file, "utf8")).trim(), file };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const token = randomBytes(32).toString("base64url");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(file, `${token}\n`, { mode: 0o600 });
		await chmod(file, 0o600);
		return { token, file };
	});

/** Fails when the worker stops for good, e.g. the server rejected the API key. */
const untilStopped = (host: Host) =>
	Effect.callback<never, WorkerStopped>((resume) => {
		const stop = (state: ReturnType<Host["state"]>) => {
			if (state.status === "stopped") resume(Effect.fail(new WorkerStopped({ reason: state.detail ?? "unknown" })));
		};
		stop(host.state());
		return Effect.sync(host.subscribe(stop));
	});

const start = Command.make(
	"start",
	{ server, token, backends, concurrency, name, ui, uiHost, uiPort, uiTlsCert, uiTlsKey, uiInsecure },
	Effect.fn(function* (args) {
		const stateRoot = yield* Config.String("XDG_STATE_HOME").pipe(
			Config.withDefault(path.join(os.homedir(), ".local", "state")),
		);
		const dir = yield* Config.String("SHOAL_HOME").pipe(Config.withDefault(path.join(stateRoot, "shoal")));
		const envToken = yield* Config.option(Config.Redacted("SHOAL_TOKEN"));
		const envBackends = yield* Config.option(Config.String("BACKEND_URL"));
		const envUiToken = yield* Config.option(Config.Redacted("SHOAL_UI_TOKEN"));

		const backendList = (values: ReadonlyArray<string>) =>
			values
				.flatMap((value) => value.split(","))
				.map((part) => part.trim())
				.filter((part) => part.length > 0);
		const flagBackends = backendList(args.backends);
		const tokenSource = Option.isSome(args.token)
			? Option.some({ value: Redacted.value(args.token.value), from: "--token" })
			: Option.map(envToken, (value) => ({ value: Redacted.value(value), from: "SHOAL_TOKEN" }));
		const backendSource =
			flagBackends.length > 0
				? Option.some({ value: flagBackends, from: "--backend" })
				: Option.map(envBackends, (value) => ({ value: backendList([value]), from: "BACKEND_URL" }));

		if (Option.isSome(backendSource) && backendSource.value.value.length === 0) {
			return yield* new BadOption({ reason: `${backendSource.value.from} lists no backends.` });
		}

		const origin = yield* Effect.try({
			try: () => Option.map(args.server, serverOrigin),
			catch: (error) => new BadOption({ reason: (error as Error).message }),
		});

		const overrides: SettingsOverrides = {
			...(Option.isSome(origin) && { serverUrl: { value: origin.value, from: "--server" } }),
			...(Option.isSome(tokenSource) && { token: tokenSource.value }),
			...(Option.isSome(backendSource) && { backends: backendSource.value }),
			...(Option.isSome(args.name) && { name: { value: args.name.value, from: "--name" } }),
			...(Option.isSome(args.concurrency) && { concurrency: { value: args.concurrency.value, from: "--concurrency" } }),
		};

		const tls = yield* Effect.gen(function* () {
			if (Option.isNone(args.uiTlsCert) && Option.isNone(args.uiTlsKey)) return undefined;
			if (Option.isNone(args.uiTlsCert) || Option.isNone(args.uiTlsKey)) {
				return yield* new BadOption({ reason: "--ui-tls-cert and --ui-tls-key go together." });
			}
			const certFile = args.uiTlsCert.value;
			const keyFile = args.uiTlsKey.value;
			return yield* Effect.tryPromise({
				try: async () => ({ cert: await readFile(certFile), key: await readFile(keyFile) }),
				catch: (error) => new BadOption({ reason: `Couldn't read the TLS files: ${(error as Error).message}` }),
			});
		});
		if (args.ui && !isLoopback(args.uiHost) && tls === undefined && !args.uiInsecure) {
			return yield* new BadOption({
				reason: `--ui-host ${args.uiHost} reaches beyond this machine. Pass --ui-tls-cert and --ui-tls-key, or --ui-insecure if TLS ends in front of the worker.`,
			});
		}

		const host = yield* Effect.acquireRelease(
			Effect.promise(() => createHost({ dir, tokens: fileTokens(dir), platform: NodeServices.layer, overrides })),
			(host) => Effect.promise(() => host.stop()),
		);

		if (!args.ui) {
			if (host.state().status === "not-configured") return yield* new NotConfigured();
			yield* Effect.log(`using backend(s): ${host.settings()?.backends.join(", ")}`);
			// Switched off or paused from --ui earlier; without it, nothing here can switch work back on.
			const { availability } = host.state();
			if (availability === "off") {
				yield* Effect.logWarning(
					"Work is switched off in this worker's saved settings, so it won't take jobs. Run with --ui to switch it on.",
				);
			} else if (isPaused(availability)) {
				yield* Effect.logWarning(
					`Work is paused in this worker's saved settings until ${new Date(availability.pausedUntil).toLocaleString()}.`,
				);
			}
			return yield* untilStopped(host);
		}

		const assetsDir = uiAssetsDir();
		const access = yield* loadAccessToken(dir, envUiToken);
		const uiServer = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: async () => {
					await readFile(path.join(assetsDir, "index.html")).catch(() => {
						throw new Error(
							`The web UI isn't built at ${assetsDir}. Run \`bun run --filter @shoal/worker-ui build\` first.`,
						);
					});
					return startUiServer({
						host,
						bindHost: args.uiHost,
						port: args.uiPort,
						accessToken: access.token,
						tls,
						assetsDir,
					});
				},
				catch: (error) => new BadOption({ reason: error instanceof Error ? error.message : String(error) }),
			}),
			(server) => Effect.promise(() => server.close()),
		);
		// A terminal is for the person starting it; logs collected by a service manager tend to be kept and shared.
		const shown = process.stdout.isTTY
			? `${uiServer.url}#token=${access.token}`
			: `${uiServer.url} (access token in ${access.file ?? "SHOAL_UI_TOKEN"})`;
		yield* Effect.log(`worker UI at ${shown}`);
		return yield* Effect.never;
	}, Effect.scoped),
).pipe(Command.withDescription("Start a worker that connects to a Shoal server"));

export const workerCommand = Command.make("worker").pipe(
	Command.withDescription("Run a Shoal inference worker"),
	Command.withSubcommands([start]),
);
