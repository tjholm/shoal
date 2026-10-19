import { Electroview } from "electrobun/view";
import type { ShoalRPC, WorkerState } from "../shared/rpc";

const stateListeners = new Set<(state: WorkerState) => void>();

export const rpc = Electroview.defineRPC<ShoalRPC>({
	handlers: {
		messages: {
			stateChanged: (state) => {
				for (const listener of stateListeners) listener(state);
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

