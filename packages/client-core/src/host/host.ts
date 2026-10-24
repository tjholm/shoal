import {
	type Availability,
	loadSettings,
	type Settings,
	saveSettings,
	type TokenStore,
	validateSettings,
} from "../settings";
import { SERVER_REFUSED, SERVER_TIMED_OUT, SERVER_UNREACHABLE, type WorkerConnection, type WorkerSnapshot } from "../worker/run";
import { type BackendState, type HostHandlers, isPaused, type WorkerState, type WorkerStatus } from "./api";
import { type PlatformLayer, probeBackends, type RunningWorker, startWorker, toBackendState } from "./worker";

/** A connection the worker wants but has lost, while it retries or after it gives up. */
type LostConnection = Extract<WorkerConnection, { readonly _tag: "Reconnecting" | "Failed" }>;

/** Where local model servers usually listen, probed during setup. */
const LOCAL_BACKENDS = [
	"http://localhost:11434",
	"http://localhost:1234",
	"http://localhost:8080",
	"http://localhost:8000",
] as const;

/** Whether the OS is keeping the worker off the local network the server is on. */
export interface LocalNetworkWatch {
	readonly blocked: boolean;
	/** Checks for a block whenever the server stops answering. */
	readonly observe: (connection: WorkerConnection, serverUrl: string) => void;
	/** Forgets any block, for a new worker or server. */
	readonly reset: () => void;
	/** Opens the system settings where the person allows access. */
	readonly openSettings: () => void;
}

export interface LocalNetworkHandlers {
	/** `blocked` changed, or a check finished. */
	readonly onChange: () => void;
	/** The person allowed access; the worker should connect now. */
	readonly onAllowed: () => void;
}

export interface HostOptions {
	/** Holds the settings file and the worker's identity. */
	readonly dir: string;
	readonly tokens: TokenStore;
	readonly platform: PlatformLayer;
	/** Reconnect attempts after a failed connection before the worker waits for a retry; unlimited when absent. */
	readonly reconnectAttempts?: number;
	/** Present where the client can start itself at login. */
	readonly launchAtLogin?: {
		readonly get: () => boolean;
		readonly set: (enabled: boolean) => Promise<void>;
	};
	/** Present where the OS can block the local network per app. */
	readonly watchLocalNetwork?: (handlers: LocalNetworkHandlers) => Promise<LocalNetworkWatch>;
}

/** Runs the worker from saved settings and answers its UI's requests. */
export interface Host {
	readonly state: () => WorkerState;
	/** Null before setup. */
	readonly settings: () => Settings | null;
	/** Calls `listener` at most every 100ms while the state changes, and every second. */
	readonly subscribe: (listener: (state: WorkerState) => void) => () => void;
	readonly handlers: HostHandlers;
	/** Stops the worker and the host's timers. */
	readonly stop: () => Promise<void>;
}

const notProbed = (url: string): BackendState => ({
	url,
	dialect: null,
	canUnload: false,
	models: [],
	loaded: [],
	error: null,
});

const neverBlocked: LocalNetworkWatch = {
	blocked: false,
	observe: () => {},
	reset: () => {},
	openSettings: () => {
		throw new Error("This computer has no Local Network settings.");
	},
};

