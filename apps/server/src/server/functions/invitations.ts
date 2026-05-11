import { db, eq, schema } from "@shoal/db";
import { auth } from "@shoal/db/auth";
import { createServerFn } from "@tanstack/react-start";
import { orgMiddleware } from "../middleware/org";

export interface InvitationPublicInfo {
	status:
		| "pending"
		| "expired"
		| "accepted"
		| "rejected"
		| "canceled"
		| "not_found";
	email: string | null;
	organizationName: string | null;
	inviterName: string | null;
	inviterEmail: string | null;
	role: string | null;
}

/**
 * Public invitation lookup — no session required. Holding the invitation ID
 * (a UUID sent via email) is the auth. Used by the accept-invitation page to
 * show context to logged-out users before they sign in or up.
 */
export const getInvitationPublicInfo = createServerFn({ method: "GET" })
	.inputValidator((data: { invitationId: string }) => data)
	.handler(async ({ data }): Promise<InvitationPublicInfo> => {
		const rows = await db
			.select({
				status: schema.invitation.status,
				email: schema.invitation.email,
				role: schema.invitation.role,
				expiresAt: schema.invitation.expiresAt,
				organizationName: schema.organization.name,
				inviterName: schema.user.name,
				inviterEmail: schema.user.email,
			})
			.from(schema.invitation)
			.leftJoin(
				schema.organization,
				eq(schema.invitation.organizationId, schema.organization.id),
			)
			.leftJoin(schema.user, eq(schema.invitation.inviterId, schema.user.id))
			.where(eq(schema.invitation.id, data.invitationId))
			.limit(1);

		const row = rows[0];
		if (!row) {
			return {
				status: "not_found",
				email: null,
				organizationName: null,
				inviterName: null,
				inviterEmail: null,
				role: null,
			};
		}

		const status =
			row.status === "pending" && row.expiresAt < new Date()
				? "expired"
				: (row.status as InvitationPublicInfo["status"]);

		return {
			status,
			email: row.email,
			organizationName: row.organizationName,
			inviterName: row.inviterName,
			inviterEmail: row.inviterEmail,
			role: row.role,
		};
	});

export const listInvitations = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		return auth.api.listInvitations({
			headers: context.headers,
			query: { organizationId: context.orgId },
		});
	});

export const inviteMember = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.inputValidator((data: { email: string; role: "admin" | "member" }) => data)
	.handler(async ({ data, context }) => {
		return auth.api.createInvitation({
			headers: context.headers,
			body: {
				email: data.email,
				role: data.role,
				organizationId: context.orgId,
			},
		});
	});

export const cancelInvitation = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.inputValidator((data: { invitationId: string }) => data)
	.handler(async ({ data, context }) => {
		return auth.api.cancelInvitation({
			headers: context.headers,
			body: { invitationId: data.invitationId },
		});
	});
