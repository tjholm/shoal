import { auth } from "@shoal/db/auth";
import { createServerFn } from "@tanstack/react-start";
import { orgMiddleware } from "../middleware/org";

type ApiKeyListResult =
	| {
			permitted: true;
			keys: Awaited<ReturnType<typeof auth.api.listApiKeys>>["apiKeys"];
	  }
	| { permitted: false };

export const listApiKeys = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }): Promise<ApiKeyListResult> => {
		try {
			const result = await auth.api.listApiKeys({
				headers: context.headers,
				query: { organizationId: context.orgId },
			});
			return { permitted: true, keys: result.apiKeys ?? [] };
		} catch (err) {
			// better-auth's api-key plugin throws FORBIDDEN for members without
			// apiKey permissions — render a friendly state instead of crashing.
			if ((err as { statusCode?: number })?.statusCode === 403) {
				return { permitted: false };
			}
			throw err;
		}
	});

export const createApiKey = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.inputValidator((data: { name: string }) => data)
	.handler(async ({ data, context }) => {
		return auth.api.createApiKey({
			headers: context.headers,
			body: { name: data.name, organizationId: context.orgId },
		});
	});

export const deleteApiKey = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.inputValidator((data: { keyId: string }) => data)
	.handler(async ({ data, context }) => {
		return auth.api.deleteApiKey({
			headers: context.headers,
			body: { keyId: data.keyId },
		});
	});
