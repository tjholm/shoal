# syntax=docker/dockerfile:1.7
#
# Marketing / landing site. TanStack Start + nitro, no database, no
# migrations — just the SSR app.

FROM oven/bun:1 AS deps
WORKDIR /app

COPY bun.lock package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY packages/db/package.json packages/db/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server-core/package.json packages/server-core/

RUN bun install --frozen-lockfile

# Nitro (via the vite plugin) produces a self-contained server artifact at
# apps/web/.output/. Uses the `bun` preset.
FROM deps AS build
COPY . .
RUN cd apps/web && bun run build

# Bun runs the nitro output directly. No node_modules copy needed — nitro
# bundles everything it needs.
FROM oven/bun:1-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY --from=build /app/apps/web/.output ./.output

EXPOSE 3000

CMD ["bun", "run", ".output/server/index.mjs"]
