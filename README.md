# shoal

Run inference on your own hardware, behind an OpenAI- and Anthropic-compatible API.

Workers run wherever you have GPUs (your desktop, a homelab box, a rented server) and connect out to a central shoal server over WebSocket. Clients hit the server's `/v1` (OpenAI) or `/v1/messages` (Anthropic) endpoints, and the server dispatches the request to a connected worker. The worker proxies to a local Ollama instance and streams the response back.

## Layout

- `apps/server` — TanStack Start app: the dashboard, the OpenAI/Anthropic-compatible API, and the worker WebSocket endpoint. Runs on nitro + bun.
- `apps/web` — marketing / landing site.
- `apps/cli` — the `shoal` CLI. `shoal worker start` connects a local worker to a server.
- `packages/protocol` — zod-typed worker ↔ server WebSocket protocol.
- `packages/server-core` — dispatch, scheduling, auth, and the OpenAI/Anthropic adapter logic.
- `packages/db` — Drizzle schema, migrations, and Better Auth setup.

## Development

```bash
bun install
bun run db:push      # apply schema to your local DB
bun run dev          # starts server + web behind portless (server.shoal.localhost, web.shoal.localhost)
bun run dev:cli      # connect a local worker to the dev server
```
