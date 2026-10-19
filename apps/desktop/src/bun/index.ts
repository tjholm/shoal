import {
	type Availability,
	loadSettings,
	loadToken,
	type Settings,
	saveSettings,
	saveToken,
	validateSettings,
} from "@shoal/client-core/settings";
import type { WorkerSnapshot } from "@shoal/client-core/worker";
import { ApplicationMenu, BrowserView, BrowserWindow, Tray, Updater, Utils } from "electrobun/main";
import { elapsed, isPaused, rate, statusLabel } from "../shared/format";
import type { BackendState, ShoalRPC, WorkerState } from "../shared/rpc";
import { isLaunchAtLogin, setLaunchAtLogin } from "./login";
import { claimSingleInstance } from "./single-instance";
import { probeBackends, type RunningWorker, startWorker, toBackendState } from "./worker";

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
	});
	window = { win, rpc };
};

if (!(await claimSingleInstance(openWindow))) process.exit(0);

let settings: Settings | null = await loadSettings();
let token: string | null = settings && (await loadToken(settings.serverUrl));
let worker: RunningWorker | null = null;
let snapshot: WorkerSnapshot | null = null;
let onlineSince: number | null = null;
let stoppedReason: string | null = null;

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
								: "connecting";
	return {
		status,
		detail:
			status === "stopped"
				? stoppedReason
				: status === "reconnecting" && connection?._tag === "Reconnecting"
					? connection.reason
					: null,
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

// A template image lets macOS tint the icon to suit the menu bar.
const MAC_TEMPLATE_ICON = process.platform === "darwin";
const trayImage = (accepting: boolean) => {
	const state = accepting ? "sharing" : "paused";
	return MAC_TEMPLATE_ICON ? `views://assets/tray-template-${state}.svg` : `views://assets/tray-${state}.svg`;
};
const tray = MAC_TEMPLATE_ICON
	? new Tray({ image: trayImage(false), template: true, width: 18, height: 18 })
	: new Tray({ image: trayImage(false), template: false });
// Tray swallows native failures and leaves id at 0; without a tray there is
// no way to control or quit the app.
if (tray.id === 0) {
	throw new Error(
		"Could not create a system tray icon. Your desktop needs a StatusNotifierItem host (on GNOME, the AppIndicator extension).",
	);
}

// macOS routes Cmd+C/V/X/A/Z through the main menu; without an Edit menu the
// window's text fields can't copy or paste.
if (process.platform === "darwin") {
	ApplicationMenu.setApplicationMenu([
		{
			label: "Shoal",
			submenu: [{ role: "hide" }, { role: "hideOthers" }, { role: "showAll" }],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "Window",
			submenu: [{ role: "minimize" }, { role: "close" }],
		},
	]);
}

/** The menu's second line: what's running, or how long a pause has left. */
const trayDetail = (state: WorkerState) => {
	if (isPaused(state.availability)) {
		return `${elapsed(state.availability.pausedUntil - Date.now())} left`;
	}
	if (state.status !== "online" || state.jobs.length === 0) return state.detail;
	return state.jobs
		.slice(0, 2)
		.map((job) => {
			const speed = rate(job.tokens, Date.now() - job.startedAt);
			return speed ? `${job.model} · ${speed}` : job.model;
		})
		.join(", ");
};

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
	return [
		item(statusLabel(state), null, { enabled: false }),
		...(detail ? [item(detail, null, { enabled: false })] : []),
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
	const detail = trayDetail(state);
	const shown = JSON.stringify([accepting, trayMenu(state, detail)]);
	const shape = JSON.stringify([accepting, trayMenu(state, null)]);
	if (shown === shownMenu) return;
	if (shape === shownShape && Date.now() - trayShownAt < 1000) return;
	shownMenu = shown;
	shownShape = shape;
	trayShownAt = Date.now();
	const image = trayImage(accepting);
	if (image !== tray.image) {
		if (MAC_TEMPLATE_ICON) {
			// On macOS setImage drops the template flag and size, but re-showing a
			// hidden tray rebuilds it from the stored image, flag and size.
			tray.setVisible(false);
			tray.setImage(image);
			tray.setVisible(true);
		} else {
			tray.setImage(image);
		}
	}
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
	if (settings !== null && token !== null) {
		worker = await startWorker({ ...settings, availability: availability() }, token, {
			onSnapshot: (next) => {
				const online = next.connection._tag === "Connected";
				onlineSince = online ? (onlineSince ?? Date.now()) : null;
				snapshot = next;
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
	await saveSettings(settings);
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
						const nextToken = result.token ?? (await loadToken(result.settings.serverUrl));
						if (nextToken === null) {
							return { ok: false, errors: ["Enter the API key from your shoal dashboard."] };
						}
						if (result.token !== null) await saveToken(result.settings.serverUrl, result.token);
						await saveSettings(result.settings);
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
