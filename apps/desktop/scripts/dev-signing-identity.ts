/**
 * Creates the self-signed "Shoal Dev" code signing identity in the login
 * keychain, for scripts/mac-identity.ts. Run once per Mac: `bun scripts/dev-signing-identity.ts`.
 *
 * Ad hoc signatures change on every rebuild, and macOS forgets the app's
 * Local Network access each time. A certificate signature stays the same.
 * Applies to local canary and stable builds; Hutch runs no hooks for dev builds.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { $ } from "bun";
import { DEV_SIGNING_IDENTITY, hasDevSigningIdentity } from "./mac-identity";

if (process.platform !== "darwin") throw new Error("Only macOS builds are signed this way.");
if (hasDevSigningIdentity()) {
	console.log(`"${DEV_SIGNING_IDENTITY}" is already in your keychain.`);
	process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), "shoal-dev-identity-"));
try {
	const key = path.join(dir, "key.pem");
	const cert = path.join(dir, "cert.pem");
	const bundle = path.join(dir, "identity.p12");
	// /usr/bin/openssl is LibreSSL, whose PKCS#12 files the keychain can import.
	await $`/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout ${key} -out ${cert} -subj ${`/CN=${DEV_SIGNING_IDENTITY}`} -addext keyUsage=critical,digitalSignature -addext extendedKeyUsage=critical,codeSigning`.quiet();
	await $`/usr/bin/openssl pkcs12 -export -inkey ${key} -in ${cert} -out ${bundle} -passout pass:shoal`.quiet();
	// -T lets codesign use the key without a keychain prompt on every build.
	await $`security import ${bundle} -P shoal -T /usr/bin/codesign`;
	console.log(`Added "${DEV_SIGNING_IDENTITY}" to your login keychain.`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
