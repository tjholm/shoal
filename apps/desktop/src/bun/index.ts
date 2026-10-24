import {
	type Availability,
	loadSettings,
	loadToken,
	type Settings,
	saveSettings,
	saveToken,
	validateSettings,
} from "@shoal/client-core/settings";
import { SERVER_REFUSED, SERVER_TIMED_OUT, SERVER_UNREACHABLE, type WorkerSnapshot } from "@shoal/client-core/worker";
import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/main";
import { elapsed, isPaused, rate, statusLabel } from "../shared/format";
import type { BackendState, ShoalRPC, WorkerState } from "../shared/rpc";
import { watchLocalNetwork } from "./local-network";
import { isLaunchAtLogin, setLaunchAtLogin } from "./login";
import { installAppMenu, setDockIconVisible } from "./shell";
import { claimSingleInstance } from "./single-instance";
import { store } from "./store";
import { createTrayIcon, type TrayLook } from "./tray";
import { probeBackends, RECONNECT_ATTEMPTS, type RunningWorker, startWorker, toBackendState } from "./worker";

/** Where local model servers usually listen, probed on first run. */
const LOCAL_BACKENDS = [
	"http://localhost:11434",
	"http://localhost:1234",
	"http://localhost:8080",
	"http://localhost:8000",
] as const;
const PAUSES = [
	[10, "10 minutes"],
	[30, "30 minutes"],
	[60, "1 hour"],
	[180, "3 hours"],
	[480, "8 hours"],
] as const;
const EXTENSIONS = [
	[30, "30 minutes"],
	[60, "1 hour"],
	[180, "3 hours"],
] as const;
const MINUTE = 60_000;

// Vite's dev server (vite.config.ts); serves the window with hot reload in `bun run dev:hmr`.
const DEV_SERVER_URL = "http://localhost:5173";

const resolveWindowUrl = async () => {
	if ((await Updater.localInfo.channel()) === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			return DEV_SERVER_URL;
		} catch {
			// Not running dev:hmr; use the bundled build.
		}
	}
	return "views://mainview/index.html";
};
const windowUrl = await resolveWindowUrl();

let window: { win: BrowserWindow; rpc: ReturnType<typeof createRpc> } | null = null;

const openWindow = () => {
	setDockIconVisible(true);
	if (window) {
		window.win.show();
		window.win.activate();
		return;
	}
	const rpc = createRpc();
	const win = new BrowserWindow({
		title: "Shoal",
		url: windowUrl,
		frame: { width: 980, height: 680 },
		rpc,
	});
	win.on("close", () => {
		window = null;
		setDockIconVisible(false);
	});
	window = { win, rpc };
};

if (!(await claimSingleInstance(openWindow))) process.exit(0);

let settings: Settings | null = await loadSettings(store);
let token: string | null = settings && (await loadToken(store, settings.serverUrl));
let worker: RunningWorker | null = null;
let snapshot: WorkerSnapshot | null = null;
let onlineSince: number | null = null;
let stoppedReason: string | null = null;
const localNetwork = await watchLocalNetwork({
	onChange: () => changed(),
	onAllowed: () => void worker?.retry(),
});

/** What the person asked for, with a pause that has run out read as on. */
const availability = (): Availability => {
	const saved = settings?.availability ?? "on";
	return isPaused(saved) && saved.pausedUntil <= Date.now() ? "on" : saved;
};

const notProbed = (url: string): BackendState => ({
	url,
	dialect: null,
	canUnload: false,
	models: [],
	loaded: [],
	error: null,
});

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

