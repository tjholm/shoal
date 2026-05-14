import { handleImageGenerations } from "@shoal/server-core/openai";
import { createFileRoute } from "@tanstack/react-router";
import { apiAuthMiddleware } from "../../../server/middleware/api-auth";

export const Route = createFileRoute("/api/v1/images/generations")({
	server: {
		middleware: [apiAuthMiddleware],
		handlers: {
			POST: async ({ request, context }) =>
				handleImageGenerations(request, context.auth),
		},
	},
});
