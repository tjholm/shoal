import { parseArgs } from "node:util";
import { runMigrations } from "./index.ts";

const { positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
});

const [command] = positionals;

switch (command) {
  case "migrate": {
    await runMigrations();
    console.log("Migrations applied.");
    break;
  }

  default:
    console.log(`Usage: bun run db <command>

Commands:
  migrate    Run database migrations

Note: API key, worker token, and user management is now handled through the
web dashboard at /settings (after signing in).`);
}
