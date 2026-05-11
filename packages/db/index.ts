import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import postgres from "postgres";
import * as schema from "./schema.ts";

// `pglite://` paths in DATABASE_URL are resolved relative to the repo root
// (not CWD), so the same env value means the same directory in dev tooling
// (drizzle-kit under workspace filter) and at runtime (server, migrations).
// Containers always set absolute paths so this resolution is a no-op there.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const DATABASE_URL = process.env.DATABASE_URL ?? `pglite://data/pgdata`;

type Dialect = "pglite" | "postgres";

function parseUrl(url: string): { dialect: Dialect; target: string } {
  if (url.startsWith("pglite://")) {
    const raw = url.slice("pglite://".length);
    const target = isAbsolute(raw) ? raw : resolve(repoRoot, raw);
    return { dialect: "pglite", target };
  }
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return { dialect: "postgres", target: url };
  }
  throw new Error(
    `DATABASE_URL must start with pglite:// or postgres://. Got: ${url}`,
  );
}

type Schema = typeof schema;
type DbHandle = {
  dialect: Dialect;
  db: PgDatabase<PgQueryResultHKT, Schema>;
  migrate: (migrationsFolder: string) => Promise<void>;
};

const _global = globalThis as Record<string, unknown>;
const DB_KEY = "__shoal_db__";

if (!_global[DB_KEY]) {
  const { dialect, target } = parseUrl(DATABASE_URL);

  if (dialect === "pglite") {
    const client = new PGlite(target);
    const db = drizzlePglite(client, { schema });
    _global[DB_KEY] = {
      dialect,
      db,
      migrate: (folder: string) => migratePglite(db, { migrationsFolder: folder }),
    } satisfies DbHandle;
  } else {
    const client = postgres(target);
    const db = drizzlePg(client, { schema });
    _global[DB_KEY] = {
      dialect,
      db,
      migrate: (folder: string) => migratePg(db, { migrationsFolder: folder }),
    } satisfies DbHandle;
  }
}

const handle = _global[DB_KEY] as DbHandle;

export const db = handle.db;
export const dialect = handle.dialect;
export { schema };
// Re-export the query builder helpers consumers commonly need, so workspace
// packages don't have to declare their own `drizzle-orm` dep.
export { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";

export async function runMigrations(folder?: string): Promise<void> {
  // When called from source (dev tooling), `import.meta.url` points at this
  // file in packages/db, so `./migrations` resolves to packages/db/migrations.
  // Bundled into a nitro output, `import.meta.url` is the bundle path —
  // callers in that context must pass `folder` explicitly (typically from
  // SHOAL_MIGRATIONS_DIR).
  const target = folder ?? new URL("./migrations", import.meta.url).pathname;
  await handle.migrate(target);
}
