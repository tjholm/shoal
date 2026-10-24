import { BunServices } from "@effect/platform-bun";
import { createHost } from "@shoal/client-core/host";
import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/main";
import { elapsed, isPaused, rate, statusLabel } from "@shoal/worker-ui/format";
import type { ShoalRPC, WorkerState } from "../shared/rpc";
import { watchLocalNetwork } from "./local-network";
import { isLaunchAtLogin, setLaunchAtLogin } from "./login";
import { installAppMenu, setDockIconVisible } from "./shell";
import { claimSingleInstance } from "./single-instance";
import { dir, tokens } from "./store";
import { createTrayIcon, type TrayLook } from "./tray";

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

// Another copy can ask for the window before the host below exists.
const started = Promise.withResolvers<void>();
if (!(await claimSingleInstance(() => void started.promise.then(openWindow)))) process.exit(0);

const host = await createHost({
	dir,
	tokens,
	platform: BunServices.layer,
	tray: true,
	// With 1s doubling backoff, gives up about a minute after the first failure.
	reconnectAttempts: 6,
	launchAtLogin: { get: isLaunchAtLogin, set: setLaunchAtLogin },
	watchLocalNetwork,
});

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
	const controls = host.settings() !== null;
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
		...(controls ? [item("Open dashboard", "dashboard")] : []),
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

host.subscribe((state) => {
	window?.rpc.send.stateChanged(state);
	renderTray(state);
});

const { setAvailability } = host.handlers;

const extendPause = (minutes: number) => {
	const current = host.state().availability;
	const from = isPaused(current) ? current.pausedUntil : Date.now();
	return setAvailability({ pausedUntil: from + minutes * MINUTE });
};

tray.on("tray-clicked", (event) => {
	const { action } = (event as { data: { action: string } }).data;
	const [command, minutes] = action.split(":");
	switch (command) {
		case "accept":
			return setAvailability(host.state().availability === "on" ? "off" : "on");
		case "pause":
			return setAvailability({ pausedUntil: Date.now() + Number(minutes) * MINUTE });
		case "extend":
			return extendPause(Number(minutes));
		case "resume":
			return setAvailability("on");
		case "stay-off":
			return setAvailability("off");
		case "retry":
			return host.handlers.retryConnection();
		case "local-network":
			return host.handlers.openLocalNetworkSettings();
		case "open":
			return openWindow();
		case "dashboard": {
			const saved = host.settings();
			if (saved) Utils.openExternal(saved.serverUrl);
			return;
		}
		case "quit":
			return Utils.quit();
	}
});

function createRpc() {
	return BrowserView.defineRPC<ShoalRPC>({ handlers: { requests: host.handlers } });
}

started.resolve();
renderTray(host.state());
if (host.state().status === "not-configured") openWindow();
else setDockIconVisible(false);
