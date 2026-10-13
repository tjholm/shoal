import { Segmented } from "@shoal/ui/components/Segmented";
import { ShoalWordmark } from "@shoal/ui/components/ShoalMark";
import { useEffect, useState } from "react";
import type { Tab, WorkerState } from "../shared/rpc";
import { onShowTab, onStateChanged, rpc } from "./rpc";
import { SettingsView } from "./SettingsView";
import { StatusView } from "./StatusView";

const TABS = [
	{ value: "status", label: "Status" },
	{ value: "settings", label: "Settings" },
] as const;

export function App() {
	const [state, setState] = useState<WorkerState | null>(null);
	const [tab, setTab] = useState<Tab>("status");

	useEffect(() => {
		const offState = onStateChanged(setState);
		const offTab = onShowTab(setTab);
		void rpc.request.getState().then(setState);
		void rpc.request.takeRequestedTab().then(setTab);
		return () => {
			offState();
			offTab();
		};
	}, []);

	if (state === null) return null;

	return (
		<div className="mx-auto flex min-h-screen max-w-2xl flex-col">
			<header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
				<ShoalWordmark />
				<Segmented label="View" value={tab} options={TABS} onChange={setTab} size="sm" />
			</header>
			{tab === "status" ? (
				<StatusView state={state} onSetUp={() => setTab("settings")} />
			) : (
				<SettingsView onSaved={() => setTab("status")} />
			)}
		</div>
	);
}
