import { BrowserWindow, Tray } from "electrobun/main";

const tray = new Tray({ image: "views://assets/tray.svg", template: false });
if (tray.id === 0) throw new Error("Could not create a tray icon.");
tray.setMenu([
	{ type: "normal", label: "Open Shoal", action: "open" },
	{ type: "separator" },
	{ type: "normal", label: "Quit Shoal", action: "quit" },
]);

if (process.env.SPIKE_TRAY_ONLY !== "1") {
	new BrowserWindow({
		title: "Shoal",
		url: "views://mainview/index.html",
		frame: { x: 0, y: 0, width: 980, height: 680 },
	});
}
