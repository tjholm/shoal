import { fileURLToPath } from "node:url";
import { PgClient } from "@effect/sql-pg";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { type EffectPgDatabase, makeWithDefaults } from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { Config, Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/sql";

/** The drizzle handle queries are built on; each query is an Effect. */
export type Drizzle = EffectPgDatabase;

/** Where `drizzle-kit generate` writes migrations. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
	"DatabaseError",
	{ cause: Schema.Defect() },
) {}

/** The shoal Postgres database at `DATABASE_URL`. The connection pool's
 *  lifetime is the layer's. */
export class Database extends Context.Service<
	Database,
	{
		/** Run a drizzle query, failing with `DatabaseError` if the driver does. */
		query<A>(
			run: (db: Drizzle) => Effect.Effect<A, EffectDrizzleQueryError | SqlError.SqlError>,
		): Effect.Effect<A, DatabaseError>;
		/** Apply pending migrations, using the same `drizzle.__drizzle_migrations`
		 *  bookkeeping as `drizzle-kit migrate`. Not safe to run from two
		 *  processes at once. */
		readonly migrate: Effect.Effect<void, DatabaseError>;
	}
>()("@shoal/db/Database") {
	/** The pool at `DATABASE_URL`, for code that needs `PgClient` itself. */
	static readonly clientLayer = PgClient.layerConfig({
		url: Config.Redacted("DATABASE_URL"),
	});

	static readonly layerNoDeps = Layer.effect(
		Database,
		Effect.gen(function* () {
			const db = yield* makeWithDefaults();
			const toDatabaseError = Effect.mapError((cause: unknown) => new DatabaseError({ cause }));
			return Database.of({
				query: (run) => run(db).pipe(toDatabaseError),
				migrate: migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }).pipe(
					toDatabaseError,
					Effect.asVoid,
				),
			});
		}),
	);

	static readonly layer = Database.layerNoDeps.pipe(
		Layer.provideMerge(Database.clientLayer),
	);
}
