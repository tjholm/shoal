import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ID = "school.shoal.desktop";
// Electrobun installs the launcher beside the Bun binary running this process.
const launcher = path.join(
	path.dirname(process.execPath),
	process.platform === "win32" ? "launcher.exe" : "launcher",
);

const macAgent = path.join(os.homedir(), "Library", "LaunchAgents", `${ID}.plist`);
const linuxAutostart = path.join(
	process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
	"autostart",
	`${ID}.desktop`,
);
const windowsRunKey = ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Shoal"];

const reg = (...args: Array<string>) => Bun.spawnSync(["reg", ...args], { stdio: ["ignore", "ignore", "pipe"] });

export const isLaunchAtLogin = (): boolean => {
	switch (process.platform) {
		case "darwin":
			return existsSync(macAgent);
		case "win32":
			return reg("query", ...windowsRunKey).exitCode === 0;
		default:
			return existsSync(linuxAutostart);
	}
};

export const setLaunchAtLogin = async (enabled: boolean): Promise<void> => {
	switch (process.platform) {
		case "darwin":
			if (!enabled) return rm(macAgent, { force: true });
			await mkdir(path.dirname(macAgent), { recursive: true });
			return writeFile(
				macAgent,
				`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${ID}</string>
	<key>ProgramArguments</key><array><string>${launcher}</string></array>
	<key>RunAtLoad</key><true/>
</dict>
</plist>
`,
			);
		case "win32": {
			const result = enabled
				? reg("add", ...windowsRunKey, "/t", "REG_SZ", "/d", `"${launcher}"`, "/f")
				: reg("delete", ...windowsRunKey, "/f");
			if (result.exitCode !== 0 && (enabled || isLaunchAtLogin())) {
				throw new Error(`Couldn't change the login item: ${result.stderr.toString().trim()}`);
			}
			return;
		}
		default:
			if (!enabled) return rm(linuxAutostart, { force: true });
			await mkdir(path.dirname(linuxAutostart), { recursive: true });
			return writeFile(
				linuxAutostart,
				`[Desktop Entry]\nType=Application\nName=Shoal\nExec="${launcher}"\nX-GNOME-Autostart-enabled=true\n`,
			);
	}
};
