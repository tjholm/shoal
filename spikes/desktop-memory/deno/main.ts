const shell = new URL("../shell/", import.meta.url);
const html = await Deno.readTextFile(new URL("index.html", shell));
const trayIcon = await Deno.readFile(new URL("tray.png", shell));

Deno.serve(() => new Response(html, { headers: { "content-type": "text/html" } }));

const win = new Deno.BrowserWindow({ title: "Shoal", width: 980, height: 680 });
if (Deno.env.get("SPIKE_TRAY_ONLY") === "1") win.hide();
win.addEventListener("close", (event) => {
	event.preventDefault();
	win.hide();
});

const tray = new Deno.Tray();
if (tray.trayId === 0) throw new Error("Could not create a tray icon.");
tray.setIcon(trayIcon);
tray.setTooltip("Shoal");
tray.setMenu([
	{ item: { label: "Open Shoal", id: "open", enabled: true } },
	"separator",
	{ item: { label: "Quit Shoal", id: "quit", enabled: true } },
]);
tray.addEventListener("menuclick", (event) => {
	if (event.detail.id === "open") win.show();
	if (event.detail.id === "quit") Deno.exit(0);
});
