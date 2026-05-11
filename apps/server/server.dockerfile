# syntax=docker/dockerfile:1.7
#
# Production-tier server image. Expects DATABASE_URL (and, later, REDIS_URL)
# to point at external services. For the single-container "try shoal" image
# with embedded pglite, see lite.dockerfile.

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
# apps/server/.output/. Includes the SSR app, the /workers WS handler, and
# the scheduler plugin. Uses the `bun` preset.
FROM deps AS build
COPY . .
RUN cd apps/server && bun run build
# PGlite's WASM + initdb-data are loaded relative to its own bundled JS at
# runtime. Vite collapses the JS into _libs/ but doesn't carry these assets;
# bake them in here. Even though this image targets external Postgres, the
# bundle still imports pglite (packages/db loads both adapters), so the
# files must be present for module init.
RUN cp /app/node_modules/.bun/@electric-sql+pglite@*/node_modules/@electric-sql/pglite/dist/postgres.data \
       /app/node_modules/.bun/@electric-sql+pglite@*/node_modules/@electric-sql/pglite/dist/postgres.wasm \
       /app/apps/server/.output/server/_libs/

# Bun runs the nitro output directly. No node_modules copy needed — nitro
# bundles everything it needs.
FROM oven/bun:1-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY --from=build /app/apps/server/.output ./.output
# Drizzle migrations aren't bundled into nitro's output. Copy them in and
# point the migrate plugin at them.
COPY --from=build /app/packages/db/migrations /app/migrations
ENV SHOAL_MIGRATIONS_DIR=/app/migrations

EXPOSE 3000

CMD ["bun", "run", ".output/server/index.mjs"]
