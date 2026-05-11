import { handleChatCompletions } from "@shoal/server-core/openai";
import { createFileRoute } from "@tanstack/react-router";
import { apiAuthMiddleware } from "../../../server/middleware/api-auth";

export const Route = createFileRoute("/api/v1/chat/completions")({
	server: {
		middleware: [apiAuthMiddleware],
		handlers: {
			POST: async ({ request, context }) =>
				handleChatCompletions(request, context.auth),
		},
	},
});
