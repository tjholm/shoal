import { Crypto, Effect } from "effect";
import { Base64Url } from "effect/encoding";

// Worker secrets are 32 random bytes, so a salted SHA-256 is already
// infeasible to brute-force; a deliberately slow password hash would only add
// latency to every reconnect.
const SECRET_BYTES = 32;
const SALT_BYTES = 16;

/** Worker secret generation and verification. Secrets are stored hashed, as
 *  `salt$hash`, so verification needs no separate salt column. */
export const makeSecrets = (crypto: Crypto.Crypto) => {
	// A platform without a working CSPRNG or SHA-256 can't run shoal at all,
	// so those failures are defects rather than errors callers could handle.
	const randomBytes = (length: number) =>
		crypto.randomBytes(length).pipe(Effect.orDie);

	const digest = (salt: Uint8Array, secret: string) => {
		const secretBytes = new TextEncoder().encode(secret);
		const combined = new Uint8Array(salt.length + secretBytes.length);
		combined.set(salt, 0);
		combined.set(secretBytes, salt.length);
		return crypto
			.digest("SHA-256", combined)
			.pipe(Effect.map(Base64Url.encode), Effect.orDie);
	};

	return {
		generate: randomBytes(SECRET_BYTES).pipe(Effect.map(Base64Url.encode)),

		hash: Effect.fnUntraced(function* (secret: string) {
			const salt = yield* randomBytes(SALT_BYTES);
			return `${Base64Url.encode(salt)}$${yield* digest(salt, secret)}`;
		}),

		verify: Effect.fnUntraced(function* (secret: string, stored: string) {
			const [saltText, expected] = stored.split("$");
			if (saltText === undefined || expected === undefined) return false;
			const salt = Base64Url.decode(saltText);
			if (salt._tag === "Failure") return false;
			return timingSafeEqual(yield* digest(salt.success, secret), expected);
		}),
	};
};

/** A random v4 UUID, for row and job ids. */
export const newId = (crypto: Crypto.Crypto) =>
	crypto.randomUUIDv4().pipe(Effect.orDie);

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
