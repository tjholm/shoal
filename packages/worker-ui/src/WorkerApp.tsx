import { App } from "./App";
import { type HostConnection, HostProvider } from "./host";

/** The worker's whole UI, talking to its host over `host`. */
export function WorkerApp({ host }: { host: HostConnection }) {
	return (
		<HostProvider value={host}>
			<App />
		</HostProvider>
	);
}
