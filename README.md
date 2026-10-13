# shoal

Run inference on your own hardware, behind an OpenAI- and Anthropic-compatible API.

Workers run wherever you have GPUs (your desktop, a homelab box, a rented server) and connect out to a central shoal server over WebSocket. Clients hit the server's `/v1` (OpenAI) or `/v1/messages` (Anthropic) endpoints, and the server dispatches the request to a connected worker. The worker proxies to a local Ollama instance and streams the response back.

## Layout

- `apps/api` — the server, an Effect HTTP server on Bun: the OpenAI/Anthropic-compatible API, the worker WebSocket, auth, the dashboard's API, and background jobs. Serves the built dashboard in production.
- `apps/dashboard` — the dashboard, a Vite + TanStack Router single-page app. In development it proxies `/api` and `/ws` to `apps/api`.
- `apps/web` — marketing / landing site.
- `apps/cli` — the `shoal` CLI, built on Effect. `shoal worker start` connects a local worker to a server.
- `apps/desktop` — an optional tray app ([Electrobun](https://framework.blackboard.sh/electrobun/)) that runs a worker on a desktop and lets you pause it or unload models.
- `packages/client-core` — the worker itself (server connection, backend discovery, inference proxying, unloading), shared by the CLI and the desktop app.
- `packages/ui` — the design system (theme, shadcn components) shared by the dashboard and the desktop app.
- `packages/protocol` — the worker ↔ server WebSocket protocol, as Effect Schemas.
- `packages/contracts` — the dashboard API (an Effect HttpApi) shared by `apps/api` and `apps/dashboard`.
- `packages/db` — Drizzle schema, migrations, and the `Database` service (drizzle's Effect driver on `@effect/sql-pg`).

## Self-hosting

```bash
curl -fsSL https://shoal.school/install.sh | sh
```

On Windows, in PowerShell: `irm https://shoal.school/install.ps1 | iex`.

That makes a `shoal` folder holding a `compose.yml` and a `.env` with a
freshly generated `BETTER_AUTH_SECRET` and `SHOAL_URL`, starts shoal and
Postgres, and waits until <http://localhost:3000> answers. Running it again keeps both files.
Sign up there: the first account becomes the owner, and later sign-ups need
an invitation unless `SHOAL_ALLOW_SIGNUP=true`. Create that account before
anyone else can reach the server, or whoever signs up first owns it. Then use **Connect worker**
in the dashboard to run a worker next to your model server, and **Connect
your app** to point an OpenAI- or Anthropic-compatible client at it.

`SHOAL_URL` starts as `http://localhost:3000`, which only this machine can
reach. For workers on other machines, set it in `.env` to the address they
reach this one at, such as `http://192.168.1.10:3000` or your domain, then run
`docker compose up -d` again and open the dashboard at that address.

To update, run `docker compose pull && docker compose up -d` in that folder.

The image, `ghcr.io/tjholm/shoal`, runs anywhere that runs containers,
given a Postgres database in `DATABASE_URL`, a `BETTER_AUTH_SECRET` of at
least 32 characters, and its public address in both `SHOAL_APP_URL` and
`SHOAL_SERVER_URL`. It applies pending migrations on start; set
`SHOAL_SKIP_MIGRATIONS=true` when a deploy step migrates or several instances
share a database. Invitation emails go to the server log unless
`EMAIL_PROVIDER=resend` (see `.env.example`).

## Running a worker

A worker runs beside a model server, reports which models it has, and runs
the requests shoal sends it. **Connect worker** in the dashboard writes the
command for you; by hand it's:

```bash
npx @shoal.school/cli worker start \
  --server ws://192.168.1.10:3000/ws/workers \
  --token sk_...
```

It needs Node 22 or later. The token is an API key from the dashboard.

| Flag | Default | |
|---|---|---|
| `--server` | (required) | The server's worker socket: `SHOAL_URL` with `ws://` or `wss://` and `/ws/workers` |
| `--token` | `SHOAL_TOKEN` | API key the worker connects with |
| `--backend` | `BACKEND_URL`, else `http://localhost:11434` | Model server URL; repeat or comma-separate for several |
| `--concurrency` | `1` | Jobs the worker runs at once |
| `--name` | | Name shown in the dashboard; overrides a rename made there |

Ollama, LM Studio, llama.cpp, llama-swap, vLLM and Lemonade all work, as does
any other OpenAI-compatible server. The worker connects out to shoal, so the
worker's machine needs no open ports.

## Development

```bash
bun install
cp .env.example .env
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" >> .env
docker compose up -d --wait postgres
bun run db migrate   # apply migrations to the local Postgres
bun run dev          # starts api + dashboard + web behind portless (api.shoal.localhost, server.shoal.localhost, web.shoal.localhost)
bun run dev:cli      # connect a local worker to the dev server
```
