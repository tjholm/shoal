import { Tray } from "electrobun/main";
import type { TrayIcon, TrayLook } from "./types";

/** Points, the menu bar's icon height. */
const SIZE = 18;

// Template images let macOS tint the icon to suit the menu bar.
const image = (look: TrayLook) => `views://assets/tray-template-${look}.svg`;

export const createTrayIcon = (): TrayIcon => {
	const tray = new Tray({ image: image("paused"), template: true, width: SIZE, height: SIZE });
	return {
		tray,
		show: (look) => {
			if (image(look) === tray.image) return;
			// Electrobun's setImage drops the template flag and size, but re-showing a
			// hidden tray rebuilds it from the stored image, flag and size.
			tray.setVisible(false);
			tray.setImage(image(look));
			tray.setVisible(true);
		},
	};
};
