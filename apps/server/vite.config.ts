import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // Honor $PORT and $HOST when set. Portless picks a dynamic port and an
  // explicit IPv4 host (127.0.0.1) and passes both via env — vite otherwise
  // resolves "localhost" to IPv6 ::1 on some systems, which portless's
  // IPv4 proxy can't reach.
  server: {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || "localhost",
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    // Don't install tanstack-start's own SSR dev middleware — nitro's vite
    // plugin owns the dev pipeline (HTTP via dispatchFetch, WS upgrades via
    // its `experimental.websocket` flag). tanstack-start defers when it
    // sees `dispatchFetch` on the SSR env.
    tanstackStart(),
    viteReact(),
    nitro({
      // Nitro auto-resolves `./server.ts` as the server entry. We don't have
      // one — the outer HTTP shell lives entirely inside nitro now — so
      // disable detection.
      serverEntry: false,
      // Routes (`/workers` WS) and plugins (migrate + scheduler init) live
      // under here.
      serverDir: "nitro",
      // The /workers route is a WebSocket upgrade target.
      experimental: { websocket: true },
      // Production target. Build output is `.output/server/index.mjs`,
      // runnable directly under Bun (`bun run`).
      preset: "bun",
    }),
  ],
});
