import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createRouter } from "./router";
import "./styles.css";

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
