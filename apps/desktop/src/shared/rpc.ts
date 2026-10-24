import type { HostRequests, WorkerState } from "@shoal/client-core/host/api";
import type { RPCSchema } from "electrobun";

export type * from "@shoal/client-core/host/api";

export type ShoalRPC = {
	bun: RPCSchema<{ requests: HostRequests }>;
	webview: RPCSchema<{
		messages: {
			stateChanged: WorkerState;
		};
	}>;
};
