import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { v4 as uuidv4 } from "uuid";
import { createRouter } from "./router";
import "./styles.css";

// Browsers only provide crypto.randomUUID over HTTPS or on localhost, and
// TanStack DB calls it for every collection mutation, so over plain http
// renaming a worker threw. uuid's v4 falls back to getRandomValues.
if (typeof crypto.randomUUID !== "function") {
	crypto.randomUUID = (() => uuidv4({})) as Crypto["randomUUID"];
}

const router = createRouter();

const root = document.getElementById("app");
if (!root) throw new Error("index.html is missing the #app element");

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={router.options.context.queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
);
