/**
 * Electrobun postWrap hook: gives the macOS app an identity of its own, which
 * Local Network privacy needs to remember the person's choice (Apple's TN3179).
 *
 * - Electrobun's prebuilt launcher has the same Mach-O UUID in every
 *   Electrobun app, so this stamps one derived from the app identifier. It's
 *   the same for every channel: macOS remembers one UUID per bundle
 *   identifier, and the channels share one, so a dev build beside an
 *   installed release would otherwise knock the release's access out.
 * - Adds the NSLocalNetworkUsageDescription the Local Network alert shows.
 * - Re-signs the bundle as school.shoal.desktop instead of "launcher", with
 *   the "Shoal Dev" identity when this Mac has one (see
 *   scripts/dev-signing-identity.ts) and ad hoc otherwise.
 *
 * Hutch runs hooks with Cottontail and skips them for dev builds, so this
 * sticks to node: APIs and runs at import; scripts/dev.ts applies it to dev
 * builds.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEV_SIGNING_IDENTITY = "Shoal Dev";
const LOCAL_NETWORK_USAGE = "Shoal connects to your Shoal server, which may be on your local network.";

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const LC_UUID = 0x1b;

export const hasDevSigningIdentity = () => {
	try {
		execFileSync("security", ["find-certificate", "-c", DEV_SIGNING_IDENTITY], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

/** A version 4 style UUID that's the same on every build of this app. */
const stableUuid = (seed: string) => {
	const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	return bytes;
};

/** Overwrites LC_UUID in each 64-bit slice of a Mach-O file; returns how many it changed. */
const stampUuid = (file: string, uuid: Uint8Array) => {
	const data = readFileSync(file);
	const slices =
		data.readUInt32BE(0) === FAT_MAGIC
			? Array.from({ length: data.readUInt32BE(4) }, (_, i) => data.readUInt32BE(8 + i * 20 + 8))
			: [0];
	let stamped = 0;
	for (const offset of slices) {
		if (data.readUInt32LE(offset) !== MH_MAGIC_64) continue;
		const commands = data.readUInt32LE(offset + 16);
		let command = offset + 32;
		for (let i = 0; i < commands; i++) {
			const size = data.readUInt32LE(command + 4);
			if (data.readUInt32LE(command) === LC_UUID) {
				data.set(uuid, command + 8);
				stamped++;
			}
			command += size;
		}
	}
	writeFileSync(file, data);
	return stamped;
};

/** Stamps the UUID, adds the usage description and re-signs. */
export const applyMacIdentity = (bundle: string, identifier: string) => {
	const plist = path.join(bundle, "Contents", "Info.plist");
	const executable = execFileSync("plutil", ["-extract", "CFBundleExecutable", "raw", plist], { encoding: "utf8" }).trim();
	if (stampUuid(path.join(bundle, "Contents", "MacOS", executable), stableUuid(identifier)) === 0) {
		throw new Error(`No LC_UUID in ${executable}; Local Network privacy can't tell this app apart.`);
	}
	execFileSync("plutil", ["-replace", "NSLocalNetworkUsageDescription", "-string", LOCAL_NETWORK_USAGE, plist]);
	const identity = hasDevSigningIdentity() ? DEV_SIGNING_IDENTITY : "-";
	// Nested code in Contents/MacOS is untouched and keeps Electrobun's signatures.
	execFileSync("codesign", ["--force", "--sign", identity, "--identifier", identifier, bundle], { stdio: "ignore" });
	console.log(`[mac-identity] ${path.basename(bundle)}: unique UUID, Local Network description, signed ${identity === "-" ? "ad hoc" : `as "${identity}"`}`);
};

const bundle = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
const identifier = process.env.ELECTROBUN_APP_IDENTIFIER;
if (process.env.ELECTROBUN_OS === "macos" && bundle && identifier) {
	applyMacIdentity(bundle, identifier);
}
