import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

export default defineConfig({
	plugins: [tailwindcss(), react()],
	resolve: {
		alias: electrobunViteAliases(resolve(import.meta.dirname, ".hutch/devkit")),
	},
	root: "src/mainview",
	// views:// serves the bundle from a directory, not a site root.
	base: "./",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
	},
	server: {
		// The main process probes this port in dev; see DEV_SERVER_URL in src/bun/index.ts.
		port: 5173,
		strictPort: true,
	},
});
