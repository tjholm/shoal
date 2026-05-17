import { and, db, desc, eq, schema } from "@shoal/db";
import {
	type ModelTask,
	normalizeWorkerModels,
	TASK_PURPOSE,
	type WorkerMessage,
	type WorkerModel,
} from "@shoal/protocol";

/** Minimal WebSocket interface — works with both Bun ServerWebSocket and browser WebSocket. */
interface WS {
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export interface WorkerState {
	workerId: string;
	organizationId: string;
	/** API key the current connection authed with. Snapshotted onto each job. */
	keyId: string | null;
	ws: WS;
	/** Models the worker reports as currently resident across its backends.
	 *  Empty until the worker's first stats tick, or when nothing is loaded. */
	loadedModels: string[];
	/** Models the worker's backend reports as available, in normalized form. */
	availableModels: WorkerModel[];
	/** Number of jobs currently dispatched to this worker. */
	inFlight: number;
	/** Maximum jobs the worker can handle concurrently (advertised at registration). */
	maxConcurrent: number;
	jobsCompleted: number;
	/** Wall-clock connect time of the current session, ms epoch. */
	connectedAt: number;
	/** Timestamp of last pong received */
	lastPong: number;
	/** Number of consecutive missed pings (no pong reply) */
	missedPings: number;
}

const WORKERS_KEY = "__shoal_workers__";
const _global = globalThis as Record<string, unknown>;
if (!_global[WORKERS_KEY]) {
	_global[WORKERS_KEY] = new Map<string, WorkerState>();
}
const workers = _global[WORKERS_KEY] as Map<string, WorkerState>;

// --- Worker event bus ---
//
// In-process pub/sub used by the SSE endpoint that pushes worker updates to
// browser clients. Listeners are scoped by organization so we never leak
// activity across orgs. The bus stays in `globalThis` for the same reason as
// the workers map: Vite HMR swaps the module on edits, and we want a single
// bus across the swap so existing SSE connections aren't orphaned.

export type WorkerBusEvent =
	/** Any change to in-memory state (online/offline/stats/models/inFlight). */
	| { type: "live"; workerId: string }
	/** Display name changed (DB-only mutation, no in-memory state). */
	| { type: "name"; workerId: string; name: string | null }
	/** Worker registration removed from the DB. */
	| { type: "deleted"; workerId: string };

type WorkerBusListener = (e: WorkerBusEvent) => void;

const LISTENERS_KEY = "__shoal_worker_bus__";
if (!_global[LISTENERS_KEY]) {
	_global[LISTENERS_KEY] = new Map<string, Set<WorkerBusListener>>();
}
const listeners = _global[LISTENERS_KEY] as Map<string, Set<WorkerBusListener>>;

export function subscribeWorkers(
	organizationId: string,
	fn: WorkerBusListener,
): () => void {
	let set = listeners.get(organizationId);
	if (!set) {
		set = new Set();
		listeners.set(organizationId, set);
	}
	set.add(fn);
	return () => {
		const s = listeners.get(organizationId);
		if (!s) return;
		s.delete(fn);
		if (s.size === 0) listeners.delete(organizationId);
	};
}

function emit(organizationId: string, e: WorkerBusEvent): void {
	const set = listeners.get(organizationId);
	if (!set) return;
	for (const fn of set) {
		try {
			fn(e);
		} catch (err) {
			console.error("[workers] bus listener threw:", err);
		}
	}
}

/**
 * Fire a "live" event for a worker — call this after mutating any in-memory
 * field on `WorkerState` outside of this module (e.g. `inFlight` updates from
 * dispatch). No-op if the worker isn't in the live map.
 */
export function notifyWorkerChanged(workerId: string): void {
	const w = workers.get(workerId);
	if (!w) return;
	emit(w.organizationId, { type: "live", workerId });
}

// --- Secret hashing ---
//
// We hash the per-worker secret with SHA-256 + salt. A bcrypt/argon hash would
// be appropriate for human passwords (slow on purpose to deter cracking), but
// the worker secret is a 32-byte random value — brute-forcing a SHA-256 of a
// 256-bit random input is already astronomical, and slow hashing would just
// add latency to every reconnect.

const SECRET_BYTES = 32;
const SECRET_SALT_BYTES = 16;

function generateSecret(): string {
	const buf = new Uint8Array(SECRET_BYTES);
	crypto.getRandomValues(buf);
	return base64Url(buf);
}

async function hashSecret(
	secret: string,
	saltB64?: string,
): Promise<{ hash: string; salt: string }> {
	const saltBuf: Uint8Array<ArrayBuffer> = saltB64
		? fromBase64Url(saltB64)
		: crypto.getRandomValues(new Uint8Array(SECRET_SALT_BYTES));
	const secretBuf = new TextEncoder().encode(secret);
	const combined = new Uint8Array(saltBuf.length + secretBuf.length);
	combined.set(saltBuf, 0);
	combined.set(secretBuf, saltBuf.length);
	const digest = await crypto.subtle.digest("SHA-256", combined);
	return { hash: base64Url(new Uint8Array(digest)), salt: base64Url(saltBuf) };
}

/** Stored format is `salt$hash` so we can verify without a separate column. */
async function makeSecretHash(secret: string): Promise<string> {
	const { hash, salt } = await hashSecret(secret);
	return `${salt}$${hash}`;
}

async function verifySecret(secret: string, stored: string): Promise<boolean> {
	const idx = stored.indexOf("$");
	if (idx === -1) return false;
	const salt = stored.slice(0, idx);
	const expected = stored.slice(idx + 1);
	const { hash } = await hashSecret(secret, salt);
	return timingSafeEqual(hash, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function base64Url(buf: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
	const padded = s
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
	const bin = atob(padded);
	const buf = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
	return buf;
}

// --- Errors ---

export class WorkerAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerAuthError";
	}
}

export class WorkerAlreadyConnectedError extends Error {
	constructor(workerId: string) {
		super(`worker ${workerId} already has an active connection`);
		this.name = "WorkerAlreadyConnectedError";
	}
}

// --- Registration ---

interface RegisterArgs {
	organizationId: string;
	keyId: string | null;
	ws: WS;
	maxConcurrent: number;
	/**
	 * Worker-advertised friendly name. When provided, the worker is treated as
	 * the source of truth: `registerNew` stores it on insert, `registerResume`
	 * overwrites whatever is in the DB. Omit (undefined) to preserve the stored
	 * value — e.g. a UI rename sticks until the operator reconnects with
	 * `--name` set again. An empty/whitespace string clears the name.
	 */
	name?: string;
}

export interface RegisterResult {
	workerId: string;
	/** Plaintext secret. Only set on first registration. */
	secret?: string;
	state: WorkerState;
}

/**
 * First-time worker registration. Creates a DB row, generates a secret, and
 * binds the in-memory state. The plaintext secret is returned exactly once;
 * the worker must persist it locally to call registerResume next time.
 */
export async function registerNew(args: RegisterArgs): Promise<RegisterResult> {
	const workerId = crypto.randomUUID();
	const secret = generateSecret();
	const secretHash = await makeSecretHash(secret);

	await db.insert(schema.worker).values({
		id: workerId,
		organizationId: args.organizationId,
		secretHash,
		keyId: args.keyId,
		name: normalizeName(args.name),
		firstSeenAt: new Date(),
		lastSeenAt: new Date(),
	});

	const state = bindLiveState(workerId, args);
	emit(args.organizationId, { type: "live", workerId });
	return { workerId, secret, state };
}

/**
 * Reconnect an existing worker. Verifies the secret matches the hashed value
 * stored on the worker row, scoped to the org from API key auth. Updates the
 * keyId (in case the worker is now using a different api key) and lastSeenAt.
 */
export async function registerResume(
	args: RegisterArgs & { workerId: string; secret: string },
): Promise<RegisterResult> {
	const rows = await db
		.select()
		.from(schema.worker)
		.where(
			and(
				eq(schema.worker.id, args.workerId),
				eq(schema.worker.organizationId, args.organizationId),
			),
		)
		.limit(1);

	const row = rows[0];
	if (!row)
		throw new WorkerAuthError("unknown worker id for this organization");

	const ok = await verifySecret(args.secret, row.secretHash);
	if (!ok) throw new WorkerAuthError("invalid worker secret");

	if (workers.has(args.workerId)) {
		throw new WorkerAlreadyConnectedError(args.workerId);
	}

	const updates: {
		lastSeenAt: Date;
		keyId: string | null;
		name?: string | null;
	} = { lastSeenAt: new Date(), keyId: args.keyId };
	if (args.name !== undefined) updates.name = normalizeName(args.name);

	await db
		.update(schema.worker)
		.set(updates)
		.where(eq(schema.worker.id, args.workerId));

	const state = bindLiveState(args.workerId, args);
	emit(args.organizationId, { type: "live", workerId: args.workerId });
	if (args.name !== undefined) {
		emit(args.organizationId, {
			type: "name",
			workerId: args.workerId,
			name: normalizeName(args.name),
		});
	}
	return { workerId: args.workerId, state };
}

/** Trim and convert empty → null so the column reflects "no name set". */
function normalizeName(name: string | undefined): string | null {
	if (name === undefined) return null;
	const trimmed = name.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function bindLiveState(workerId: string, args: RegisterArgs): WorkerState {
	const state: WorkerState = {
		workerId,
		organizationId: args.organizationId,
		keyId: args.keyId,
		ws: args.ws,
		loadedModels: [],
		availableModels: [],
		inFlight: 0,
		maxConcurrent: args.maxConcurrent,
		jobsCompleted: 0,
		connectedAt: Date.now(),
		lastPong: Date.now(),
		missedPings: 0,
	};
	workers.set(workerId, state);
	return state;
}

// --- Live-state queries (in-memory) ---

export function removeWorker(workerId: string): void {
	const w = workers.get(workerId);
	if (!w) return;
	workers.delete(workerId);
	emit(w.organizationId, { type: "live", workerId });
}

export function getWorker(workerId: string): WorkerState | undefined {
	return workers.get(workerId);
}

export function allWorkers(organizationId: string): WorkerState[] {
	const out: WorkerState[] = [];
	for (const w of workers.values()) {
		if (w.organizationId === organizationId) out.push(w);
	}
	return out;
}

/** All workers across every organization. Internal use only — eviction, heartbeat. */
export function allWorkersUnscoped(): WorkerState[] {
	return [...workers.values()];
}

export function updateWorkerStats(
	workerId: string,
	msg: Extract<WorkerMessage, { type: "stats" }>,
): void {
	const w = workers.get(workerId);
	if (!w) return;
	const changed =
		!sameStringSet(w.loadedModels, msg.loadedModels) ||
		w.jobsCompleted !== msg.jobsCompleted;
	w.loadedModels = msg.loadedModels;
	w.jobsCompleted = msg.jobsCompleted;
	// Note: msg.uptimeMs is the worker process's uptime, not connection time.
	// We track connection time via connectedAt instead.
	if (changed) emit(w.organizationId, { type: "live", workerId });
}

/** Order-insensitive equality on two string arrays treated as sets. Used to
 *  decide whether a stats update actually moved the loaded-models set; without
 *  this an Ollama backend reporting `[a, b]` then `[b, a]` would emit a
 *  spurious "live" event on every tick. */
function sameStringSet(
	a: ReadonlyArray<string>,
	b: ReadonlyArray<string>,
): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	for (const v of b) if (!set.has(v)) return false;
	return true;
}

/** Tracks which workers we've already logged a legacy-format warning for, so
 *  the deprecation notice fires once per process per worker instead of on
 *  every 30s tick. TODO(remove-legacy-models): delete this set with the
 *  legacy branch. */
const legacyModelFormatWarned = new Set<string>();

export function updateWorkerModels(
	workerId: string,
	models: Extract<WorkerMessage, { type: "models" }>["models"],
): void {
	const w = workers.get(workerId);
	if (!w) return;

	const { models: normalized, legacy } = normalizeWorkerModels(models);
	if (legacy && !legacyModelFormatWarned.has(workerId)) {
		legacyModelFormatWarned.add(workerId);
		console.warn(
			`[workers] worker ${workerId} sent legacy string[] models payload; ` +
				`upgrade the worker to send { id }[]`,
		);
	}

	const changed =
		w.availableModels.length !== normalized.length ||
		w.availableModels.some((m, i) => m.id !== normalized[i].id);
	w.availableModels = normalized;
	if (changed) emit(w.organizationId, { type: "live", workerId });
}

/** True when the worker advertises this model AND its declared purpose either
 *  matches the requested task or is unknown. An explicit purpose mismatch
 *  filters the worker out — that's the enforcement contract. */
function workerServesTask(
	w: WorkerState,
	model: string,
	task: ModelTask,
): boolean {
	const required = TASK_PURPOSE[task];
	for (const m of w.availableModels) {
		if (m.id !== model) continue;
		if (m.purpose === undefined) return true;
		return m.purpose === required;
	}
	return false;
}

export function pickWorker(
	model: string,
	organizationId: string,
	task: ModelTask,
): WorkerState | null {
	let warmBest: WorkerState | null = null;
	let coldBest: WorkerState | null = null;

	for (const w of workers.values()) {
		if (w.organizationId !== organizationId) continue;
		if (w.inFlight >= w.maxConcurrent) continue;
		if (!workerServesTask(w, model, task)) continue;

		if (w.loadedModels.includes(model)) {
			if (!warmBest || w.inFlight < warmBest.inFlight) warmBest = w;
		} else {
			if (!coldBest || w.inFlight < coldBest.inFlight) coldBest = w;
		}
	}

	return warmBest ?? coldBest;
}

/** All distinct model ids advertised by online workers in the org. When `task`
 *  is provided, filters to models whose declared purpose matches (or is
 *  unknown) — the OpenAI surface uses this so a chat catalog request doesn't
 *  list TTS-only models. */
export function availableModels(
	organizationId: string,
	task?: ModelTask,
): string[] {
	const required = task !== undefined ? TASK_PURPOSE[task] : undefined;
	const models = new Set<string>();
	for (const w of workers.values()) {
		if (w.organizationId !== organizationId) continue;
		for (const m of w.availableModels) {
			if (
				required !== undefined &&
				m.purpose !== undefined &&
				m.purpose !== required
			)
				continue;
			models.add(m.id);
		}
	}
	return [...models];
}

// --- DB queries for the workers UI ---

export interface WorkerRow {
	workerId: string;
	name: string | null;
	keyId: string | null;
	firstSeenAt: Date;
	lastSeenAt: Date;
}

/** All workers ever seen in this org, most recently active first. */
export async function listOrgWorkers(
	organizationId: string,
): Promise<WorkerRow[]> {
	const rows = await db
		.select({
			workerId: schema.worker.id,
			name: schema.worker.name,
			keyId: schema.worker.keyId,
			firstSeenAt: schema.worker.firstSeenAt,
			lastSeenAt: schema.worker.lastSeenAt,
		})
		.from(schema.worker)
		.where(eq(schema.worker.organizationId, organizationId))
		.orderBy(desc(schema.worker.lastSeenAt));
	return rows;
}

/** Update the editable display name for a worker. */
export async function setWorkerName(
	workerId: string,
	organizationId: string,
	name: string | null,
): Promise<void> {
	await db
		.update(schema.worker)
		.set({ name })
		.where(
			and(
				eq(schema.worker.id, workerId),
				eq(schema.worker.organizationId, organizationId),
			),
		);
	emit(organizationId, { type: "name", workerId, name });
}

/**
 * Delete a worker from the org. Disconnects any live session, drops the
 * in-memory entry, then removes the DB row. `usage_event` rows cascade-delete
 * with the worker row, so historical usage tied only to this worker is gone too.
 *
 * Returns true if a row was deleted, false if the worker didn't belong to this org.
 */
export async function deleteWorker(
	workerId: string,
	organizationId: string,
): Promise<boolean> {
	const live = workers.get(workerId);
	if (live && live.organizationId === organizationId) {
		try {
			live.ws.close(1000, "worker deleted");
		} catch {
			// ignore — connection may already be dead
		}
		workers.delete(workerId);
	}

	const deleted = await db
		.delete(schema.worker)
		.where(
			and(
				eq(schema.worker.id, workerId),
				eq(schema.worker.organizationId, organizationId),
			),
		)
		.returning({ id: schema.worker.id });

	if (deleted.length > 0) {
		emit(organizationId, { type: "deleted", workerId });
	}
	return deleted.length > 0;
}
