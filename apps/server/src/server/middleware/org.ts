import { auth } from "@shoal/db/auth";
import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

/**
 * Resolves the active session and organization, then exposes
 * `{ orgId, headers }` to the server-fn handler via `context`. Throws if the
 * caller isn't authenticated or has no active org.
 */
export const orgMiddleware = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const headers = new Headers(
			getRequestHeaders() as unknown as Record<string, string>,
		);
		const session = await auth.api.getSession({ headers });
		if (!session) throw new Error("Not authenticated");
		const orgId = session.session.activeOrganizationId;
		if (!orgId) throw new Error("No active organization");
		return next({ context: { orgId, headers } });
	},
);
