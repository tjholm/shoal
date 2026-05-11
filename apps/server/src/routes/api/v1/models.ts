import { handleModels } from "@shoal/server-core/openai";
import { createFileRoute } from "@tanstack/react-router";
import { apiAuthMiddleware } from "../../../server/middleware/api-auth";

export const Route = createFileRoute("/api/v1/models")({
	server: {
		middleware: [apiAuthMiddleware],
		handlers: {
			GET: async ({ context }) => handleModels(context.auth),
		},
	},
});
