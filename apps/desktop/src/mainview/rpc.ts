import type { HostConnection } from "@shoal/worker-ui";
import { Electroview } from "electrobun/view";
import type { ShoalRPC, WorkerState } from "../shared/rpc";

const stateListeners = new Set<(state: WorkerState) => void>();

const rpc = Electroview.defineRPC<ShoalRPC>({
	handlers: {
		messages: {
			stateChanged: (state) => {
				for (const listener of stateListeners) listener(state);
			},
		},
	},
});
new Electroview({ rpc });

/** The main process, over Electrobun's RPC. */
export const host: HostConnection = {
	request: rpc.request,
	onStateChanged: (listener) => {
		stateListeners.add(listener);
		return () => {
			stateListeners.delete(listener);
		};
	},
};
