import { handleEmbeddings } from "@shoal/server-core/openai";
import { createFileRoute } from "@tanstack/react-router";
import { apiAuthMiddleware } from "../../../server/middleware/api-auth";

export const Route = createFileRoute("/api/v1/embeddings")({
	server: {
		middleware: [apiAuthMiddleware],
		handlers: {
			POST: async ({ request, context }) =>
				handleEmbeddings(request, context.auth),
		},
	},
});
