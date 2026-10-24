/**
 * `bun run dev`: builds the app, runs it, and rebuilds and relaunches it when
 * the source changes. macOS needs its own runner (scripts/mac/dev.ts); the
 * other platforms use `electrobun dev --watch`.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

if (process.platform === "darwin") {
	await import("./mac/dev");
} else {
	const result = spawnSync(path.join("node_modules", ".bin", "electrobun"), ["dev", "--watch"], { stdio: "inherit" });
	process.exit(result.status ?? 1);
}
