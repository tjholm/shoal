import { db, schema } from "@shoal/db";
import type { ServerMessage, WorkerMessage } from "@shoal/protocol";
import { getWorker, notifyWorkerChanged, pickWorker } from "./workers.ts";

/** Accumulated tool call state during a job. */
interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

interface Job {
  jobId: string;
  workerId: string;
  organizationId: string;
  /** Snapshot of the worker's keyId at dispatch time, so key rotation
   * mid-job doesn't move the resulting usage_event onto the new key. */
  keyId: string | null;
  task: "chat" | "embedding";
  model: string;
  streaming: boolean;
  /** Wall-clock dispatch time, ms epoch. Used for duration_ms on usage_event. */
  startedAt: number;
  /** For streaming: the controller to push raw stream events into. */
  eventController?: ReadableStreamDefaultController<StreamEvent>;
  /** Accumulated text content across deltas (used for non-streaming and final result). */
  content: string;
  /** Accumulated tool calls keyed by index. */
  toolCalls: Map<number, ToolCallAccumulator>;
  /** Embedding vector (embedding tasks only). */
  embedding?: number[];
  /** Resolves the non-streaming response promise. */
  resolve?: (value: JobResult) => void;
  reject?: (reason: Error) => void;
}

/** A complete tool call as reconstructed at the end of a job. */
export interface JobToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/**
 * A streaming fragment of a tool call. `index` is the upstream call index
 * (stable across all fragments of the same call); `id` and `name` arrive
 * once on the first fragment, `arguments` arrives as JSON string slices.
 */
export interface JobToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface JobUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface JobResult {
  content: string;
  toolCalls: JobToolCall[];
  finishReason: "stop" | "length" | "tool_calls";
  embedding?: number[];
  usage?: JobUsage;
}

/** Raw stream event surface for API handlers (OpenAI / Anthropic). */
export type StreamEvent =
  | { type: "delta"; content?: string; toolCalls?: JobToolCallDelta[] }
  | { type: "done"; finishReason: "stop" | "length" | "tool_calls"; usage?: JobUsage }
  | { type: "error"; message: string };

const JOBS_KEY = "__shoal_jobs__";
const _global = globalThis as Record<string, unknown>;
if (!_global[JOBS_KEY]) {
  _global[JOBS_KEY] = new Map<string, Job>();
}
const jobs = _global[JOBS_KEY] as Map<string, Job>;

function newJobId(): string {
  return crypto.randomUUID();
}

export interface DispatchOpts {
  organizationId: string;
  task: "chat" | "embedding";
  model: string;
  input: unknown;
  streaming: boolean;
  maxTokens?: number;
  temperature?: number;
  tools?: unknown[];
  toolChoice?: unknown;
}

/**
 * Dispatch an inference job. For streaming requests returns a raw event stream
 * the caller can format into OpenAI/Anthropic SSE. For non-streaming, returns
 * a promise that resolves to the full reconstructed result.
 */
export function dispatchJob(opts: DispatchOpts):
  | { jobId: string; stream: ReadableStream<StreamEvent> }
  | { jobId: string; promise: Promise<JobResult> } {
  const worker = pickWorker(opts.model, opts.organizationId);
  if (!worker) {
    throw new ServiceUnavailableError("No workers available");
  }

  const jobId = newJobId();
  worker.inFlight++;
  notifyWorkerChanged(worker.workerId);

  const inferMsg: ServerMessage = {
    type: "infer" as const,
    jobId,
    task: opts.task,
    model: opts.model,
    input: opts.input,
    options: {
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      tools: opts.tools,
      toolChoice: opts.toolChoice,
    },
  };
  worker.ws.send(JSON.stringify(inferMsg));

  if (opts.streaming) {
    const job: Job = {
      jobId,
      workerId: worker.workerId,
      organizationId: opts.organizationId,
      keyId: worker.keyId,
      task: opts.task,
      model: opts.model,
      streaming: true,
      startedAt: Date.now(),
      content: "",
      toolCalls: new Map(),
    };
    jobs.set(jobId, job);

    const stream = new ReadableStream<StreamEvent>({
      start(c) {
        job.eventController = c;
      },
      cancel() {
        const j = jobs.get(jobId);
        if (j) {
          const w = getWorker(j.workerId);
          if (w) {
            // Tell the worker to abort the underlying inference. Without
            // this, the worker would run the request to completion and stay
            // busy serving a consumer that's already gone — wasting capacity
            // and causing the next dispatch attempt to see "No workers
            // available" until the orphaned job finishes.
            try {
              w.ws.send(JSON.stringify({ type: "cancel", jobId } satisfies ServerMessage));
            } catch {
              // Worker WS already dead; rejectWorkerJobs will reap on close.
            }
            if (w.inFlight > 0) {
              w.inFlight--;
              notifyWorkerChanged(j.workerId);
            }
          }
          jobs.delete(jobId);
        }
      },
    });

    return { jobId, stream };
  }

  const { promise, resolve, reject } = Promise.withResolvers<JobResult>();

  const job: Job = {
    jobId,
    workerId: worker.workerId,
    organizationId: opts.organizationId,
    keyId: worker.keyId,
    task: opts.task,
    model: opts.model,
    streaming: false,
    startedAt: Date.now(),
    content: "",
    toolCalls: new Map(),
    resolve,
    reject,
  };
  jobs.set(jobId, job);

  return { jobId, promise };
}

