import type { UsageRange } from "@shoal/contracts";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { Effect } from "effect";
import { api } from "./api";
import {
	AuthRequestError,
	activeOrganizationId,
	authClient,
	unwrap,
} from "./auth-client";

/**
 * Shared queryOptions factories. Loaders seed the cache with
 * `queryClient.ensureQueryData(opts())`; components read it with
 * `useSuspenseQuery(opts())`. Centralizing the queryKey/queryFn pair prevents
 * drift between the two sides.
 */

/**
 * The signed-in user, their organizations and the active one, or null when
 * signed out. Consumed by `_authed`'s `beforeLoad`, so hover-preloads of
 * sidebar links don't each refetch. `ensureQueryData` serves it even when
 * stale, so clear the cache on sign-in and sign-out.
 */
export const authContextQuery = () =>
	queryOptions({
		queryKey: ["auth", "context"] as const,
		queryFn: async () => {
			const session = await unwrap(authClient.getSession());
			if (!session) return null;
			const orgs = (await unwrap(authClient.organization.list())) ?? [];
			const activeOrg =
				orgs.find((o) => o.id === session.session.activeOrganizationId) ??
				orgs[0] ??
				null;
			return { user: session.user, orgs, activeOrg };
		},
		staleTime: 30_000,
	});

export const sessionQuery = () =>
	queryOptions({
		queryKey: ["auth", "session"] as const,
		queryFn: () => unwrap(authClient.getSession()),
		staleTime: 30_000,
	});

export const serverConfigQuery = () =>
	queryOptions({
		queryKey: ["server-config"] as const,
		queryFn: () => api((c) => c.public.config()),
		staleTime: 30_000,
	});

export const invitationQuery = (invitationId: string) =>
	queryOptions({
		queryKey: ["invitation", invitationId] as const,
		queryFn: () => api((c) => c.public.invitation({ params: { invitationId } })),
	});

export const recentEventsQuery = (limit: number) =>
	queryOptions({
		queryKey: ["usage", "events", limit] as const,
		queryFn: () => api((c) => c.usage.recentEvents({ query: { limit } })),
		staleTime: 15_000,
	});

/** Jobs and tokens per model, over `range` or the whole retention window. */
export const modelUsageQuery = (range?: UsageRange) =>
	queryOptions({
		queryKey: ["usage", "byModel", range ?? "all"] as const,
		queryFn: () => api((c) => c.usage.byModel({ query: { range } })),
		staleTime: 30_000,
	});

export const usageSummaryQuery = (range: UsageRange) =>
	queryOptions({
		queryKey: ["usage", "summary", range] as const,
		queryFn: () => api((c) => c.usage.summary({ query: { range } })),
		staleTime: 30_000,
		// Keep the last range on screen while a new one loads.
		placeholderData: keepPreviousData,
	});

/** Per-model and per-worker request stats for the Models page. */
export const modelStatsQuery = (range: UsageRange) =>
	queryOptions({
		queryKey: ["usage", "modelStats", range] as const,
		queryFn: () => api((c) => c.usage.modelStats({ query: { range } })),
		staleTime: 30_000,
		placeholderData: keepPreviousData,
	});

/** Each worker's daily usage, for sparklines on the Workers page. */
export const workerSeriesQuery = (days: number) =>
	queryOptions({
		queryKey: ["usage", "workerSeries", days] as const,
		queryFn: () => api((c) => c.usage.workerSeries({ query: { days } })),
		staleTime: 60_000,
	});

/** A worker's detail, or null when it doesn't exist in this org. */
export const workerDetailQuery = (workerId: string) =>
	queryOptions({
		queryKey: ["worker", workerId, "detail"] as const,
		queryFn: () =>
			api((c) =>
				c.workers.detail({ params: { workerId } }).pipe(
					Effect.catchTag("WorkerNotFound", () => Effect.succeed(null)),
				),
			),
		staleTime: 15_000,
	});

export const workerUsageDailyQuery = (workerId: string, days: number) =>
	queryOptions({
		queryKey: ["worker", workerId, "usage", "daily", days] as const,
		queryFn: () =>
			api((c) => c.workers.usageDaily({ params: { workerId }, query: { days } })),
		staleTime: 30_000,
	});

export const workerUsageByModelQuery = (workerId: string) =>
	queryOptions({
		queryKey: ["worker", workerId, "usage", "byModel"] as const,
		queryFn: () => api((c) => c.workers.usageByModel({ params: { workerId } })),
		staleTime: 30_000,
	});

export const workerRecentEventsQuery = (workerId: string, limit: number) =>
	queryOptions({
		queryKey: ["worker", workerId, "events", limit] as const,
		queryFn: () =>
			api((c) => c.workers.recentEvents({ params: { workerId }, query: { limit } })),
		staleTime: 15_000,
	});

export const membersQuery = () =>
	queryOptions({
		queryKey: ["members"] as const,
		queryFn: async () =>
			(await unwrap(authClient.organization.listMembers()))?.members ?? [],
		staleTime: 30_000,
	});

export const invitationsQuery = () =>
	queryOptions({
		queryKey: ["invitations"] as const,
		queryFn: async () =>
			(await unwrap(authClient.organization.listInvitations())) ?? [],
		staleTime: 30_000,
	});

/** The org's API keys, or `permitted: false` for members whose role has no
 *  apiKey permissions (better-auth answers them with 403). */
export const apiKeysQuery = () =>
	queryOptions({
		queryKey: ["api-keys"] as const,
		queryFn: async () => {
			const organizationId = await activeOrganizationId();
			try {
				const result = await unwrap(
					authClient.apiKey.list({ query: { organizationId } }),
				);
				return { permitted: true as const, keys: result?.apiKeys ?? [] };
			} catch (err) {
				if (err instanceof AuthRequestError && err.status === 403) {
					return { permitted: false as const };
				}
				throw err;
			}
		},
		staleTime: 30_000,
	});
