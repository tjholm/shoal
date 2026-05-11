import { queryOptions } from "@tanstack/react-query";
import { listApiKeys } from "../server/functions/api-keys";
import { getServerConfig } from "../server/functions/config";
import { listInvitations } from "../server/functions/invitations";
import { listMembers } from "../server/functions/members";
import { getAuthContext } from "../server/functions/session";
import {
	getDashboardAggregates,
	getOrgUsageByModel,
	getUsageDaily,
	getWorkerCountsSnapshot,
	getWorkerLeaderboard,
} from "../server/functions/usage";
import {
	getWorkerDetail,
	getWorkerRecentEvents,
	getWorkerUsageByModel,
	getWorkerUsageDaily,
} from "../server/functions/workers";

/**
 * Shared queryOptions factories. Loaders use these via
 * `queryClient.ensureQueryData(opts())` to seed the cache during SSR/navigation;
 * components use the same factory via `useSuspenseQuery(opts())` to read the
 * value. Centralizing the queryKey/queryFn pair prevents drift between the two
 * sides.
 */

/**
 * Cached auth context (user + orgs + active org). Consumed by `_authed`'s
 * `beforeLoad` via `ensureQueryData` so hover-preloads of sidebar links don't
 * each fire a fresh server call. Invalidate on org switch / sign-in to force
 * a refetch — see `OrgSwitcher`.
 */
export const authContextQuery = () =>
	queryOptions({
		queryKey: ["auth", "context"] as const,
		queryFn: () => getAuthContext(),
		staleTime: 30_000,
	});

export const serverConfigQuery = () =>
	queryOptions({
		queryKey: ["server-config"] as const,
		queryFn: () => getServerConfig(),
		// Config doesn't change within a session.
		staleTime: Infinity,
	});

export const dashboardAggregatesQuery = () =>
	queryOptions({
		queryKey: ["dashboard", "aggregates"] as const,
		queryFn: () => getDashboardAggregates(),
		staleTime: 30_000,
	});

export const workerCountsSnapshotQuery = () =>
	queryOptions({
		queryKey: ["workers", "counts-snapshot"] as const,
		queryFn: () => getWorkerCountsSnapshot(),
		// Only consumed by the SSR fallback before `workersCollection` hydrates;
		// the live collection is the source of truth on the client. Never refetch.
		staleTime: Infinity,
	});

export const usageDailyQuery = (days: number) =>
	queryOptions({
		queryKey: ["usage", "daily", days] as const,
		queryFn: () => getUsageDaily({ data: { days } }),
		staleTime: 30_000,
	});

export const orgUsageByModelQuery = () =>
	queryOptions({
		queryKey: ["usage", "byModel"] as const,
		queryFn: () => getOrgUsageByModel(),
		staleTime: 30_000,
	});

export const workerLeaderboardQuery = (limit: number) =>
	queryOptions({
		queryKey: ["workers", "leaderboard", limit] as const,
		queryFn: () => getWorkerLeaderboard({ data: { limit } }),
		staleTime: 30_000,
	});

export const workerDetailQuery = (workerId: string) =>
	queryOptions({
		queryKey: ["worker", workerId, "detail"] as const,
		queryFn: () => getWorkerDetail({ data: { workerId } }),
		staleTime: 15_000,
	});

export const workerUsageDailyQuery = (workerId: string, days: number) =>
	queryOptions({
		queryKey: ["worker", workerId, "usage", "daily", days] as const,
		queryFn: () => getWorkerUsageDaily({ data: { workerId, days } }),
		staleTime: 30_000,
	});

export const workerUsageByModelQuery = (workerId: string) =>
	queryOptions({
		queryKey: ["worker", workerId, "usage", "byModel"] as const,
		queryFn: () => getWorkerUsageByModel({ data: { workerId } }),
		staleTime: 30_000,
	});

export const workerRecentEventsQuery = (workerId: string, limit: number) =>
	queryOptions({
		queryKey: ["worker", workerId, "events", limit] as const,
		queryFn: () => getWorkerRecentEvents({ data: { workerId, limit } }),
		staleTime: 15_000,
	});

export const membersQuery = () =>
	queryOptions({
		queryKey: ["members"] as const,
		queryFn: () => listMembers(),
		staleTime: 30_000,
	});

export const invitationsQuery = () =>
	queryOptions({
		queryKey: ["invitations"] as const,
		queryFn: () => listInvitations(),
		staleTime: 30_000,
	});

export const apiKeysQuery = () =>
	queryOptions({
		queryKey: ["api-keys"] as const,
		queryFn: () => listApiKeys(),
		staleTime: 30_000,
	});
