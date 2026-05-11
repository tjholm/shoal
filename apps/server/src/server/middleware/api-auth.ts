import { requireApiKey, UnauthorizedError } from "@shoal/server-core/auth";
import { createMiddleware } from "@tanstack/react-start";

/**
 * Authenticates `/api/v1/*` requests via Bearer / x-api-key / session cookie
 * and exposes the verified identity on `context.auth`. Translates
 * `UnauthorizedError` into the canonical OpenAI/Anthropic-style JSON 401 so
 * the auth module itself stays transport-agnostic.
 */
export const apiAuthMiddleware = createMiddleware({ type: "request" }).server(
	async ({ request, next }) => {
		try {
			const auth = await requireApiKey(request);
			return next({ context: { auth } });
		} catch (err) {
			if (err instanceof UnauthorizedError) {
				return Response.json(
					{ error: { message: err.message, type: "auth_error", code: 401 } },
					{ status: 401 },
				);
			}
			throw err;
		}
	},
);
