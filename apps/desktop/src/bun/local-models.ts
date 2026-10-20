import { closeSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LOCAL_MODELS_URL } from "../shared/local-models";
import type { LocalModel, LocalModelsState } from "../shared/rpc";

/**
 * Runs llama.cpp's `llama-server` as a router on this computer, so someone
 * without Ollama or LM Studio can still serve jobs. The worker sees it as one
 * more backend URL; everything here is process management.
 *
 * Started without `--model`, llama-server is a router: it downloads models
 * from Hugging Face itself (`POST /models`), runs one child process per
 * loaded model, and reports each model's status in `/v1/models`.
 */

const PORT = new URL(LOCAL_MODELS_URL).port;

const BUILD = "b11748";
/** Vulkan covers NVIDIA, AMD and Intel GPUs on Linux and Windows; the macOS builds use Metal. */
const ASSETS: Record<string, { readonly name: string; readonly sha256: string }> = {
	"darwin-arm64": {
		name: `llama-${BUILD}-bin-macos-arm64.tar.gz`,
		sha256: "003af1321ed9be9485902a2e17aad0c874a456c10f0a4ece5a735c495f3a3afb",
	},
	"darwin-x64": {
		name: `llama-${BUILD}-bin-macos-x64.tar.gz`,
		sha256: "fa10a8f9fbab806c8e4423ea8848ec317ed601d2bc009a45880a509e69f372f0",
	},
	"linux-arm64": {
		name: `llama-${BUILD}-bin-ubuntu-vulkan-arm64.tar.gz`,
		sha256: "3b5d74bdfd1afcae1349aedbee06c638d33ddb6618416b79b2b0fcf176932661",
	},
	"linux-x64": {
		name: `llama-${BUILD}-bin-ubuntu-vulkan-x64.tar.gz`,
		sha256: "0c0e4eb9d3984374afee11ee9b1aa5720cf0d68d5533f49883a9d0e9c085463f",
	},
	"win32-arm64": {
		name: `llama-${BUILD}-bin-win-vulkan-arm64.zip`,
		sha256: "7ffc0889871cdf9854dcd997de809b270262175bba4c471fbca946fef098d011",
	},
	"win32-x64": {
		name: `llama-${BUILD}-bin-win-vulkan-x64.zip`,
		sha256: "5fd54edf6fb98240ea136de43a090969e79f74557dc24b39286bff1cdf240688",
	},
};

const dataDir =
	process.platform === "darwin"
		? path.join(os.homedir(), "Library", "Application Support", "shoal")
		: process.platform === "win32"
			? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "shoal")
			: path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "shoal");
const llamaDir = path.join(dataDir, "llama.cpp");
const binDir = path.join(llamaDir, BUILD);
const cacheDir = path.join(llamaDir, "models");
const pidFile = path.join(llamaDir, "llama-server.pid");
export const logFile = path.join(llamaDir, "llama-server.log");

const executableName = process.platform === "win32" ? "llama-server.exe" : "llama-server";

const findExecutable = async (dir: string): Promise<string | null> => {
	for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile() && entry.name === executableName) return path.join(entry.parentPath, entry.name);
	}
	return null;
};

/** `SHOAL_LLAMA_SERVER` points at a llama-server you built or installed yourself
 *  (e.g. from nixpkgs); otherwise the pinned release build is downloaded once. */
