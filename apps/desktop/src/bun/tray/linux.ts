import { Tray } from "electrobun/main";
import type { TrayIcon, TrayLook } from "./types";

const image = (look: TrayLook) => `views://assets/tray-${look}.svg`;

export const createTrayIcon = (): TrayIcon => {
	const tray = new Tray({ image: image("paused"), template: false });
	return {
		tray,
		show: (look) => {
			if (image(look) !== tray.image) tray.setImage(image(look));
		},
	};
};
