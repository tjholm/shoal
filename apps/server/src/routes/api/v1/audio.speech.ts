import { handleSpeech } from "@shoal/server-core/openai";
import { createFileRoute } from "@tanstack/react-router";
import { apiAuthMiddleware } from "../../../server/middleware/api-auth";

export const Route = createFileRoute("/api/v1/audio/speech")({
	server: {
		middleware: [apiAuthMiddleware],
		handlers: {
			POST: async ({ request, context }) =>
				handleSpeech(request, context.auth),
		},
	},
});
