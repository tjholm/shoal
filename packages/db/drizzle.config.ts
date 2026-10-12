import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) {
	throw new Error(
		"DATABASE_URL is not set. Start Postgres with `docker compose up -d postgres` and copy .env.example to .env.",
	);
}

export default defineConfig({
	dialect: "postgresql",
	schema: "./schema.ts",
	out: "./migrations",
	dbCredentials: { url },
});
