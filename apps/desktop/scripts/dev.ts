/**
 * `bun run dev`: builds the app, runs it, and rebuilds and relaunches it when
 * the source changes, like `electrobun dev --watch`.
 *
 * On macOS it builds with `electrobun build --env=dev` and applies
 * scripts/mac-identity.ts before each launch. Hutch runs no build hooks for
 * dev builds, and without that fix macOS's Local Network privacy can't tell
 * Shoal from other Electrobun apps and blocks it from servers on the local
 * network, whatever the person allows in System Settings.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readdirSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import config from "../electrobun.config";
import { applyMacIdentity } from "./mac-identity";

const electrobun = path.join("node_modules", ".bin", "electrobun");

if (process.platform !== "darwin") {
	const result = spawnSync(electrobun, ["dev", "--watch"], { stdio: "inherit" });
	process.exit(result.status ?? 1);
}

/** Bun bundles these into the app, so a change in any of them needs a rebuild. */
const WATCHED = ["src", "assets", "dist", "electrobun.config.ts", "../../packages"];
const IGNORED = /(^|\/)(node_modules|\.hutch|build|tray-frames)(\/|$)|\.ico$/;
const DEBOUNCE_MS = 300;
const LSREGISTER =
	"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

const devBundle = () => {
	const folder = readdirSync("build").find((name) => name.startsWith("dev-macos-"));
	const app = folder && readdirSync(path.join("build", folder)).find((name) => name.endsWith(".app"));
	if (!folder || !app) throw new Error("electrobun build --env=dev made no .app in build/");
	return path.resolve("build", folder, app);
};

/** The app's stdout and stderr; `open` can't hand it this terminal, so the runner follows the file. */
const APP_LOG = path.resolve("build", "dev-app.log");

/** `open -W`, which exits when the app does. */
let app: ChildProcess | null = null;

const stopApp = () =>
	new Promise<void>((resolve) => {
		const running = app;
		app = null;
		if (!running || running.exitCode !== null) return resolve();
		running.once("exit", () => resolve());
		spawnSync("pkill", ["-f", `${devBundle()}/Contents/MacOS/`]);
	});

const buildAndLaunch = async () => {
	await stopApp();
	const build = spawnSync(electrobun, ["build", "--env=dev"], { stdio: "inherit" });
	if (build.status !== 0) {
		console.error("[dev] build failed; waiting for the next change");
		return;
	}
	const bundle = devBundle();
	applyMacIdentity(bundle, config.app.identifier);
	// The build registered the bundle with Electrobun's stock launcher; register it
	// again so macOS takes the stamped UUID, and not one from another copy of Shoal.
	spawnSync(LSREGISTER, ["-f", bundle]);
	// Launched through Launch Services, as from Finder: macOS attributes its network
	// use to Shoal reliably then, where a child of this terminal can stay blocked.
	writeFileSync(APP_LOG, "");
	app = spawn("open", ["-W", "-n", "--stdout", APP_LOG, "--stderr", APP_LOG, bundle], { stdio: "inherit" });
};

const appOutput = spawn("tail", ["-n", "+1", "-F", APP_LOG], { stdio: "inherit" });

let pending: ReturnType<typeof setTimeout> | undefined;
let building: Promise<void> = buildAndLaunch();

for (const target of WATCHED) {
	watch(target, { recursive: true }, (_event, file) => {
		if (file && IGNORED.test(path.join(target, file))) return;
		clearTimeout(pending);
		pending = setTimeout(() => {
			building = building.then(buildAndLaunch);
		}, DEBOUNCE_MS);
	});
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		await stopApp();
		appOutput.kill();
		process.exit(0);
	});
}
