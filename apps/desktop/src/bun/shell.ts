import { ApplicationMenu, Utils } from "electrobun/main";

/** On macOS the app shows in the Dock only while its window is open; elsewhere it has no Dock. */
export const setDockIconVisible = (visible: boolean) => {
	if (process.platform === "darwin") Utils.setDockIconVisible(visible);
};

/** macOS routes Cmd+C/V/X/A/Z through the main menu; without an Edit menu the window's text fields can't copy or paste. */
export const installAppMenu = () => {
	if (process.platform !== "darwin") return;
	ApplicationMenu.setApplicationMenu([
		{
			label: "Shoal",
			submenu: [{ role: "hide" }, { role: "hideOthers" }, { role: "showAll" }],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "Window",
			submenu: [{ role: "minimize" }, { role: "close" }],
		},
	]);
};
