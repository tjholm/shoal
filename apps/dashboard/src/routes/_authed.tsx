import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { AppSidebar } from "../components/AppSidebar";
import { ConnectAppDialog } from "../components/ConnectAppDialog";
import { ConnectWorkerDialog } from "../components/ConnectWorkerDialog";
import { CopyButton } from "../components/CopyButton";
import { MobileNav } from "../components/MobileNav";
import { OrgSwitcher } from "../components/OrgSwitcher";
import { ShoalWordmark } from "../components/ShoalMark";
import { UserMenu } from "../components/UserMenu";
import { useCanCreateKeys } from "../lib/permissions";
import { authContextQuery } from "../lib/queries";

export const Route = createFileRoute("/_authed")({
	// Auth context flows through react-query so hover-preload of sidebar links
	// doesn't re-fire the server call. Invalidate via
	// `queryClient.invalidateQueries(authContextQuery().queryKey)` whenever
	// server-side auth state changes (org switch, sign-in). The API
	// re-validates the session on every request, so a stale cache here can
	// only mislead the UI, never grant access.
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
	const canCreateKeys = useCanCreateKeys();

	return (
		<div className="flex min-h-screen flex-col">
			<header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2.5">
				<Link to="/" className="border-r border-line pr-3" aria-label="shoal overview">
					<ShoalWordmark />
				</Link>
				<OrgSwitcher orgs={orgs} activeOrg={activeOrg} />
				<BaseUrl />
				<div className="grow" />
				{canCreateKeys && (
					<>
						<ConnectAppDialog />
						<ConnectWorkerDialog />
					</>
				)}
				<UserMenu user={user} />
				<MobileNav />
			</header>
			<div className="flex grow">
				<AppSidebar />
				<div className="min-w-0 grow">
					<Outlet />
				</div>
			</div>
		</div>
	);
}

/** The OpenAI-compatible API URL clients point at, ready to copy. */
function BaseUrl() {
	const apiUrl = `${window.location.origin}/api/v1`;
	return (
		<div className="hidden h-8 min-w-0 items-center gap-2 rounded-sm border border-line bg-trench pr-1 pl-2.5 lg:flex">
			<span className="font-mono text-xs text-silt">api_url</span>
			<span className="truncate font-mono text-xs text-foam">{apiUrl}</span>
			<CopyButton value={apiUrl} label="Copy API URL" />
		</div>
	);
}
