import { defineCommand } from "citty";
import env from "../env";
import { identityFilePath, loadIdentity, saveIdentity } from "../identity";
import { createInferenceClient } from "../inference";
import type { ServerMessageType, WorkerMessageType } from "../protocol";
import { parseIncoming, ServerMessage } from "../protocol";

const start = defineCommand({
	meta: {
		name: "start",
		description: "Start a worker that connects to a Shoal server",
	},
	args: {
		server: {
			type: "string",
			description:
				"WebSocket URL of the Shoal server (e.g. wss://server.example.com/ws/workers)",
			required: true,
		},
		token: {
			type: "string",
			description: "API key. Falls back to SHOAL_TOKEN env var.",
		},
		backend: {
			type: "string",
			description:
				"Inference backend URL. Repeat the flag or comma-separate to use multiple backends; jobs are routed per-model. Falls back to BACKEND_URL (comma-separated).",
		},
		concurrency: {
			type: "string",
			description: "Max concurrent jobs",
			default: "1",
		},
		name: {
			type: "string",
			description:
				"Friendly name advertised to the server. Overwrites any name set via the dashboard on every connect.",
		},
	},
	run({ args, rawArgs }) {
		const token = args.token ?? process.env.SHOAL_TOKEN;
		if (!token) {
			console.error(
				"Missing --token. Set via --token <key> or SHOAL_TOKEN env var. Create a key at /settings on the dashboard.",
			);
			process.exit(1);
		}
		const maxConcurrent = Number.parseInt(args.concurrency, 10);
		if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
			console.error(
				`Invalid --concurrency: ${args.concurrency}. Must be a positive integer.`,
			);
			process.exit(1);
		}
		// citty's parser (mri) only keeps the LAST value when a flag is repeated,
		// so for per-model routing we re-scan rawArgs to collect every --backend.
		// Falling back to BACKEND_URL (comma-separated) preserves the pre-multi
		// behavior for users still on a single backend.
		const backendUrls = collectBackendArgs(rawArgs);
		const resolved =
			backendUrls.length > 0 ? backendUrls : env.getBackendUrls();
		if (resolved.length === 0) {
			console.error(
				"No backend URLs configured. Pass --backend <url> (repeat or comma-separate for multiple) or set BACKEND_URL.",
			);
			process.exit(1);
		}
		runWorker({
			serverUrl: args.server,
			token,
			backendUrls: resolved,
			maxConcurrent,
			name: args.name,
		});
	},
});

export const workerCommand = defineCommand({
	meta: {
		name: "worker",
		description: "Run a Shoal inference worker",
	},
	subCommands: { start },
});

type InferMessage = Extract<ServerMessageType, { type: "infer" }>;

/** Pull every `--backend X` / `--backend=X` occurrence out of the raw argv.
 * Each value is also split on `,` so users can mix-and-match repetition and
 * comma-separation without thinking about it. Empty entries are dropped. */
function collectBackendArgs(rawArgs: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < rawArgs.length; i++) {
		const a = rawArgs[i];
		let value: string | undefined;
		if (a === "--backend") {
			value = rawArgs[i + 1];
			i++;
		} else if (a?.startsWith("--backend=")) {
			value = a.slice("--backend=".length);
		}
		if (value === undefined) continue;
		for (const part of value.split(",")) {
			const trimmed = part.trim();
			if (trimmed.length > 0) out.push(trimmed);
		}
	}
	return out;
}