function finalToolCalls(job: Job): JobToolCall[] {
  return [...job.toolCalls.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ index, id, name, arguments: args }) => ({ index, id, name, arguments: args }));
}

async function writeUsageEvent(
  job: Job,
  finishReason: "stop" | "length" | "tool_calls",
  usage: JobUsage,
): Promise<void> {
  try {
    await db.insert(schema.usageEvent).values({
      id: crypto.randomUUID(),
      organizationId: job.organizationId,
      workerId: job.workerId,
      keyId: job.keyId,
      model: job.model,
      task: job.task,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      finishReason,
      durationMs: Date.now() - job.startedAt,
    });
  } catch (err) {
    // We don't want a stats-write failure to fail the user-facing response —
    // the response has already been emitted by this point. Log loudly.
    console.error("[dispatch] failed to write usage_event:", err);
  }
}

/**
 * Apply an incoming worker message to the job it references. `peerWorkerId`
 * is the authenticated peer that sent it; messages are ignored unless the
 * referenced job was actually dispatched to that peer.
 */
export function handleJobMessage(msg: WorkerMessage, peerWorkerId: string): void {
  if (msg.type === "delta") {
    const job = jobs.get(msg.jobId);
    if (!job || job.workerId !== peerWorkerId) return;

    if (msg.content) job.content += msg.content;

    const emittedToolCalls: JobToolCallDelta[] = [];
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        let acc = job.toolCalls.get(tc.index);
        if (!acc) {
          acc = { index: tc.index, id: tc.id ?? "", name: tc.name ?? "", arguments: "" };
          job.toolCalls.set(tc.index, acc);
        } else {
          if (tc.id) acc.id = tc.id;
          if (tc.name) acc.name = tc.name;
        }
        if (tc.arguments) acc.arguments += tc.arguments;
        emittedToolCalls.push({
          index: tc.index,
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }
    }

    if (job.streaming && job.eventController) {
      try {
        job.eventController.enqueue({
          type: "delta",
          content: msg.content,
          toolCalls: emittedToolCalls.length > 0 ? emittedToolCalls : undefined,
        });
      } catch {
        jobs.delete(msg.jobId);
      }
    }
  } else if (msg.type === "embedding") {
    const job = jobs.get(msg.jobId);
    if (!job || job.workerId !== peerWorkerId) return;
    job.embedding = msg.vector;
  } else if (msg.type === "done") {
    const job = jobs.get(msg.jobId);
    if (!job || job.workerId !== peerWorkerId) return;

    const worker = getWorker(job.workerId);
    if (worker) {
      if (worker.inFlight > 0) worker.inFlight--;
      worker.loadedModel = job.model;
      worker.jobsCompleted++;
      notifyWorkerChanged(job.workerId);
    }

    // Record completed work for billing/observability. Skip embeddings since
    // backends don't report usage for them, and skip if we have no usage at
    // all — a row with prompt=0 completion=0 would falsely contribute zero
    // tokens to rollups.
    if (job.task === "chat" && msg.usage) {
      void writeUsageEvent(job, msg.finishReason, msg.usage);
    }

    if (job.streaming && job.eventController) {
      try {
        job.eventController.enqueue({
          type: "done",
          finishReason: msg.finishReason,
          usage: msg.usage,
        });
        job.eventController.close();
      } catch {
        // Already closed.
      }
    } else if (job.resolve) {
      job.resolve({
        content: job.content,
        toolCalls: finalToolCalls(job),
        finishReason: msg.finishReason,
        embedding: job.embedding,
        usage: msg.usage,
      });
    }

    jobs.delete(msg.jobId);
  } else if (msg.type === "error") {
    const job = jobs.get(msg.jobId);
    if (!job || job.workerId !== peerWorkerId) return;

    const worker = getWorker(job.workerId);
    if (worker && worker.inFlight > 0) {
      worker.inFlight--;
      notifyWorkerChanged(job.workerId);
    }

    if (job.streaming && job.eventController) {
      try {
        job.eventController.enqueue({ type: "error", message: msg.message });
        job.eventController.close();
      } catch {
        // Already closed.
      }
    } else if (job.reject) {
      job.reject(new Error(msg.message));
    }

    jobs.delete(msg.jobId);
  } else if (msg.type === "model_ready") {
    // Informational — no job-state action.
  }
}

export function rejectWorkerJobs(workerId: string): void {
  for (const [jobId, job] of jobs) {
    if (job.workerId !== workerId) continue;

    if (job.streaming && job.eventController) {
      try {
        job.eventController.error(new Error("Worker disconnected"));
      } catch {
        // Already closed.
      }
    } else if (job.reject) {
      job.reject(new Error("Worker disconnected"));
    }

    jobs.delete(jobId);
  }
}

export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}
