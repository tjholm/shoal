import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Schema } from "effect";

/** What a person enters in a client's settings form, before validation. */
export interface SettingsInput {
	readonly serverUrl: string;
	/** Empty keeps the saved token. */
	readonly token: string;
	readonly backends: ReadonlyArray<string>;
	/** Empty keeps whatever name the server has stored. */
	readonly name: string;
	readonly concurrency: number;
}

/** Whether the worker should take work. A pause ends on its own at `pausedUntil` (epoch ms). */
const Availability = Schema.Union([
	Schema.Literal("on"),
	Schema.Literal("off"),
	Schema.Struct({ pausedUntil: Schema.Number }),
]);
export type Availability = typeof Availability.Type;

/** A worker's saved settings, shared by every shoal client on this machine.
 *  The token is kept in the OS credential store, not here. */
const SettingsFile = Schema.Struct({
	/** Origin of the shoal server, e.g. https://shoal.example.com. */
	serverUrl: Schema.String,
	backends: Schema.Array(Schema.String),
	name: Schema.optionalKey(Schema.String),
	concurrency: Schema.optionalKey(Schema.Number),
	availability: Schema.optionalKey(Availability),
});
const SettingsJson = Schema.fromJsonString(SettingsFile);

export interface Settings {
	readonly serverUrl: string;
	readonly backends: ReadonlyArray<string>;
	readonly name: string;
	readonly concurrency: number;
	readonly availability: Availability;
}

export const settingsPath = path.join(
	process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
	"shoal",
	"worker.json",
);

/** The saved settings, or null before first-run setup. Throws if the file is unreadable. */
export const loadSettings = async (): Promise<Settings | null> => {
	let raw: string;
	try {
		raw = await readFile(settingsPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let file: typeof SettingsFile.Type;
	try {
		file = Schema.decodeUnknownSync(SettingsJson)(raw);
	} catch (error) {
		throw new Error(
			`Settings file ${settingsPath} is invalid. Fix or delete it, then restart Shoal.`,
			{ cause: error },
		);
	}
	return {
		serverUrl: file.serverUrl,
		backends: file.backends,
		name: file.name ?? "",
		concurrency: file.concurrency ?? 1,
		availability: file.availability ?? "on",
	};
};

export const saveSettings = async (settings: Settings) => {
	await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	await writeFile(settingsPath, Schema.encodeSync(SettingsJson)(settings), { mode: 0o600 });
	// writeFile's mode only applies when it creates the file.
	await chmod(settingsPath, 0o600);
};

/** One API key per server, in the Keychain, libsecret or Windows Credential Manager. */
const tokenEntry = (serverUrl: string) => ({ service: "school.shoal.worker", name: serverUrl });

export const loadToken = (serverUrl: string): Promise<string | null> =>
	Bun.secrets.get(tokenEntry(serverUrl));

export const saveToken = (serverUrl: string, token: string): Promise<void> =>
	Bun.secrets.set({ ...tokenEntry(serverUrl), value: token });

/** Bare hosts are allowed so people can paste "shoal.example.com". */
const parseHttpUrl = (input: string) => {
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
	try {
		const url = new URL(withScheme);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
};

/** `token` is null when the input keeps the saved one; the caller checks one is saved. */
export const validateSettings = (
	input: SettingsInput,
	saved: Settings | null,
): { settings: Settings; token: string | null } | { errors: ReadonlyArray<string> } => {
	const errors: Array<string> = [];

	const server = parseHttpUrl(input.serverUrl.trim());
	if (server === null) errors.push("Server address must be a web address, like https://shoal.example.com.");

	const backends: Array<string> = [];
	for (const entry of input.backends.map((b) => b.trim()).filter((b) => b !== "")) {
		const url = parseHttpUrl(entry);
		if (url === null) errors.push(`"${entry}" isn't a valid model server address.`);
		else backends.push(url.href.replace(/\/$/, ""));
	}
	if (input.backends.every((b) => b.trim() === "")) errors.push("Add at least one model server.");

	if (!Number.isInteger(input.concurrency) || input.concurrency < 1) {
		errors.push("Concurrent jobs must be a whole number of at least 1.");
	}

	if (errors.length > 0 || server === null) return { errors };
	return {
		settings: {
			serverUrl: server.origin,
			backends,
			name: input.name.trim(),
			concurrency: input.concurrency,
			availability: saved?.availability ?? "on",
		},
		token: input.token.trim() || null,
	};
};

/** The worker WebSocket for a server origin, e.g. https://x → wss://x/ws/workers. */
export const workerSocketUrl = (serverUrl: string) => {
	const url = new URL("/ws/workers", serverUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
};
