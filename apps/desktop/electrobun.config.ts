import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Shoal",
		identifier: "school.shoal.desktop",
		// Set from the release tag in CI (.github/workflows/publish.yml).
		version: process.env.SHOAL_VERSION ?? "0.0.0-dev",
	},
	release: {
		// The latest published release; drafts and prereleases are skipped.
		baseUrl: "https://github.com/tjholm/shoal/releases/latest/download",
	},
	runtime: {
		// The app lives in the tray; closing the setup window must not quit it.
		exitOnLastWindowClosed: false,
	},
	build: {
		// The worker is Effect on Bun; Cottontail's API coverage is undocumented.
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		// Vite builds the window into dist/; see vite.config.ts.
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"assets/tray-sharing.svg": "views/assets/tray-sharing.svg",
			"assets/tray-paused.svg": "views/assets/tray-paused.svg",
			"assets/tray-template-sharing.svg": "views/assets/tray-template-sharing.svg",
			"assets/tray-template-paused.svg": "views/assets/tray-template-paused.svg",
			// The Windows tray loads only .ico files; scripts/icon.ts renders them.
			"assets/tray-sharing.ico": "views/assets/tray-sharing.ico",
			"assets/tray-paused.ico": "views/assets/tray-paused.ico",
		},
		// In dev:hmr, Vite's dev server serves the window instead.
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
			// Rendered from assets/icon.svg.
			icons: "assets/icon.iconset",
		},
		linux: {
			bundleCEF: false,
			// Rendered from assets/icon.svg.
			icon: "assets/icon.png",
		},
		win: {
			bundleCEF: false,
			// Rendered from assets/icon.svg.
			icon: "assets/icon.ico",
		},
	},
} satisfies ElectrobunConfig;
