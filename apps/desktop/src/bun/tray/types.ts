import type { Tray } from "electrobun/main";

/** Sharing while accepting work, warning while it wants work but can't connect. */
export type TrayLook = "sharing" | "paused" | "warning";

export interface TrayIcon {
	/** Electrobun's tray, for its menu and clicks. */
	readonly tray: Tray;
	readonly show: (look: TrayLook) => void;
}
