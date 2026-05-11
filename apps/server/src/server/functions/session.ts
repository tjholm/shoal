import { auth } from "@shoal/db/auth";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

function reqHeaders() {
	return new Headers(getRequestHeaders() as unknown as Record<string, string>);
}

export const getSession = createServerFn({ method: "GET" }).handler(
	async () => {
		return auth.api.getSession({ headers: reqHeaders() });
	},
);

/**
 * Returns the session along with the user's organizations and the
 * currently active org. Used by the authed layout.
 */
export const getAuthContext = createServerFn({ method: "GET" }).handler(
	async () => {
		const headers = reqHeaders();
		const session = await auth.api.getSession({ headers });
		if (!session) return null;

		const orgs = await auth.api.listOrganizations({ headers });
		const activeOrgId = session.session.activeOrganizationId;
		const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? orgs[0] ?? null;

		return {
			user: session.user,
			orgs,
			activeOrg,
		};
	},
);
