// WebSocket endpoint for worker connections. The actual auth, dispatch, and
// lifecycle logic lives in `../../src/server/worker-ws.ts` — that module
// exposes a crossws Hooks object which `defineWebSocketHandler` accepts
// directly.
//
// Both dev (vite plugin -> upgrade) and prod (nitro bun preset) route here.
import { defineWebSocketHandler } from "nitro";
import { workerHooks } from "../../../src/server/worker-ws";

export default defineWebSocketHandler(workerHooks);
