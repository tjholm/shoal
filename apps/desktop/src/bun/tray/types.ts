import type { Tray } from "electrobun/main";

/** Sharing while accepting work, warning while it wants work but can't connect. */
export type TrayLook = "sharing" | "paused" | "warning";

export interface TrayIcon {
	/** Electrobun's tray, for its menu and clicks. */
	readonly tray: Tray;
	/** Shows the still icon for `look`, once the icon stops spinning if it is. */
	readonly show: (look: TrayLook) => void;
	/** Turns the icon while `on`; absent where the platform has no frames to show. */
	readonly spin?: (on: boolean) => void;
}