const installedServer = async (onProgress: (detail: string) => void): Promise<string> => {
	const override = process.env.SHOAL_LLAMA_SERVER;
	if (override) return override;

	const existing = await findExecutable(binDir).catch(() => null);
	if (existing) return existing;

	const asset = ASSETS[`${process.platform}-${process.arch}`];
	if (!asset) {
		throw new Error(
			`No llama.cpp build for ${process.platform}-${process.arch}. Set SHOAL_LLAMA_SERVER to a llama-server you installed.`,
		);
	}
	const url = `https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}/${asset.name}`;
	onProgress(`Downloading llama.cpp ${BUILD}`);
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}`);
	const archive = await response.arrayBuffer();
	const digest = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
	if (digest !== asset.sha256) {
		throw new Error(`${asset.name} has sha256 ${digest}, expected ${asset.sha256}. Not installing it.`);
	}

	onProgress("Unpacking llama.cpp");
	const staging = `${binDir}.partial`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });
	const archivePath = path.join(staging, asset.name);
	await Bun.write(archivePath, archive);
	// bsdtar ships with macOS and Windows 10+, and reads zip as well as tar.gz.
	const tar = Bun.spawn(["tar", "-xf", archivePath, "-C", staging], { stderr: "pipe" });
	if ((await tar.exited) !== 0) {
		throw new Error(`Unpacking ${asset.name} failed: ${await new Response(tar.stderr).text()}`);
	}
	await rm(archivePath);
	await rename(staging, binDir);

	const executable = await findExecutable(binDir);
	if (!executable) throw new Error(`${asset.name} has no ${executableName} in it.`);
	return executable;
};

/** A llama-server left running by a copy of the app that crashed holds the port. */
const stopOrphan = async () => {
	const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
	if (!pid) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Already gone.
	}
	await rm(pidFile, { force: true });
};

const tailOfLog = async () => (await readFile(logFile, "utf8").catch(() => "")).trim().split("\n").slice(-8).join("\n");

const HEALTH_TIMEOUT_MS = 30_000;

const waitUntilHealthy = async (exited: Promise<number>) => {
	let exitCode: number | null = null;
	void exited.then((code) => {
		exitCode = code;
	});
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (exitCode !== null) {
			throw new Error(`llama-server exited with code ${exitCode}:\n${await tailOfLog()}`);
		}
		const healthy = await fetch(`${LOCAL_MODELS_URL}/health`).then(
			(r) => r.ok,
			() => false,
		);
		if (healthy) return;
		await Bun.sleep(250);
	}
	throw new Error(`llama-server didn't answer on ${LOCAL_MODELS_URL} within ${HEALTH_TIMEOUT_MS / 1000}s. See ${logFile}.`);
};

export interface LocalModelsServer {
	readonly stop: () => Promise<void>;
}

/** Installs llama-server if needed and starts it. `onState` hears every phase,
 *  including a later crash. */
export const startLocalModels = async (onState: (state: LocalModelsState) => void): Promise<LocalModelsServer> => {
	let stopping = false;
	let child: Bun.Subprocess | null = null;
	const stop = async () => {
		stopping = true;
		child?.kill();
		await child?.exited;
		await rm(pidFile, { force: true });
		onState({ phase: "off", detail: null });
	};

	try {
		await mkdir(cacheDir, { recursive: true });
		const executable = await installedServer((detail) => onState({ phase: "installing", detail }));
		await stopOrphan();

		onState({ phase: "starting", detail: null });
		const log = openSync(logFile, "w");
		child = Bun.spawn(
			[
				executable,
				"--host",
				"127.0.0.1",
				"--port",
				PORT,
				// One model resident at a time; this is someone's own computer.
				"--models-max",
				"1",
				// Frees a model's memory after five idle minutes; the next job reloads it.
				"--sleep-idle-seconds",
				"300",
				"--no-webui",
			],
			{
				env: { ...process.env, LLAMA_CACHE: cacheDir },
				stdio: ["ignore", log, log],
			},
		);
		closeSync(log);
		await writeFile(pidFile, String(child.pid));

		const exited = child.exited;
		await waitUntilHealthy(exited);
		onState({ phase: "running", detail: null });

		void exited.then(async (code) => {
			if (stopping) return;
			await rm(pidFile, { force: true });
			onState({ phase: "failed", detail: `llama-server exited with code ${code}:\n${await tailOfLog()}` });
		});
	} catch (error) {
		child?.kill();
		await rm(pidFile, { force: true });
		onState({ phase: "failed", detail: error instanceof Error ? error.message : String(error) });
	}
	return { stop };
};

interface RouterModels {
	readonly data: ReadonlyArray<{ readonly id: string; readonly status: { readonly value: string } }>;
}

export const listLocalModels = async (): Promise<ReadonlyArray<LocalModel>> => {
	const response = await fetch(`${LOCAL_MODELS_URL}/v1/models`);
	if (!response.ok) throw new Error(`llama-server answered HTTP ${response.status}`);
	const { data } = (await response.json()) as RouterModels;
	return data.map((m) => ({ id: m.id, status: m.status.value }));
};

/** Resolves to an error message, or null once llama-server has started the download. */
const routerRequest = async (request: Request): Promise<string | null> => {
	const response = await fetch(request).catch((error: Error) => error);
	if (response instanceof Error) return `llama.cpp isn't running: ${response.message}`;
	if (response.ok) return null;
	const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
	return body?.error?.message ?? `llama-server answered HTTP ${response.status}`;
};

/** `repo` is a Hugging Face GGUF repo, optionally with a quant: `ggml-org/gemma-3-1b-it-GGUF:Q4_K_M`. */
export const downloadLocalModel = (repo: string) =>
	routerRequest(
		new Request(`${LOCAL_MODELS_URL}/models`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: repo }),
		}),
	);

export const deleteLocalModel = (id: string) =>
	routerRequest(new Request(`${LOCAL_MODELS_URL}/models?model=${encodeURIComponent(id)}`, { method: "DELETE" }));
