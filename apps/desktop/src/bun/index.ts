import {
	loadSettings,
	type Settings,
	saveSettings,
	validateSettings,
} from "@shoal/client-core/settings";
import { BrowserView, BrowserWindow, Tray, Updater, Utils } from "electrobun/main";
import type { ShoalRPC, Tab, WorkerState } from "../shared/rpc";
import { type RunningWorker, startWorker } from "./worker";

let settings: Settings | null = await loadSettings();

const notConfigured: WorkerState = {
	status: "not-configured",
	detail: null,
	serverUrl: null,
	jobsRunning: 0,
	backends: [],
};
let state: WorkerState = notConfigured;
let worker: RunningWorker | null = null;

const setState = (next: WorkerState) => {
	state = next;
	changed();
};

/** (Re)start the worker from the saved settings. */
const restartWorker = async () => {
	await worker?.stop();
	worker = null;
	if (settings === null) return setState(notConfigured);
	worker = await startWorker(settings, setState);
};

const tray = new Tray({ image: "views://assets/tray-sharing.svg", template: false });
// Tray swallows native failures and leaves id at 0; without a tray there is
// no way to control or quit the app.
if (tray.id === 0) {
	throw new Error(
		"Could not create a system tray icon. Your desktop needs a StatusNotifierItem host (on GNOME, the AppIndicator extension).",
	);
}

const STATUS_LABEL: Record<WorkerState["status"], string> = {
	"not-configured": "Not set up",
	connecting: "Connecting…",
	sharing: "Sharing",
	reconnecting: "Can't reach server, retrying…",
	pausing: "Pausing after current jobs…",
	paused: "Paused",
	stopped: "Stopped",
};

const isPaused = () => state.status === "paused" || state.status === "pausing";

const renderTray = () => {
	const { status } = state;
	const configured = status !== "not-configured" && status !== "stopped";
	tray.setImage(status === "sharing" ? "views://assets/tray-sharing.svg" : "views://assets/tray-paused.svg");
	tray.setMenu([
		{ type: "normal", label: STATUS_LABEL[status], enabled: false },
		{ type: "separator" },
		configured
			? { type: "normal", label: "Open Shoal", action: "open" }
			: { type: "normal", label: "Set up Shoal…", action: "settings" },
		{
			type: "normal",
			label: isPaused() ? "Resume sharing" : "Pause sharing",
			action: "toggle-pause",
			enabled: configured,
		},
		{ type: "normal", label: "Free up memory", action: "free-memory", enabled: configured },
		{ type: "separator" },
		{ type: "normal", label: "Settings…", action: "settings" },
		{ type: "normal", label: "Quit Shoal", action: "quit" },
	]);
};

const createRpc = () =>
	BrowserView.defineRPC<ShoalRPC>({
		handlers: {
			requests: {
				getState: () => state,
				getSettings: () =>
					settings && {
						serverUrl: settings.serverUrl,
						hasToken: settings.token !== "",
						backends: settings.backends,
					},
				saveSettings: async (input) => {
					const result = validateSettings(input, settings);
					if ("errors" in result) return { ok: false, errors: result.errors };
					await saveSettings(result.settings);
					settings = result.settings;
					await restartWorker();
					return { ok: true };
				},
				setPaused: ({ paused: next }) => setPaused(next),
				freeMemory: () => freeMemory(),
				unloadModel: async (model) =>
					(await worker?.unload(model.backend, model.id)) ?? "Shoal isn't running.",
				openWebDashboard: () => {
					if (settings) Utils.openExternal(settings.serverUrl);
				},
				takeRequestedTab: () => requestedTab,
			},
		},
	});

// Vite's dev server (vite.config.ts); serves the window with hot reload in `hutch run dev:hmr`.
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
let requestedTab: Tab = "status";

const openWindow = (tab: Tab) => {
	requestedTab = tab;
	if (window) {
		window.rpc.send.showTab(tab);
		window.win.show();
		window.win.activate();
		return;
	}
	const rpc = createRpc();
	const win = new BrowserWindow({
		title: "Shoal",
		url: windowUrl,
		frame: { width: 560, height: 720 },
		rpc,
	});
	win.on("close", () => {
		window = null;
	});
	window = { win, rpc };
};

const changed = () => {
	renderTray();
	window?.rpc.send.stateChanged(state);
};

const setPaused = (next: boolean) => (next ? worker?.pause() : worker?.resume());

const freeMemory = async () => {
	if (worker === null) return "Shoal isn't running.";
	const error = await worker.freeMemory();
	Utils.showNotification(
		error === null
			? {
					title: "Shoal paused",
					body: "Models were unloaded to free up memory. Resume sharing when you're done.",
				}
			: { title: "Couldn't free all memory", body: error },
	);
	return error;
};

tray.on("tray-clicked", (event) => {
	const { action } = (event as { data: { action: string } }).data;
	switch (action) {
		case "open":
			return openWindow("status");
		case "settings":
			return openWindow("settings");
		case "toggle-pause":
			return setPaused(!isPaused());
		case "free-memory":
			return freeMemory();
		case "quit":
			return Utils.quit();
	}
});

renderTray();
if (settings === null) openWindow("settings");
else await restartWorker();
