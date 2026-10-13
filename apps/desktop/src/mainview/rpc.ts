import { Electroview } from "electrobun/view";
import type { Page, ShoalRPC, WorkerState } from "../shared/rpc";

const stateListeners = new Set<(state: WorkerState) => void>();
const pageListeners = new Set<(page: Page) => void>();

export const rpc = Electroview.defineRPC<ShoalRPC>({
	handlers: {
		messages: {
			stateChanged: (state) => {
				for (const listener of stateListeners) listener(state);
			},
			showPage: (page) => {
				for (const listener of pageListeners) listener(page);
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

/** The tray asked the window to show a page. */
export const onShowPage = (listener: (page: Page) => void) => {
	pageListeners.add(listener);
	return () => {
		pageListeners.delete(listener);
	};
};