export const createHost = async (options: HostOptions): Promise<Host> => {
	let settings = await loadSettings(options.dir);
	let token = settings && (await options.tokens.load(settings.serverUrl));
	let worker: RunningWorker | null = null;
	let snapshot: WorkerSnapshot | null = null;
	let onlineSince: number | null = null;
	let stoppedReason: string | null = null;
	let pauseEnd: ReturnType<typeof setTimeout> | undefined;
	const listeners = new Set<(state: WorkerState) => void>();

	let pushTimer: ReturnType<typeof setTimeout> | null = null;
	/** Streaming jobs change the state per token, so listeners hear at most every 100ms. */
	const changed = () => {
		if (pushTimer !== null) return;
		pushTimer = setTimeout(() => {
			pushTimer = null;
			const next = state();
			for (const listener of listeners) listener(next);
		}, 100);
	};
	// Keeps countdowns and job rates current when nothing else changes.
	const tick = setInterval(changed, 1_000);

	const localNetwork = options.watchLocalNetwork
		? await options.watchLocalNetwork({ onChange: changed, onAllowed: () => void worker?.retry() })
		: neverBlocked;

	/** What the person asked for, with a pause that has run out read as on. */
	const availability = (): Availability => {
		const saved = settings?.availability ?? "on";
		return isPaused(saved) && saved.pausedUntil <= Date.now() ? "on" : saved;
	};

	/** The worker's reason for a failed connection, as a sentence naming the server. */
	const describeProblem = (reason: string) => {
		const server = settings ? new URL(settings.serverUrl).host : "The server";
		switch (reason) {
			case SERVER_UNREACHABLE:
				return `${server} didn't answer.`;
			case SERVER_REFUSED:
				return `${server} refused the connection.`;
			case SERVER_TIMED_OUT:
				return `${server} took too long to answer.`;
			default:
				// Close codes such as 1006 when an open connection drops.
				return /^\d{4}\b/.test(reason) ? `The connection to ${server} dropped (${reason}).` : `${reason}.`;
		}
	};

	/** What the worker is doing, before asking whether the OS is blocking it. */
	const statusOf = (wanted: Availability, connection: WorkerConnection | undefined): WorkerStatus => {
		if (settings === null || token === null) return "not-configured";
		if (wanted === "off") return "off";
		if (isPaused(wanted)) return "paused";
		if (stoppedReason !== null) return "stopped";
		switch (connection?._tag) {
			case "Connected":
				return "online";
			case "Reconnecting":
				return "reconnecting";
			case "Failed":
				return "failed";
			default:
				return "connecting";
		}
	};

	const detailOf = (status: WorkerStatus, blocked: boolean, lost: LostConnection | null) => {
		if (status === "stopped") return stoppedReason;
		if (blocked) return "Needs Local Network access";
		if (lost !== null) return describeProblem(lost.reason);
		return null;
	};

	const state = (): WorkerState => {
		const wanted = availability();
		const connection = snapshot?.connection;
		const status = statusOf(wanted, connection);
		const wantsConnection = status === "reconnecting" || status === "failed";
		const lost = wantsConnection && (connection?._tag === "Reconnecting" || connection?._tag === "Failed") ? connection : null;
		// Retrying on a timer can't help; access is up to the person.
		const blocked = lost !== null && localNetwork.blocked;
		const nextRetry = !blocked && lost?._tag === "Reconnecting" ? lost : null;
		return {
			status: blocked ? "blocked" : status,
			detail: detailOf(status, blocked, lost),
			retryAt: nextRetry?.retryAt ?? null,
			attempt: nextRetry?.attempt ?? null,
			maxAttempts: options.reconnectAttempts ?? null,
			availability: wanted,
			serverUrl: settings?.serverUrl ?? null,
			name: settings?.name ?? "",
			workerId: connection?._tag === "Connected" ? connection.workerId : null,
			onlineSince,
			concurrency: settings?.concurrency ?? 1,
			jobs: snapshot?.jobs ?? [],
			recent: snapshot?.recent ?? [],
			jobsCompleted: snapshot?.jobsCompleted ?? 0,
			tokensOut: snapshot?.tokensOut ?? 0,
			backends: snapshot?.backends.map(toBackendState) ?? settings?.backends.map(notProbed) ?? [],
		};
	};

	/** (Re)start the worker from the saved settings and token. */
	const restartWorker = async () => {
		await worker?.stop();
		worker = null;
		snapshot = null;
		onlineSince = null;
		stoppedReason = null;
		localNetwork.reset();
		if (settings !== null && token !== null) {
			worker = await startWorker(
				{ ...settings, availability: availability() },
				token,
				{ identityDir: options.dir, platform: options.platform, reconnectAttempts: options.reconnectAttempts },
				{
					onSnapshot: (next) => {
						const online = next.connection._tag === "Connected";
						onlineSince = online ? (onlineSince ?? Date.now()) : null;
						snapshot = next;
						if (settings !== null) localNetwork.observe(next.connection, settings.serverUrl);
						changed();
					},
					onStopped: (reason) => {
						stoppedReason = reason;
						changed();
					},
				},
			);
		}
		changed();
	};

	/** Switching off or pausing disconnects at once, abandoning running jobs. */
	const setAvailability = async (next: Availability) => {
		if (settings === null) return;
		settings = { ...settings, availability: next };
		await saveSettings(options.dir, settings);
		clearTimeout(pauseEnd);
		if (isPaused(next)) {
			pauseEnd = setTimeout(() => void setAvailability("on"), Math.max(0, next.pausedUntil - Date.now()));
		}
		// A worker stopped by the server gets another try when work is switched back on.
		if (stoppedReason !== null && next === "on") return restartWorker();
		await worker?.setPaused(availability() !== "on");
		changed();
	};

	const handlers: HostHandlers = {
		getState: () => state(),
		getSettings: () =>
			settings && {
				serverUrl: settings.serverUrl,
				hasToken: token !== null,
				backends: settings.backends,
				name: settings.name,
				concurrency: settings.concurrency,
				launchAtLogin: options.launchAtLogin?.get() ?? false,
			},
		saveSettings: async (form) => {
			const result = validateSettings(form, settings);
			if ("errors" in result) return { ok: false, errors: result.errors };
			try {
				const nextToken = result.token ?? (await options.tokens.load(result.settings.serverUrl));
				if (nextToken === null) {
					return { ok: false, errors: ["Enter the API key from your shoal dashboard."] };
				}
				if (result.token !== null) await options.tokens.save(result.settings.serverUrl, result.token);
				await saveSettings(options.dir, result.settings);
				if (options.launchAtLogin && form.launchAtLogin !== options.launchAtLogin.get()) {
					await options.launchAtLogin.set(form.launchAtLogin);
				}
				settings = result.settings;
				token = nextToken;
			} catch (error) {
				return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
			}
			await restartWorker();
			return { ok: true };
		},
		setAvailability: (next) => setAvailability(next),
		retryConnection: () => worker?.retry(),
		openLocalNetworkSettings: () => localNetwork.openSettings(),
		detectBackends: () => probeBackends(LOCAL_BACKENDS),
		unloadModel: async (model) => (await worker?.unload(model.backend, model.id)) ?? "Shoal isn't running.",
	};

	// A pause saved before a restart still needs its timer.
	const saved = settings?.availability;
	if (saved !== undefined && isPaused(saved)) await setAvailability(availability());
	await restartWorker();

	return {
		state,
		settings: () => settings,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		handlers,
		stop: async () => {
			clearInterval(tick);
			clearTimeout(pauseEnd);
			if (pushTimer !== null) clearTimeout(pushTimer);
			localNetwork.reset();
			await worker?.stop();
			worker = null;
		},
	};
};