function runWorker(opts: {
	serverUrl: string;
	token: string;
	backendUrls: string[];
	maxConcurrent: number;
	name?: string;
}): void {
	const { serverUrl, token, backendUrls, maxConcurrent, name } = opts;

	// Append token as query param for WebSocket auth
	const wsUrl = `${serverUrl}${serverUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

	const client = createInferenceClient({ backendUrls });
	console.log(`[worker] using backend(s): ${backendUrls.join(", ")}`);

	const startTime = Date.now();
	let jobsCompleted = 0;
	// Models the worker's backends report as currently resident. Refreshed on
	// every stats tick by polling each backend's residency endpoint (Ollama
	// /api/ps, LM Studio per-entry state, llama-swap /running); stateless
	// backends contribute their advertised set. The server uses this for
	// warm-vs-cold routing decisions in pickWorker.
	let loadedModels: string[] = [];
	let ws: WebSocket | null = null;
	let reconnectDelay = 1000;
	// In-flight jobs, keyed by jobId, so a server-initiated `cancel` message can
	// abort the underlying backend fetch and free worker capacity rather than
	// running to completion for a consumer that's already gone.
	const inFlight = new Map<string, AbortController>();

	/** Send a typed protocol message if the socket is connected. Drops the
	 * message silently otherwise — calling `.send()` on a CLOSING/CLOSED socket
	 * throws, and during a reconnect cycle the server is already treating us as
	 * gone. The next post-reconnect `stats`/`models` tick will resync. */
	function send(msg: WorkerMessageType): void {
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	}

	/** Probe every backend in one pass, then send both messages. One loop so
	 *  the model catalog and the loaded-models report are always derived from
	 *  the same probe — never two separate refreshes that could race or fall
	 *  out of sync. */
	async function refreshAndReport(): Promise<void> {
		try {
			const { models, loaded } = await client.refresh();
			loadedModels = loaded;
			send({ type: "models", models });
		} catch (err) {
			// Per-backend errors are already logged inside the client; this catch
			// only fires on an unexpected throw outside the per-backend try/catch.
			// Keep the last-known loadedModels value rather than collapsing to [].
			console.error("[worker] refresh failed:", (err as Error).message);
		}
		send({
			type: "stats",
			loadedModels,
			jobsCompleted,
			uptimeMs: Date.now() - startTime,
		});
	}

	setInterval(refreshAndReport, 10_000);

	// Loaded once and updated in-place when the server returns a fresh secret on
	// initial registration. Persisted to disk only after the server confirms it.
	let identity = loadIdentity(serverUrl);
	if (identity) {
		console.log(
			`[worker] loaded identity ${identity.workerId} from ${identityFilePath(serverUrl)}`,
		);
	} else {
		console.log(
			`[worker] no stored identity, will register as new at ${identityFilePath(serverUrl)}`,
		);
	}

	function connect(): void {
		console.log(`[worker] connecting to ${serverUrl}`);
		ws = new WebSocket(wsUrl);
		// Guards against double-scheduling when both `onerror` and `onclose` fire
		// for the same socket (normal path), while still letting `onerror` schedule
		// a reconnect on its own when `onclose` doesn't fire — which happens in
		// Bun if the initial TCP connect fails (server down at startup).
		let reconnectScheduled = false;
		const scheduleReconnect = (detail: string) => {
			if (reconnectScheduled) return;
			reconnectScheduled = true;
			console.log(
				`[worker] disconnected (${detail}), reconnecting in ${reconnectDelay}ms`,
			);
			setTimeout(connect, reconnectDelay);
			reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
		};

		ws.onopen = () => {
			console.log(`[worker] connected, registering`);
			reconnectDelay = 1000;

			if (identity) {
				send({
					type: "register_resume",
					workerId: identity.workerId,
					secret: identity.secret,
					maxConcurrent,
					...(name !== undefined ? { name } : {}),
				});
			} else {
				send({
					type: "register_new",
					maxConcurrent,
					...(name !== undefined ? { name } : {}),
				});
			}
		};

		ws.onmessage = (event) => {
			const msg = parseIncoming(ServerMessage, event.data as string);
			if (!msg) return;

			if (msg.type === "registered") {
				if (msg.secret) {
					// First-time registration — persist credentials so future reconnects
					// can resume the same identity.
					identity = { workerId: msg.workerId, secret: msg.secret };
					saveIdentity(serverUrl, identity);
					console.log(
						`[worker] registered (new) as ${msg.workerId}, identity saved`,
					);
				} else {
					console.log(`[worker] registered (resumed) as ${msg.workerId}`);
				}
				// Kick off an immediate refresh so the server sees our model
				// catalog and loaded set without waiting for the next 10s tick.
				void refreshAndReport();
				return;
			}

			if (msg.type === "ping") {
				send({ type: "pong" });
				return;
			}

			if (msg.type === "infer") {
				handleInfer(msg);
				return;
			}

			if (msg.type === "cancel") {
				const ctl = inFlight.get(msg.jobId);
				if (ctl) {
					console.log(`[worker] cancel received for job ${msg.jobId}`);
					ctl.abort();
				}
			}
		};

		ws.onclose = (event) => {
			const detail = event.reason
				? `${event.code} ${event.reason}`
				: `${event.code}`;

			// 1008 means policy violation — server rejected our credentials. Bail
			// loudly instead of reconnecting forever; the user needs to take action.
			if (event.code === 1008) {
				console.error(
					`[worker] credentials rejected by server (${detail}). ` +
						`If you've reset the server's database, delete ${identityFilePath(serverUrl)} ` +
						`and restart to re-register as a new worker.`,
				);
				process.exit(1);
			}

			scheduleReconnect(detail);
		};

		ws.onerror = (err) => {
			console.error(`[worker] socket error:`, err);
			scheduleReconnect("socket error");
		};
	}

	async function handleInfer(msg: InferMessage): Promise<void> {
		const { jobId, model } = msg;
		const controller = new AbortController();
		inFlight.set(jobId, controller);

		try {
			send({ type: "model_ready", jobId, model });
			await runTask(msg, controller.signal);
		} catch (err) {
			// Swallow the fetch AbortError silently — the server already knows the
			// job was canceled and is no longer listening on this jobId. Anything
			// else is a real failure worth reporting back.
			if (controller.signal.aborted) {
				console.log(`[worker] job ${jobId} aborted`);
			} else {
				console.error(`[worker] inference error for job ${jobId}:`, err);
				send({
					type: "error",
					jobId,
					message: (err as Error).message ?? "inference failed",
				});
			}
		} finally {
			inFlight.delete(jobId);
		}
	}

	async function runTask(
		msg: InferMessage,
		signal: AbortSignal,
	): Promise<void> {
		const { jobId, task, model, input, options } = msg;
		switch (task) {
			case "chat":
				return runChat(jobId, model, input as unknown[], options, signal);
			case "embedding":
				return runOneShot(jobId, async () => {
					const v = await client.embedding(
						model,
						input as string | string[],
						signal,
					);
					return { type: "embedding", jobId, vector: v[0] };
				});
			case "image":
				return runOneShot(jobId, async () => {
					const images = await client.image(
						model,
						input as string,
						options?.image,
						signal,
					);
					return { type: "image", jobId, images };
				});
			case "tts":
				return runOneShot(jobId, async () => {
					const audio = await client.speech(
						model,
						input as string,
						options?.tts,
						signal,
					);
					return {
						type: "audio",
						jobId,
						b64: audio.b64,
						mimeType: audio.mimeType,
					};
				});
			default:
				throw new Error(`Unknown task: ${task satisfies never}`);
		}
	}

	async function runChat(
		jobId: string,
		model: string,
		messages: unknown[],
		options: InferMessage["options"],
		signal: AbortSignal,
	): Promise<void> {
		for await (const chunk of client.chat(model, messages, options, signal)) {
			if ("done" in chunk) {
				jobsCompleted++;
				send({
					type: "done",
					jobId,
					finishReason: chunk.finishReason,
					usage: chunk.usage,
				});
			} else {
				send({
					type: "delta",
					jobId,
					content: chunk.content,
					toolCalls: chunk.toolCalls,
				});
			}
		}
	}

	/** Run a non-streaming task: await the inference, send its single result
	 * message, then a terminal `done`. Used for embedding, image, and tts. */
	async function runOneShot(
		jobId: string,
		produce: () => Promise<WorkerMessageType>,
	): Promise<void> {
		const result = await produce();
		send(result);
		jobsCompleted++;
		send({ type: "done", jobId, finishReason: "stop" });
	}

	connect();
}