const workerState = (): WorkerState => {
	const wanted = availability();
	const connection = snapshot?.connection;
	const status: WorkerState["status"] =
		settings === null || token === null
			? "not-configured"
			: wanted === "off"
				? "off"
				: isPaused(wanted)
					? "paused"
					: stoppedReason !== null
						? "stopped"
						: connection?._tag === "Connected"
							? "online"
							: connection?._tag === "Reconnecting"
								? "reconnecting"
								: connection?._tag === "Failed"
									? "failed"
									: "connecting";
	const disconnected = (status === "reconnecting" || status === "failed") && connection?._tag !== "Connected";
	const reason =
		disconnected && (connection?._tag === "Reconnecting" || connection?._tag === "Failed") ? connection.reason : null;
	// Retrying on a timer can't help; access is up to the person.
	const blocked = disconnected && localNetwork.blocked;
	return {
		status: blocked ? "blocked" : status,
		detail: status === "stopped" ? stoppedReason : blocked ? "Needs Local Network access" : reason === null ? null : describeProblem(reason),
		retryAt: !blocked && status === "reconnecting" && connection?._tag === "Reconnecting" ? connection.retryAt : null,
		attempt: !blocked && status === "reconnecting" && connection?._tag === "Reconnecting" ? connection.attempt : null,
		maxAttempts: RECONNECT_ATTEMPTS,
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

const trayIcon = await createTrayIcon();
const { tray } = trayIcon;

installAppMenu();

/** The menu's second line: what's running, or how long a pause has left. */
const trayDetail = (state: WorkerState) => {
	if (isPaused(state.availability)) {
		return `${elapsed(state.availability.pausedUntil - Date.now())} left`;
	}
	// The title line counts down; this one names the problem, which menus show without a full stop.
	if (state.status === "reconnecting" || state.status === "failed") return state.detail?.replace(/\.$/, "") ?? null;
	if (state.status !== "online" || state.jobs.length === 0) return state.detail;
	return state.jobs
		.slice(0, 2)
		.map((job) => {
			const speed = rate(job.tokens, Date.now() - job.startedAt);
			return speed ? `${job.model} · ${speed}` : job.model;
		})
		.join(", ");
};

/** The menu's first line: the status, counting down while a reconnect is due. */
const trayTitle = (state: WorkerState) =>
	state.retryAt !== null ? `Reconnecting in ${elapsed(Math.max(0, state.retryAt - Date.now()))}` : statusLabel(state);

type MenuItem = Parameters<typeof tray.setMenu>[0][number];
const item = (label: string, action: string | null, extra: Partial<MenuItem> = {}): MenuItem =>
	({ type: "normal", label, ...(action ? { action } : {}), ...extra }) as MenuItem;
const separator: MenuItem = { type: "separator" };
const durations = (prefix: string, choices: ReadonlyArray<readonly [number, string]>) => [
	...choices.map(([minutes, label]) => item(label, `${prefix}:${minutes}`)),
	separator,
	item("Until I resume", "stay-off"),
];

const trayMenu = (state: WorkerState, detail: string | null): Array<MenuItem> => {
	const controls = settings !== null;
	const availabilityItems = isPaused(state.availability)
		? [
				item("Resume now", "resume"),
				item("Extend pause by", null, { submenu: durations("extend", EXTENSIONS) }),
			]
		: [
				item("Accept work", "accept", { checked: state.availability === "on", enabled: controls }),
				...(state.availability === "on"
					? [item("Pause for", null, { enabled: controls, submenu: durations("pause", PAUSES) })]
					: []),
			];
	// Under the status they act on.
	const connectionItems = [
		...(state.status === "failed" ? [item("Try Again", "retry")] : []),
		...(state.status === "reconnecting" ? [item("Try Now", "retry")] : []),
		...(state.status === "blocked" ? [item("Allow in System Settings…", "local-network")] : []),
	];
	return [
		item(trayTitle(state), null, { enabled: false }),
		...(detail ? [item(detail, null, { enabled: false })] : []),
		...connectionItems,
		separator,
		...availabilityItems,
		separator,
		item("Open Shoal…", "open"),
		...(settings ? [item("Open dashboard", "dashboard")] : []),
		separator,
		item("Quit Shoal", "quit"),
	];
};

let shownMenu = "";
let shownShape = "";
let trayShownAt = 0;

/** At most once a second while only the detail line (job rates, time left) changes. */
const renderTray = (state: WorkerState) => {
	const accepting = state.availability === "on" && state.status !== "not-configured";
	// Wants to take work but can't reach the server, so the menu bar should draw the eye.
	const look: TrayLook =
		state.status === "reconnecting" || state.status === "failed" || state.status === "stopped" || state.status === "blocked"
			? "warning"
			: accepting
				? "sharing"
				: "paused";
	const detail = trayDetail(state);
	const shown = JSON.stringify([look, trayMenu(state, detail)]);
	const shape = JSON.stringify([look, trayMenu(state, null)]);
	if (shown === shownMenu) return;
	if (shape === shownShape && Date.now() - trayShownAt < 1000) return;
	shownMenu = shown;
	shownShape = shape;
	trayShownAt = Date.now();
	trayIcon.show(look);
	tray.setMenu(trayMenu(state, detail));
};

let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** Streaming jobs change the state per token; the window follows at most every 100ms. */
const changed = () => {
	if (pushTimer !== null) return;
	pushTimer = setTimeout(() => {
		pushTimer = null;
		const state = workerState();
		window?.rpc.send.stateChanged(state);
		renderTray(state);
	}, 100);
};
// Keeps the tray's "time left" and job rates current when nothing else changes.
setInterval(changed, 1_000);

/** (Re)start the worker from the saved settings and token. */
const restartWorker = async () => {
	await worker?.stop();
	worker = null;
	snapshot = null;
	onlineSince = null;
	stoppedReason = null;
	localNetwork.reset();
	if (settings !== null && token !== null) {
		worker = await startWorker({ ...settings, availability: availability() }, token, {
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
		});
	}
	changed();
};

let pauseEnd: ReturnType<typeof setTimeout> | undefined;

/** Switching off or pausing disconnects at once, abandoning running jobs. */
const setAvailability = async (next: Availability) => {
	if (settings === null) return;
	settings = { ...settings, availability: next };
	await saveSettings(store, settings);
	clearTimeout(pauseEnd);
	if (isPaused(next)) {
		pauseEnd = setTimeout(() => void setAvailability("on"), Math.max(0, next.pausedUntil - Date.now()));
	}
	// A worker stopped by the server gets another try when work is switched back on.
	if (stoppedReason !== null && next === "on") return restartWorker();
	await worker?.setPaused(availability() !== "on");
	changed();
};

const extendPause = (minutes: number) => {
	const current = availability();
	const from = isPaused(current) ? current.pausedUntil : Date.now();
	return setAvailability({ pausedUntil: from + minutes * MINUTE });
};

tray.on("tray-clicked", (event) => {
	const { action } = (event as { data: { action: string } }).data;
	const [command, minutes] = action.split(":");
	switch (command) {
		case "accept":
			return setAvailability(availability() === "on" ? "off" : "on");
		case "pause":
			return setAvailability({ pausedUntil: Date.now() + Number(minutes) * MINUTE });
		case "extend":
			return extendPause(Number(minutes));
		case "resume":
			return setAvailability("on");
		case "stay-off":
			return setAvailability("off");
		case "retry":
			return worker?.retry();
		case "local-network":
			return localNetwork.openSettings();
		case "open":
			return openWindow();
		case "dashboard":
			if (settings) Utils.openExternal(settings.serverUrl);
			return;
		case "quit":
			return Utils.quit();
	}
});

function createRpc() {
	return BrowserView.defineRPC<ShoalRPC>({
		handlers: {
			requests: {
				getState: () => workerState(),
				getSettings: () =>
					settings && {
						serverUrl: settings.serverUrl,
						hasToken: token !== null,
						backends: settings.backends,
						name: settings.name,
						concurrency: settings.concurrency,
						launchAtLogin: isLaunchAtLogin(),
					},
				saveSettings: async (form) => {
					const result = validateSettings(form, settings);
					if ("errors" in result) return { ok: false, errors: result.errors };
					try {
						const nextToken = result.token ?? (await loadToken(store, result.settings.serverUrl));
						if (nextToken === null) {
							return { ok: false, errors: ["Enter the API key from your shoal dashboard."] };
						}
						if (result.token !== null) await saveToken(store, result.settings.serverUrl, result.token);
						await saveSettings(store, result.settings);
						if (form.launchAtLogin !== isLaunchAtLogin()) await setLaunchAtLogin(form.launchAtLogin);
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
				unloadModel: async (model) =>
					(await worker?.unload(model.backend, model.id)) ?? "Shoal isn't running.",
			},
		},
	});
}

const saved = settings?.availability;
if (saved !== undefined && isPaused(saved)) await setAvailability(availability());
await restartWorker();
if (settings === null || token === null) openWindow();
else setDockIconVisible(false);
