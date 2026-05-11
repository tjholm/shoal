import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WorkerIdentity {
  workerId: string;
  secret: string;
}

/**
 * Identity is keyed by a hash of the server URL so a single host can connect
 * to multiple Shoal servers (prod / staging / homelab) without collision.
 */
function identityPath(serverUrl: string): string {
  const stateRoot =
    process.env.XDG_STATE_HOME ??
    path.join(os.homedir(), ".local", "state");
  const dir = path.join(stateRoot, "shoal");
  const tag = crypto
    .createHash("sha256")
    .update(serverUrl)
    .digest("hex")
    .slice(0, 16);
  return path.join(dir, `identity-${tag}.json`);
}

export function loadIdentity(serverUrl: string): WorkerIdentity | null {
  const file = identityPath(serverUrl);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkerIdentity>;
    if (typeof parsed.workerId !== "string" || typeof parsed.secret !== "string") {
      throw new Error("malformed identity file");
    }
    return { workerId: parsed.workerId, secret: parsed.secret };
  } catch (err) {
    throw new Error(
      `Failed to read worker identity at ${file}: ${(err as Error).message}. ` +
        `Delete the file to re-register as a new worker.`,
    );
  }
}

export function saveIdentity(serverUrl: string, identity: WorkerIdentity): void {
  const file = identityPath(serverUrl);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
}

/** Returns the path that would be used, for log messages and docs. */
export function identityFilePath(serverUrl: string): string {
  return identityPath(serverUrl);
}
