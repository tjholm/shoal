import { queryOptions, useQuery } from "@tanstack/react-query";
import { authClient, unwrap } from "./auth-client";

/** Whether the signed-in member may create API keys in the active org, per
 *  the access control the API enforces (owners and admins). */
export const canCreateKeysQuery = () =>
	queryOptions({
		queryKey: ["auth", "can", "apiKey:create"] as const,
		queryFn: async () =>
			(
				await unwrap(
					authClient.organization.hasPermission({
						// The API extends better-auth's default statements with apiKey
						// actions; the client's types only know the defaults.
						permissions: { apiKey: ["create"] } as Record<string, string[]>,
					}),
				)
			)?.success ?? false,
		staleTime: 60_000,
	});

export function useCanCreateKeys(): boolean {
	return useQuery(canCreateKeysQuery()).data ?? false;
}
