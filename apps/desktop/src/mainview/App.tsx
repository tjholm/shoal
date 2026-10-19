import { ShoalGlyph } from "@shoal/ui/components/ShoalMark";
import { Activity as ActivityIcon, Box, LayoutGrid, Settings as SettingsIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { WorkerState } from "../shared/rpc";
import { Activity } from "./Activity";
import { Models } from "./Models";
import { Overview } from "./Overview";
import { onStateChanged, rpc } from "./rpc";
import { Settings } from "./Settings";
import { Setup } from "./Setup";
import { Dot, STATUS_WORD, statusTone } from "./ui";

type Page = "overview" | "models" | "activity" | "settings";

export function App() {
	const [state, setState] = useState<WorkerState | null>(null);
	const [page, setPage] = useState<Page>("overview");

	useEffect(() => {
		const offState = onStateChanged(setState);
		void rpc.request.getState().then(setState);
		return offState;
	}, []);

	if (state === null) return null;
	if (state.status === "not-configured") return <Setup />;

	const modelCount = new Set(state.backends.flatMap((b) => b.models.map((m) => m.id))).size;
	const nav = (target: Page, icon: ReactNode, label: string, count?: number) => (
		<button
			type="button"
			aria-current={page === target ? "page" : undefined}
			onClick={() => setPage(target)}
			className="flex h-8 items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[13px] text-mist hover:bg-reef hover:text-foam aria-[current=page]:bg-reef aria-[current=page]:text-foam"
		>
			{icon}
			{label}
			{count !== undefined && <span className="ml-auto font-mono text-[11px] text-silt">{count}</span>}
		</button>
	);

	return (
		<div className="flex h-screen bg-abyss text-foam">
			<nav aria-label="Sections" className="flex w-[210px] flex-none flex-col border-r border-line bg-trench px-3 py-3.5">
				<div className="flex items-center gap-2.5 px-2 pt-1 pb-[22px]">
					<span className="flex text-mist">
						<ShoalGlyph size={24} lit={state.status === "online"} />
					</span>
					<span className="font-mono text-[17px] font-medium tracking-[-0.03em]">shoal</span>
				</div>
				{nav("overview", <LayoutGrid size={16} aria-hidden="true" />, "Overview")}
				{nav("models", <Box size={16} aria-hidden="true" />, "Models", modelCount)}
				{nav("activity", <ActivityIcon size={16} aria-hidden="true" />, "Activity")}
				{nav("settings", <SettingsIcon size={16} aria-hidden="true" />, "Settings")}
				<div className="mt-auto flex flex-col gap-[3px] border-t border-line px-2.5 pt-3 pb-1">
					<div className="text-[13px] font-medium">{state.name || "This computer"}</div>
					<div className="flex items-center gap-1.5 text-[11px] text-silt">
						<Dot tone={statusTone(state.status)} />
						{STATUS_WORD[state.status]}
					</div>
				</div>
			</nav>
			<main className="flex min-w-0 flex-1 flex-col">
				{page === "overview" && <Overview state={state} onShowModels={() => setPage("models")} />}
				{page === "models" && <Models state={state} />}
				{page === "activity" && <Activity state={state} />}
				{page === "settings" && <Settings state={state} />}
			</main>
		</div>
	);
}
