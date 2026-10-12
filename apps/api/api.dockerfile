# syntax=docker/dockerfile:1.7
#
# Production server image: the API, serving the built dashboard. Expects
# DATABASE_URL to point at Postgres. On start it applies pending migrations,
# then serves; set SHOAL_SKIP_MIGRATIONS=true when a deploy step migrates or
# several instances share a database.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY bun.lock package.json ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/protocol/package.json packages/protocol/
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN cd apps/dashboard && bun run build

# Bun runs the API's TypeScript directly, so the runtime is the built tree
# with its node_modules rather than a bundle.
FROM oven/bun:1-slim AS runtime
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production \
    PORT=3000 \
    SHOAL_DASHBOARD_DIR=/app/apps/dashboard/dist
EXPOSE 3000
ENTRYPOINT ["apps/api/docker-entrypoint.sh"]
CMD ["bun", "apps/api/src/main.ts"]
