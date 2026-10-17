import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { useCollections } from "../lib/collections";
import { membersQuery } from "../lib/queries";
import { KeyIcon, MembersIcon, ModelsIcon, OverviewIcon } from "./icons";
import { ShoalGlyph } from "@shoal/ui/components/ShoalMark";

export interface NavItem {
	title: string;
	url: "/" | "/workers" | "/models" | "/members" | "/api-keys";
	icon: (props: { active: boolean }) => React.ReactNode;
}

export const navItems: NavItem[] = [
	{ title: "Overview", url: "/", icon: () => <OverviewIcon /> },
	{
		title: "Workers",
		url: "/workers",
		icon: ({ active }) => <ShoalGlyph size={16} lit={active} />,
	},
	{ title: "Models", url: "/models", icon: () => <ModelsIcon /> },
	{ title: "Members", url: "/members", icon: () => <MembersIcon /> },
	{ title: "API keys", url: "/api-keys", icon: () => <KeyIcon /> },
];

export function isNavItemActive(item: NavItem, pathname: string): boolean {
	return item.url === "/" ? pathname === "/" : pathname.startsWith(item.url);
}

export function AppSidebar() {
	const { location } = useRouterState();
	const { workers: workersCollection } = useCollections();
	const { data: workers } = useLiveQuery((q) => q.from({ worker: workersCollection }), [
		workersCollection,
	]);
	const { data: members } = useQuery(membersQuery());
	const list = workers ?? [];
	const online = list.filter((w) => w.online).length;
	const counts: Partial<Record<NavItem["url"], string>> = {
		"/workers": list.length > 0 ? `${online}/${list.length}` : "0",
		...(members ? { "/members": String(members.length) } : {}),
	};

	return (
		<nav
			aria-label="Main"
			className="hidden w-[220px] shrink-0 flex-col gap-0.5 border-r border-line px-2.5 py-4 md:flex"
		>
			{navItems.map((item) => {
				const active = isNavItemActive(item, location.pathname);
				return (
					<Link
						key={item.url}
						to={item.url}
						aria-current={active ? "page" : undefined}
						className={`flex h-[34px] items-center gap-2.5 rounded-sm border px-2.5 text-sm ${
							active
								? "border-line bg-reef text-foam"
								: "border-transparent text-mist hover:bg-reef/60 hover:text-foam"
						}`}
					>
						{item.icon({ active })}
						{item.title}
						{counts[item.url] && (
							<span
								className={`ml-auto font-mono text-[11px] tabular-nums ${active ? "text-mist" : "text-silt"}`}
							>
								{counts[item.url]}
							</span>
						)}
					</Link>
				);
			})}
			<div className="min-h-6 grow" />
			<div className="mx-1 mt-2 flex flex-col gap-1.5 rounded-sm border border-line p-3 font-mono text-[11px]">
				<span className="flex items-center gap-1.5 text-lumen">
					<span aria-hidden="true" className="live-pulse size-1.5 rounded-full bg-lumen" />
					router healthy
				</span>
				<span className="text-silt">
					ws · {online} {online === 1 ? "socket" : "sockets"} open
				</span>
			</div>
		</nav>
	);
}
