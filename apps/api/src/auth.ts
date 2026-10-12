import { apiKey } from "@better-auth/api-key";
import { Database, type DatabaseError } from "@shoal/db/database";
import * as schema from "@shoal/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import {
	adminAc,
	defaultStatements,
	memberAc,
	ownerAc,
} from "better-auth/plugins/organization/access";
import { and, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { Pool } from "pg";
import { ShoalConfig } from "./config";
import { Email } from "./email";

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
	cause: Schema.Defect(),
}) {}

export class InvalidAuthConfig extends Schema.TaggedError<InvalidAuthConfig>()(
	"InvalidAuthConfig",
	{ message: Schema.String },
) {}

/** The organization and key a request authenticated as. `keyId` is null for
 *  dashboard sessions. */
export interface Principal {
	readonly organizationId: string;
	readonly keyId: string | null;
}

export interface SessionInfo {
	readonly userId: string;
	readonly activeOrganizationId: string | null;
}

/** better-auth, plus the lookups the rest of the server needs from it. */
export class Auth extends Context.Service<
	Auth,
	{
		/** Serve a better-auth endpoint under `/api/auth/*`. */
		handle(request: Request): Effect.Effect<Response, AuthError>;
		getSession(
			headers: Headers,
		): Effect.Effect<Option.Option<SessionInfo>, AuthError>;
		/** The principal for a raw API key, or None if it isn't valid. */
		verifyApiKey(key: string): Effect.Effect<Option.Option<Principal>, AuthError>;
		/** Whether the public sign-up form accepts new registrations right now:
		 *  open sign-up is enabled, or no user exists yet (first user wins).
		 *  Invitations are unaffected. */
		readonly isSignupAllowed: Effect.Effect<boolean, DatabaseError>;
	}
>()("@shoal/api/Auth") {
	static readonly layer = Layer.effect(
		Auth,
		Effect.gen(function* () {
			const database = yield* Database;
			const email = yield* Email;
			const config = yield* ShoalConfig;
			const secret = yield* signingSecret;
			const run = Effect.runPromiseWith(yield* Effect.context<never>());
			// better-auth's drizzle adapter only speaks promise-based drivers, so
			// it gets a small node-postgres pool of its own.
			const pool = yield* Effect.acquireRelease(
				Effect.map(
					Config.Redacted("DATABASE_URL"),
					(url) => new Pool({ connectionString: Redacted.value(url), max: AUTH_POOL_SIZE }),
				),
				(pool) => Effect.promise(() => pool.end()),
			);

			const isSignupAllowed = config.allowSignup
				? Effect.succeed(true)
				: database
						.query((db) =>
							db.select({ id: schema.user.id }).from(schema.user).limit(1),
						)
						.pipe(Effect.map((rows) => rows.length === 0));

			const hasPendingInvitation = (address: string) =>
				database
					.query((db) =>
						db
							.select({ id: schema.invitation.id })
							.from(schema.invitation)
							.where(
								and(
									eq(schema.invitation.email, address.toLowerCase()),
									eq(schema.invitation.status, "pending"),
									gt(schema.invitation.expiresAt, new Date()),
								),
							)
							.limit(1),
					)
					.pipe(Effect.map((rows) => rows.length > 0));

			const auth = makeBetterAuth({
				drizzle: drizzle({ client: pool }),
				secret,
				appUrl: config.appUrl,
				serverUrl: Option.getOrElse(
					config.serverUrl,
					() => "https://server.shoal.localhost",
				),
				signupGate: (address) =>
					run(
						Effect.gen(function* () {
							if (yield* isSignupAllowed) return true;
							return address !== undefined
								? yield* hasPendingInvitation(address)
								: false;
						}),
					),
				sendInvitation: ({ id, to, role, organizationName, inviter }) =>
					run(
						email.send({
							to,
							subject: `You're invited to ${organizationName} on Shoal`,
							text: [
								`${inviter.name} (${inviter.email}) invited you to join`,
								`the "${organizationName}" organization on Shoal as ${role}.`,
								"",
								`Accept here: ${config.appUrl}/accept-invitation/${id}`,
							].join("\n"),
						}),
					),
			});

			const attempt = <A>(f: () => Promise<A>) =>
				Effect.tryPromise({ try: f, catch: (cause) => new AuthError({ cause }) });

			return Auth.of({
				handle: (request) => attempt(() => auth.handler(request)),
				getSession: (headers) =>
					attempt(() => auth.api.getSession({ headers })).pipe(
						Effect.map((session) =>
							Option.fromNullishOr(session).pipe(
								Option.map((s) => ({
									userId: s.user.id,
									activeOrganizationId: s.session.activeOrganizationId ?? null,
								})),
							),
						),
					),
				verifyApiKey: (key) =>
					attempt(() => auth.api.verifyApiKey({ body: { key } })).pipe(
						Effect.map((result) =>
							result.valid && result.key
								? Option.some({
										organizationId: result.key.referenceId,
										keyId: result.key.id,
									})
								: Option.none(),
						),
					),
				isSignupAllowed,
			});
		}),
	);
}

