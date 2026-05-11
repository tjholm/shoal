import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

// Same DATABASE_URL convention as the runtime factory (see index.ts):
// `pglite://<path>` paths are resolved relative to the repo root (not CWD)
// so a workspace-filter invocation lands the data dir in the same place as
// a direct `cd`. Postgres URLs are passed through unchanged.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const url = process.env.DATABASE_URL ?? `pglite://data/pgdata`;
const isPglite = url.startsWith("pglite://");

function resolvePglitePath(p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

export default isPglite
  ? defineConfig({
      dialect: "postgresql",
      driver: "pglite",
      schema: "./schema.ts",
      out: "./migrations",
      dbCredentials: { url: resolvePglitePath(url.slice("pglite://".length)) },
    })
  : defineConfig({
      dialect: "postgresql",
      schema: "./schema.ts",
      out: "./migrations",
      dbCredentials: { url },
    });
