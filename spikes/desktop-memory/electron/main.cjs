const path = require("node:path");
const { app, BrowserWindow, Menu, Tray } = require("electron");

const shell = path.join(__dirname, "..", "shell");
let tray;

app.on("window-all-closed", () => {});

app.whenReady().then(() => {
	tray = new Tray(path.join(shell, "tray.png"));
	tray.setToolTip("Shoal");
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "Open Shoal", click: () => openWindow() },
			{ type: "separator" },
			{ label: "Quit Shoal", click: () => app.quit() },
		]),
	);
	if (process.env.SPIKE_TRAY_ONLY !== "1") openWindow();
});

function openWindow() {
	const win = new BrowserWindow({ title: "Shoal", width: 980, height: 680 });
	win.loadFile(path.join(shell, "index.html"));
}
