// Auto-run drizzle migrations on server startup. Gated behind
// SHOAL_AUTO_MIGRATE=true — only the shoal-lite image sets it.
//
// Rationale: lite ships pglite in-container, so the DB lives with the
// container and has nowhere else to be migrated from. The full image
// targets an external Postgres where auto-migrating on every container
// start is dangerous (races between replicas, no ordering vs deploys);
// operators run migrations as a deliberate step there.
//
// Dev startup never auto-migrates either — use `bun run db migrate` or
// `bun run db:push` manually.
//
// In bundled prod, `import.meta.url`-based resolution inside @shoal/db
// doesn't work — the dockerfile copies migrations to a known location
// and sets SHOAL_MIGRATIONS_DIR.
import { runMigrations } from "@shoal/db";
import { definePlugin } from "nitro";

export default definePlugin(async () => {
  if (process.env.SHOAL_AUTO_MIGRATE !== "true") return;
  await runMigrations(process.env.SHOAL_MIGRATIONS_DIR);
  console.log("[migrate] migrations applied");
});