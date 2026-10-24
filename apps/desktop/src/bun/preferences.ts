import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Schema } from "effect";
import { store } from "./store";

/** How the desktop app looks, kept apart from the worker settings it shares with the CLI. */
const PreferencesFile = Schema.Struct({
	/** Spin the tray icon while jobs are running. */
	animateTray: Schema.optionalKey(Schema.Boolean),
});
const PreferencesJson = Schema.fromJsonString(PreferencesFile);

export interface Preferences {
	readonly animateTray: boolean;
}

const file = path.join(store.dir, "desktop.json");

/** The saved preferences, or the defaults before any are saved. Throws if the file is unreadable. */
export const loadPreferences = async (): Promise<Preferences> => {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { animateTray: false };
		throw error;
	}
	let saved: typeof PreferencesFile.Type;
	try {
		saved = Schema.decodeUnknownSync(PreferencesJson)(raw);
	} catch (error) {
		throw new Error(`Preferences file ${file} is invalid. Fix or delete it, then restart Shoal.`, { cause: error });
	}
	return { animateTray: saved.animateTray ?? false };
};

export const savePreferences = async (preferences: Preferences) => {
	await mkdir(store.dir, { recursive: true, mode: 0o700 });
	await writeFile(file, Schema.encodeSync(PreferencesJson)(preferences), { mode: 0o600 });
	// writeFile's mode only applies when it creates the file.
	await chmod(file, 0o600);
};
