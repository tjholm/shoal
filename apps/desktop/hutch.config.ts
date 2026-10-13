// @hutch cli=0.27.1 cottontail=0.7.1
export default {
	// Dependencies live in the repo's bun workspace (root bun.lock), not hutch.lock.
	// `hutch pm` forwards to bun, so binaries run via `pm run` (`bun exec` skips node_modules/.bin).
	packageManager: { name: "bun", executable: "bun" },
	scripts: {
		install: ["hutch", "install"],
		start: "hutch electrobun prepare && hutch pm run vite build && hutch electrobun dev",
		dev: "hutch electrobun prepare && hutch pm run vite build && hutch electrobun dev --watch",
		"dev:hmr": ["hutch", "pm", "run", "concurrently", "hutch run hmr", "hutch run start"],
		hmr: "hutch electrobun prepare && hutch pm run vite",
		build: "hutch electrobun prepare && hutch pm run vite build && hutch electrobun build --env=stable",
	},
	electrobun: {
		version: "2.0.2",
	},
};
