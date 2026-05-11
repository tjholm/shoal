import { handleMessages } from "@shoal/server-core/anthropic";
import { createFileRoute } from "@tanstack/react-router";
import { apiAuthMiddleware } from "../../../server/middleware/api-auth";

export const Route = createFileRoute("/api/v1/messages")({
	server: {
		middleware: [apiAuthMiddleware],
		handlers: {
			POST: async ({ request, context }) =>
				handleMessages(request, context.auth),
		},
	},
});
