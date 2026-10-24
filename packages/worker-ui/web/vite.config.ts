import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where `shoal worker start --ui` listens by default; `vite` proxies the API there while working on the UI. */
const WORKER_UI = "http://127.0.0.1:7337";

export default defineConfig({
	plugins: [tailwindcss(), react()],
	root: import.meta.dirname,
	build: {
		outDir: "../dist",
		emptyOutDir: true,
	},
	server: {
		proxy: { "/api": WORKER_UI },
	},
});
