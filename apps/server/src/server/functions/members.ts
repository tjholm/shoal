import { auth } from "@shoal/db/auth";
import { createServerFn } from "@tanstack/react-start";
import { orgMiddleware } from "../middleware/org";

export const listMembers = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const result = await auth.api.listMembers({
			headers: context.headers,
			query: { organizationId: context.orgId },
		});
		return result.members ?? [];
	});

export const removeMember = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.inputValidator((data: { memberIdOrEmail: string }) => data)
	.handler(async ({ data, context }) => {
		return auth.api.removeMember({
			headers: context.headers,
			body: {
				memberIdOrEmail: data.memberIdOrEmail,
				organizationId: context.orgId,
			},
		});
	});

export const updateMemberRole = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.inputValidator(
		(data: { memberId: string; role: "admin" | "member" }) => data,
	)
	.handler(async ({ data, context }) => {
		return auth.api.updateMemberRole({
			headers: context.headers,
			body: {
				memberId: data.memberId,
				role: data.role,
				organizationId: context.orgId,
			},
		});
	});
