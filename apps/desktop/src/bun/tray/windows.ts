import { Tray } from "electrobun/main";
import type { TrayIcon, TrayLook } from "./types";

// The Windows tray loads only .ico files.
const image = (look: TrayLook) => `views://assets/tray-${look}.ico`;

export const createTrayIcon = (): TrayIcon => {
	// The 32px image, which Windows scales down to fit the tray at any display scaling.
	const tray = new Tray({ image: image("paused"), template: false, width: 32, height: 32 });
	return {
		tray,
		show: (look) => {
			if (image(look) !== tray.image) tray.setImage(image(look));
		},
	};
};
