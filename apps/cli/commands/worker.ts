import { defineCommand } from "citty";
import { identityFilePath, loadIdentity, saveIdentity } from "../identity";
import {
  chatInference,
  embeddingInference,
  fetchAvailableModels,
  getLoadedModel,
  setBackendUrl,
} from "../inference";
import { ServerMessage, parseIncoming } from "../protocol";
import type { ServerMessageType } from "../protocol";
import env from "../env";

const start = defineCommand({
  meta: {
    name: "start",
    description: "Start a worker that connects to a Shoal server",
  },
  args: {
    server: {
      type: "string",
      description: "WebSocket URL of the Shoal server (e.g. wss://server.example.com/ws/workers)",
      required: true,
    },
    token: {
      type: "string",
      description: "API key. Falls back to SHOAL_TOKEN env var.",
    },
    backend: {
      type: "string",
      description: "Inference backend URL",
      // Default to the env var
      default: env.getBackendUrl(),
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
  run({ args }) {
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
    runWorker({
      serverUrl: args.server,
      token,
      backend: args.backend,
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

function runWorker(opts: {
  serverUrl: string;
  token: string;
  backend: string;
  maxConcurrent: number;
  name?: string;
}): void {
  const { serverUrl, token, backend, maxConcurrent, name } = opts;

  // Append token as query param for WebSocket auth
  const wsUrl = `${serverUrl}${serverUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

  setBackendUrl(backend);
  console.log(`[worker] using backend at ${backend}`);

  const startTime = Date.now();
  let jobsCompleted = 0;
  let ws: WebSocket | null = null;
  let reconnectDelay = 1000;
  // In-flight jobs, keyed by jobId, so a server-initiated `cancel` message can
  // abort the underlying backend fetch and free worker capacity rather than
  // running to completion for a consumer that's already gone.
  const inFlight = new Map<string, AbortController>();

  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "stats",
          loadedModel: getLoadedModel(),
          jobsCompleted,
          uptimeMs: Date.now() - startTime,
        }),
      );
    }
  }, 5000);

  async function sendModels(): Promise<void> {
    try {
      const ids = await fetchAvailableModels();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "models",
            models: ids.map((id) => ({ id })),
          }),
        );
      }
    } catch (err) {
      console.error("[worker] failed to fetch models from backend:", (err as Error).message);
    }
  }

  setInterval(sendModels, 30_000);

  // Loaded once and updated in-place when the server returns a fresh secret on
  // initial registration. Persisted to disk only after the server confirms it.
  let identity = loadIdentity(serverUrl);
  if (identity) {
    console.log(`[worker] loaded identity ${identity.workerId} from ${identityFilePath(serverUrl)}`);
  } else {
    console.log(`[worker] no stored identity, will register as new at ${identityFilePath(serverUrl)}`);
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
      console.log(`[worker] disconnected (${detail}), reconnecting in ${reconnectDelay}ms`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    };

    ws.onopen = () => {
      console.log(`[worker] connected, registering`);
      reconnectDelay = 1000;

      if (identity) {
        ws!.send(
          JSON.stringify({
            type: "register_resume",
            workerId: identity.workerId,
            secret: identity.secret,
            maxConcurrent,
            ...(name !== undefined ? { name } : {}),
          }),
        );
      } else {
        ws!.send(
          JSON.stringify({
            type: "register_new",
            maxConcurrent,
            ...(name !== undefined ? { name } : {}),
          }),
        );
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
          console.log(`[worker] registered (new) as ${msg.workerId}, identity saved`);
        } else {
          console.log(`[worker] registered (resumed) as ${msg.workerId}`);
        }
        sendModels();
        return;
      }

      if (msg.type === "ping") {
        ws!.send(JSON.stringify({ type: "pong" }));
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
      const detail = event.reason ? `${event.code} ${event.reason}` : `${event.code}`;

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

  async function handleInfer(msg: Extract<ServerMessageType, { type: "infer" }>) {
    const { jobId, task, model, input, options } = msg;
    const controller = new AbortController();
    inFlight.set(jobId, controller);

    try {
      ws?.send(JSON.stringify({ type: "model_ready", jobId, model }));

      if (task === "chat") {
        const messages = input as unknown[];
        for await (const chunk of chatInference(model, messages, options, controller.signal)) {
          if ("done" in chunk) {
            jobsCompleted++;
            ws?.send(
              JSON.stringify({
                type: "done",
                jobId,
                finishReason: chunk.finishReason,
                usage: chunk.usage,
              }),
            );
          } else {
            ws?.send(
              JSON.stringify({
                type: "delta",
                jobId,
                content: chunk.content,
                toolCalls: chunk.toolCalls,
              }),
            );
          }
        }
      } else if (task === "embedding") {
        const embeddings = await embeddingInference(
          model,
          input as string | string[],
          controller.signal,
        );
        ws?.send(JSON.stringify({ type: "embedding", jobId, vector: embeddings[0] }));
        jobsCompleted++;
        ws?.send(JSON.stringify({ type: "done", jobId, finishReason: "stop" }));
      }
    } catch (err) {
      // Swallow the fetch AbortError silently — the server already knows the
      // job was canceled and is no longer listening on this jobId. Anything
      // else is a real failure worth reporting back.
      if (controller.signal.aborted) {
        console.log(`[worker] job ${jobId} aborted`);
      } else {
        console.error(`[worker] inference error for job ${jobId}:`, err);
        ws?.send(
          JSON.stringify({ type: "error", jobId, message: (err as Error).message ?? "inference failed" }),
        );
      }
    } finally {
      inFlight.delete(jobId);
    }
  }

  connect();
}
