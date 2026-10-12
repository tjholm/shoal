import { DashboardApi } from "@shoal/contracts";
import { type Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

type Client = HttpApiClient.ForApi<typeof DashboardApi>;

const runtime = ManagedRuntime.make(Layer.mergeAll(FetchHttpClient.layer));
const client = runtime.runPromise(
	HttpApiClient.make(DashboardApi, { baseUrl: window.location.origin }),
);

/** Call the dashboard API. Rejects with the endpoint's typed error, which
 *  React Query surfaces as the query's error. */
export async function api<A, E>(call: (client: Client) => Effect.Effect<A, E>): Promise<A> {
	return runtime.runPromise(call(await client));
}
