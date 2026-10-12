import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Database } from "./database.ts";

const usage = `Usage: bun run db <command>

Commands:
  migrate    Run database migrations

API keys, worker tokens and users are managed in the dashboard.`;

const program = Effect.gen(function* () {
	const [command] = process.argv.slice(2);
	if (command !== "migrate") return yield* Console.log(usage);
	yield* (yield* Database).migrate;
	yield* Console.log("Migrations applied.");
});

program.pipe(Effect.provide(Database.layer), NodeRuntime.runMain);
