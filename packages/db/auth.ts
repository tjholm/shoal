import { apiKey } from "@better-auth/api-key";
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
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { and, eq, gt } from "drizzle-orm";
import { sendEmail } from "./email.ts";
import { db, schema } from "./index.ts";

const APP_URL = process.env.SHOAL_APP_URL ?? "https://web.shoal.localhost";
const SERVER_URL = process.env.SHOAL_SERVER_URL ?? "https://server.shoal.localhost";
const ALLOW_OPEN_SIGNUP = process.env.SHOAL_ALLOW_SIGNUP === "true";

/**
 * Whether the public /sign-up endpoint should accept new registrations right now.
 * Open if SHOAL_ALLOW_SIGNUP=true, or if no user has been created yet
 * (first-user-wins bootstrap). Invitations are unaffected — they create users
 * through a different code path.
 */
export async function isSignupAllowed(): Promise<boolean> {
  if (ALLOW_OPEN_SIGNUP) return true;
  const rows = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  return rows.length === 0;
}

async function hasPendingInvitation(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.email, email.toLowerCase()),
        eq(schema.invitation.status, "pending"),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// The default org access-control statements omit `apiKey`, so better-auth's
// api-key plugin denies non-owner roles. Extend the statements with apiKey
// actions and grant them to both admin and owner — members stay read-less.
const apiKeyActions = ["create", "read", "update", "delete"] as const;
const ac = createAccessControl({
  ...defaultStatements,
  apiKey: apiKeyActions,
});
const roles = {
  owner: ac.newRole({ ...ownerAc.statements, apiKey: apiKeyActions }),
  admin: ac.newRole({ ...adminAc.statements, apiKey: apiKeyActions }),
  member: ac.newRole({ ...memberAc.statements }),
};

export const auth = betterAuth({
  baseURL: SERVER_URL,
  trustedOrigins: [APP_URL],
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Gate only the public email/password signup. Invitation-accept and
      // social/oauth flows take different paths and aren't affected.
      if (ctx.path !== "/sign-up/email") return;
      if (await isSignupAllowed()) return;
      const email = (ctx.body as { email?: string } | undefined)?.email;
      if (email && (await hasPendingInvitation(email))) return;
      throw new APIError("FORBIDDEN", {
        message: "Signups are closed. Ask an admin for an invitation.",
      });
    }),
  },
  plugins: [
    organization({
      ac,
      roles,
      async sendInvitationEmail({ id, email, role, organization, inviter }) {
        const url = `${APP_URL}/accept-invitation/${id}`;
        await sendEmail({
          to: email,
          subject: `You're invited to ${organization.name} on Shoal`,
          text: [
            `${inviter.user.name} (${inviter.user.email}) invited you to join`,
            `the "${organization.name}" organization on Shoal as ${role}.`,
            "",
            `Accept here: ${url}`,
          ].join("\n"),
        });
      },
    }),
    apiKey({
      // API keys are scoped to organizations, not individual users
      references: "organization",
      enableMetadata: true,
      defaultPrefix: "sk_",
      // Long-lived tokens by default — workers and clients run for weeks
      keyExpiration: {
        defaultExpiresIn: null,
      },
      // Worker tokens reconnect on every dev restart / network blip; the
      // default 10/day per-key cap will lock workers out within minutes.
      // These keys are server-side credentials, not user-input rate targets.
      rateLimit: {
        enabled: false,
      },
    }),
    tanstackStartCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
