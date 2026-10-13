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
}

/** A worker's saved connection settings, shared by every shoal client on
 *  this machine. */
const Settings = Schema.Struct({
	/** Origin of the shoal server, e.g. https://shoal.example.com. */
	serverUrl: Schema.String,
	token: Schema.String,
	backends: Schema.Array(Schema.String),
});
export type Settings = typeof Settings.Type;

const SettingsJson = Schema.fromJsonString(Settings);

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
	try {
		return Schema.decodeUnknownSync(SettingsJson)(raw);
	} catch (error) {
		throw new Error(
			`Settings file ${settingsPath} is invalid. Fix or delete it, then restart Shoal.`,
			{ cause: error },
		);
	}
};

export const saveSettings = async (settings: Settings) => {
	await mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	await writeFile(settingsPath, Schema.encodeSync(SettingsJson)(settings), { mode: 0o600 });
	// writeFile's mode only applies when it creates the file.
	await chmod(settingsPath, 0o600);
};

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

export const validateSettings = (
	input: SettingsInput,
	saved: Settings | null,
): { settings: Settings } | { errors: ReadonlyArray<string> } => {
	const errors: Array<string> = [];

	const server = parseHttpUrl(input.serverUrl.trim());
	if (server === null) errors.push("Server address must be a web address, like https://shoal.example.com.");

	const token = input.token.trim() || saved?.token || "";
	if (token === "") errors.push("Enter the API key from your shoal dashboard.");

	const backends: Array<string> = [];
	for (const entry of input.backends.map((b) => b.trim()).filter((b) => b !== "")) {
		const url = parseHttpUrl(entry);
		if (url === null) errors.push(`"${entry}" isn't a valid model server address.`);
		else backends.push(url.href.replace(/\/$/, ""));
	}
	if (input.backends.every((b) => b.trim() === "")) errors.push("Add at least one model server.");

	if (errors.length > 0 || server === null) return { errors };
	return { settings: { serverUrl: server.origin, token, backends } };
};

/** The worker WebSocket for a server origin, e.g. https://x → wss://x/ws/workers. */
export const workerSocketUrl = (serverUrl: string) => {
	const url = new URL("/ws/workers", serverUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
};
