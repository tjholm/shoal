import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API server in development. Every API path is proxied to it, so the
// dashboard and API share one origin as they do in production, where the API
// serves the built dashboard.
const apiUrl = process.env.SHOAL_API_URL ?? "https://api.shoal.localhost";
const toApi = { target: apiUrl, changeOrigin: true, secure: false, xfwd: true };

export default defineConfig({
	// Honor $PORT and $HOST when set. Portless picks a dynamic port and an
	// explicit IPv4 host (127.0.0.1) and passes both via env — vite otherwise
	// resolves "localhost" to IPv6 ::1 on some systems, which portless's
	// IPv4 proxy can't reach.
	server: {
		port: Number(process.env.PORT) || 3000,
		host: process.env.HOST || "localhost",
		proxy: {
			"/api": toApi,
			"/ws": { ...toApi, ws: true },
		},
	},
	resolve: { tsconfigPaths: true },
	plugins: [
		devtools(),
		tailwindcss(),
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		viteReact(),
	],
});
