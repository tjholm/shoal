import { Tray } from "electrobun/main";
import type { TrayIcon, TrayLook } from "./types";

/** Points, the menu bar's icon height. */
const SIZE = 18;
// Matches TRAY_FRAMES in scripts/icon.ts, which renders the frames.
const TRAY_FRAMES = 24;
// 5° a frame at 25 frames a second: a turn of the three fish each second.
const FRAME_MS = 40;

// Template images let macOS tint the icon to suit the menu bar.
const stillImage = (look: TrayLook) => `views://assets/tray-template-${look}.svg`;
const frameImage = (frame: number) => `views://assets/tray-frames/${frame}.svg`;

export const createTrayIcon = (): TrayIcon => {
	const tray = new Tray({ image: stillImage("paused"), template: true, width: SIZE, height: SIZE });

	const setImage = (image: string) => {
		if (image === tray.image) return;
		// Electrobun's setImage drops the template flag and size, but re-showing a
		// hidden tray rebuilds it from the stored image, flag and size.
		tray.setVisible(false);
		tray.setImage(image);
		tray.setVisible(true);
	};

	let look: TrayLook = "paused";
	let spinning: ReturnType<typeof setInterval> | null = null;
	return {
		tray,
		show: (next) => {
			look = next;
			if (spinning === null) setImage(stillImage(look));
		},
		spin: (on) => {
			if (on && spinning === null) {
				let frame = 0;
				spinning = setInterval(() => {
					frame = (frame + 1) % TRAY_FRAMES;
					setImage(frameImage(frame));
				}, FRAME_MS);
			} else if (!on && spinning !== null) {
				clearInterval(spinning);
				spinning = null;
				setImage(stillImage(look));
			}
		},
	};
};
