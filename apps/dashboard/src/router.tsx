import { QueryClient } from "@tanstack/react-query";
import {
	createRouter as createTanStackRouter,
	Link,
} from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

function NotFound() {
	return (
		<div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
			<h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
			<p className="text-sm text-muted-foreground">
				The page you're looking for doesn't exist.
			</p>
			<Link
				to="/"
				className="text-sm font-medium text-primary underline-offset-4 hover:underline"
			>
				Go home
			</Link>
		</div>
	);
}

export function createRouter() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { staleTime: 30_000 },
		},
	});

	const router = createTanStackRouter({
		routeTree,
		context: { queryClient },
		scrollRestoration: true,
		defaultPreload: "intent",
		// Match the default query staleTime so intent-preload reuses the cache
		// instead of refetching on every hover.
		defaultPreloadStaleTime: 30_000,
		defaultNotFoundComponent: NotFound,
	});

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createRouter>;
	}
}
