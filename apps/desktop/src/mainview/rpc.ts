import { Electroview } from "electrobun/view";
import type { ShoalRPC, Tab, WorkerState } from "../shared/rpc";

const stateListeners = new Set<(state: WorkerState) => void>();
const tabListeners = new Set<(tab: Tab) => void>();

export const rpc = Electroview.defineRPC<ShoalRPC>({
	handlers: {
		messages: {
			stateChanged: (state) => {
				for (const listener of stateListeners) listener(state);
			},
			showTab: (tab) => {
				for (const listener of tabListeners) listener(tab);
			},
		},
	},
});
new Electroview({ rpc });

export const onStateChanged = (listener: (state: WorkerState) => void) => {
	stateListeners.add(listener);
	return () => {
		stateListeners.delete(listener);
	};
};

/** The tray asked the window to switch tabs, e.g. "Settings…". */
export const onShowTab = (listener: (tab: Tab) => void) => {
	tabListeners.add(listener);
	return () => {
		tabListeners.delete(listener);
	};
};
