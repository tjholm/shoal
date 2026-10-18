import type { ElectrobunConfig } from "electrobun";

const mainProcess = process.env.SPIKE_MAIN_PROCESS === "bun" ? "bun" : "cottontail";

export default {
	app: {
		name: `ShoalSpike-${mainProcess}`,
		identifier: `sh.shoal.spike.${mainProcess}`,
		version: "0.0.0",
	},
	runtime: {
		exitOnLastWindowClosed: false,
	},
	build: {
		mainProcess,
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy: {
			"shell/index.html": "views/mainview/index.html",
			"shell/tray.svg": "views/assets/tray.svg",
		},
		linux: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