const AUTH_POOL_SIZE = 5;

const MIN_SECRET_LENGTH = 32;

/** `BETTER_AUTH_SECRET`, which signs sessions. Without it better-auth would
 *  fall back to a default secret that anyone can read in its source. */
const signingSecret = Effect.gen(function* () {
	const secret = yield* Config.option(Config.Redacted("BETTER_AUTH_SECRET"));
	if (Option.isNone(secret) || Redacted.value(secret.value).trim().length < MIN_SECRET_LENGTH) {
		return yield* new InvalidAuthConfig({
			message: `BETTER_AUTH_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters. Generate one with \`openssl rand -base64 32\`.`,
		});
	}
	return secret.value;
});

// The default org access-control statements omit `apiKey`, so better-auth's
// api-key plugin denies non-owner roles. Extend the statements with apiKey
// actions and grant them to both admin and owner — members stay read-less.
const apiKeyActions = ["create", "read", "update", "delete"] as const;
const ac = createAccessControl({ ...defaultStatements, apiKey: apiKeyActions });
const roles = {
	owner: ac.newRole({ ...ownerAc.statements, apiKey: apiKeyActions }),
	admin: ac.newRole({ ...adminAc.statements, apiKey: apiKeyActions }),
	member: ac.newRole({ ...memberAc.statements }),
};

function makeBetterAuth(options: {
	drizzle: ReturnType<typeof drizzle>;
	secret: Redacted.Redacted;
	appUrl: string;
	serverUrl: string;
	signupGate: (email: string | undefined) => Promise<boolean>;
	sendInvitation: (invitation: {
		id: string;
		to: string;
		role: string;
		organizationName: string;
		inviter: { name: string; email: string };
	}) => Promise<void>;
}) {
	return betterAuth({
		secret: Redacted.value(options.secret),
		baseURL: options.serverUrl,
		trustedOrigins: [options.appUrl],
		database: drizzleAdapter(options.drizzle, {
			provider: "pg",
			schema: {
				user: schema.user,
				session: schema.session,
				account: schema.account,
				verification: schema.verification,
				organization: schema.organization,
				member: schema.member,
				invitation: schema.invitation,
				apikey: schema.apikey,
			},
		}),
		emailAndPassword: { enabled: true, autoSignIn: true },
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				// Gate only the public email/password signup. Invitation-accept and
				// social/oauth flows take different paths and aren't affected.
				if (ctx.path !== "/sign-up/email") return;
				const address = (ctx.body as { email?: string } | undefined)?.email;
				if (await options.signupGate(address)) return;
				throw new APIError("FORBIDDEN", {
					message: "Signups are closed. Ask an admin for an invitation.",
				});
			}),
		},
		plugins: [
			organization({
				ac,
				roles,
				sendInvitationEmail: ({ id, email, role, organization, inviter }) =>
					options.sendInvitation({
						id,
						to: email,
						role,
						organizationName: organization.name,
						inviter: inviter.user,
					}),
			}),
			apiKey({
				// API keys are scoped to organizations, not individual users.
				references: "organization",
				enableMetadata: true,
				defaultPrefix: "sk_",
				// Long-lived tokens by default — workers and clients run for weeks.
				keyExpiration: { defaultExpiresIn: null },
				// Worker tokens reconnect on every dev restart / network blip; the
				// default 10/day per-key cap would lock workers out within minutes.
				rateLimit: { enabled: false },
			}),
		],
	});
}
