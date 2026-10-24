import type { TrayIcon } from "./types";

export type { TrayIcon, TrayLook } from "./types";

/** Creates the tray icon the way this platform needs, loading only that platform's code. */
export const createTrayIcon = async (): Promise<TrayIcon> => {
	const icon =
		process.platform === "darwin"
			? (await import("./darwin")).createTrayIcon()
			: process.platform === "win32"
				? (await import("./windows")).createTrayIcon()
				: (await import("./linux")).createTrayIcon();
	// Tray swallows native failures and leaves id at 0; without a tray there is
	// no way to control or quit the app.
	if (icon.tray.id === 0) {
		throw new Error(
			"Could not create a system tray icon. Your desktop needs a StatusNotifierItem host (on GNOME, the AppIndicator extension).",
		);
	}
	return icon;
};
