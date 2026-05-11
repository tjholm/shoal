import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppSidebar } from "../components/AppSidebar";
import { MobileNav } from "../components/MobileNav";
import { OrgSwitcher } from "../components/OrgSwitcher";
import { UserMenu } from "../components/UserMenu";
import { Separator } from "../components/ui/separator";
import { SidebarInset, SidebarProvider } from "../components/ui/sidebar";
import { authContextQuery } from "../lib/queries";

export const Route = createFileRoute("/_authed")({
	// Auth context flows through react-query so hover-preload of sidebar links
	// doesn't re-fire the server call. Invalidate via
	// `queryClient.invalidateQueries(authContextQuery().queryKey)` whenever
	// server-side auth state changes (org switch, sign-in). Server functions
	// re-validate the session on every call via `orgMiddleware`, so a stale
	// cache here can only mislead the UI, never grant access.
	beforeLoad: async ({ context: { queryClient } }) => {
		const ctx = await queryClient.ensureQueryData(authContextQuery());
		if (!ctx) throw redirect({ to: "/sign-in" });
		return { auth: ctx };
	},
	loader: ({ context }) => context.auth,
	component: AuthedLayout,
});

function AuthedLayout() {
	const { user, orgs, activeOrg } = Route.useLoaderData();

	return (
		<div className="flex min-h-screen flex-col">
			<header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
				<div className="flex items-center gap-2">
					<span className="h-6 w-6 rounded-sm bg-[linear-gradient(135deg,#56c6be,#7ed3bf)]" />
					<span className="text-base font-semibold tracking-tight">Shoal</span>
				</div>
				<Separator orientation="vertical" className="mx-1 h-5" />
				<OrgSwitcher orgs={orgs} activeOrg={activeOrg} />
				<div className="ml-auto flex items-center gap-2">
					<UserMenu user={user} />
					<MobileNav />
				</div>
			</header>
			<SidebarProvider
				className="flex-1 !min-h-0"
				style={{ "--header-height": "3.5rem" } as React.CSSProperties}
			>
				<AppSidebar />
				<SidebarInset>
					<main className="flex-1">
						<Outlet />
					</main>
				</SidebarInset>
			</SidebarProvider>
		</div>
	);
}
