import {
	ActiveOrganization,
	DashboardApi,
	SessionAuth,
	Unauthorized,
	WorkerNotFound,
} from "@shoal/contracts";
import { Database } from "@shoal/db/database";
import * as schema from "@shoal/db/schema";
import { and, eq } from "drizzle-orm";
import { Clock, Effect, Layer, Option } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Auth } from "../auth";
import { ShoalConfig } from "../config";
import { Usage } from "../usage";
import { WorkerRegistry } from "../workers/registry";
import { liveFields, snapshotWorkers } from "../workers/views";

/** Run `f` with the caller's active organization. */
const inOrg = <A, E, R>(f: (organizationId: string) => Effect.Effect<A, E, R>) =>
	Effect.flatMap(ActiveOrganization, ({ organizationId }) => f(organizationId));

const SessionAuthLive = Layer.effect(
	SessionAuth,
	Effect.gen(function* () {
		const auth = yield* Auth;
		return SessionAuth.of((httpEffect) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const session = yield* auth.getSession(new Headers(request.headers)).pipe(
					Effect.orDie,
				);
				if (Option.isNone(session)) {
					return yield* new Unauthorized({ message: "Not authenticated" });
				}
				const organizationId = session.value.activeOrganizationId;
				if (organizationId === null) {
					return yield* new Unauthorized({ message: "No active organization" });
				}
				return yield* Effect.provideService(httpEffect, ActiveOrganization, {
					organizationId,
				});
			}),
		);
	}),
);

/** The public URL workers connect to: `SHOAL_SERVER_URL` when set, else the
 *  host the dashboard was reached on. */
function workerSocketUrl(
	serverUrl: Option.Option<string>,
	headers: HttpServerRequest.HttpServerRequest["headers"],
): string {
	if (Option.isSome(serverUrl)) {
		return `${serverUrl.value.replace(/^http(s?):\/\//, "ws$1://").replace(/\/+$/, "")}/ws/workers`;
	}
	const forwardedHost = headers["x-forwarded-host"];
	if (forwardedHost) {
		const proto = headers["x-forwarded-proto"] === "https" ? "wss" : "ws";
		return `${proto}://${forwardedHost}/ws/workers`;
	}
	const host = headers.host ?? "localhost:3000";
	const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/.test(host);
	return `${isLocal ? "ws" : "wss"}://${host}/ws/workers`;
}

const PublicHandlers = HttpApiBuilder.group(
	DashboardApi,
	"public",
	Effect.fn(function* (handlers) {
		const config = yield* ShoalConfig;
		const auth = yield* Auth;
		const database = yield* Database;
		return handlers
			.handle("config", () =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					return {
						usageRetentionDays: config.usageRetentionDays,
						serverWsUrl: workerSocketUrl(config.serverUrl, request.headers),
						signupAllowed: yield* auth.isSignupAllowed.pipe(Effect.orDie),
					};
				}),
			)
			.handle("invitation", ({ params }) =>
				// Holding the invitation id (a UUID sent by email) is the
				// authorization, so this needs no session: the accept page shows it
				// before the invitee signs in.
				database
					.query((db) =>
						db
							.select({
								status: schema.invitation.status,
								email: schema.invitation.email,
								role: schema.invitation.role,
								expiresAt: schema.invitation.expiresAt,
								organizationName: schema.organization.name,
								inviterName: schema.user.name,
								inviterEmail: schema.user.email,
							})
							.from(schema.invitation)
							.leftJoin(
								schema.organization,
								eq(schema.invitation.organizationId, schema.organization.id),
							)
							.leftJoin(schema.user, eq(schema.invitation.inviterId, schema.user.id))
							.where(eq(schema.invitation.id, params.invitationId))
							.limit(1),
					)
					.pipe(
						Effect.orDie,
						Effect.map(([row]) => {
							if (!row) {
								return {
									status: "not_found" as const,
									email: null,
									organizationName: null,
									inviterName: null,
									inviterEmail: null,
									role: null,
								};
							}
							const { expiresAt, status, ...rest } = row;
							return {
								...rest,
								status:
									status === "pending" && expiresAt < new Date()
										? ("expired" as const)
										: (status as "pending" | "accepted" | "rejected" | "canceled"),
							};
						}),
					),
			);
	}),
);

const WorkersHandlers = HttpApiBuilder.group(
	DashboardApi,
	"workers",
	Effect.fn(function* (handlers) {
		const registry = yield* WorkerRegistry;
		const usage = yield* Usage;
		const database = yield* Database;
		const context = yield* Effect.context<WorkerRegistry | Usage>();
		return handlers
			.handle("list", () =>
				inOrg((organizationId) =>
					snapshotWorkers(organizationId)).pipe(
					Effect.provideContext(context),
					Effect.orDie,
				),
			)
			.handle("detail", ({ params: { workerId } }) =>
				Effect.gen(function* () {
					const { organizationId } = yield* ActiveOrganization;
					const [row] = yield* database
						.query((db) =>
							db
								.select({
									name: schema.worker.name,
									firstSeenAt: schema.worker.firstSeenAt,
									lastSeenAt: schema.worker.lastSeenAt,
									keyId: schema.worker.keyId,
									keyName: schema.apikey.name,
								})
								.from(schema.worker)
								.leftJoin(schema.apikey, eq(schema.worker.keyId, schema.apikey.id))
								.where(
									and(
										eq(schema.worker.id, workerId),
										eq(schema.worker.organizationId, organizationId),
									),
								)
								.limit(1),
						)
						.pipe(Effect.orDie);
					if (!row) return yield* new WorkerNotFound({ workerId });
					const totals = yield* usage
						.workerTotals({ organizationId, workerId })
						.pipe(Effect.orDie);
					const live = yield* registry.get(workerId);
					return {
						workerId,
						name: row.name,
						...liveFields(live, yield* Clock.currentTimeMillis),
						firstSeenAt: row.firstSeenAt.getTime(),
						lastSeenAt: row.lastSeenAt.getTime(),
						totalJobs: totals.jobs,
						totalPromptTokens: totals.promptTokens,
						totalCompletionTokens: totals.completionTokens,
						avgDurationMs: totals.avgDurationMs,
						keyId: row.keyId,
						keyName: row.keyName,
					};
				}),
			)
			.handle("rename", ({ params: { workerId }, payload }) =>
				inOrg((organizationId) =>
					registry.rename(workerId, organizationId, payload.name),
					).pipe(
					Effect.orDie,
				),
			)
			.handle("remove", ({ params: { workerId } }) =>
				inOrg((organizationId) =>
					registry.remove(workerId, organizationId)).pipe(
					Effect.orDie,
					Effect.flatMap((deleted) =>
						deleted ? Effect.void : Effect.fail(new WorkerNotFound({ workerId })),
					),
				),
			)
			.handle("usageDaily", ({ params: { workerId }, query }) =>
				inOrg((organizationId) =>
					usage.daily({ organizationId, workerId }, query.days ?? 14, { fill: true }),
					).pipe(
					Effect.orDie,
				),
			)
			.handle("usageByModel", ({ params: { workerId } }) =>
				inOrg((organizationId) =>
					usage.byModel({ organizationId, workerId })).pipe(
					Effect.orDie,
				),
			)
			.handle("recentEvents", ({ params: { workerId }, query }) =>
				inOrg((organizationId) =>
					usage.recentEvents(
							{ organizationId, workerId },
							Math.min(query.limit ?? 25, 100),
						),
					).pipe(
					Effect.orDie,
				),
			);
	}),
);

const UsageHandlers = HttpApiBuilder.group(
	DashboardApi,
	"usage",
	Effect.fn(function* (handlers) {
		const usage = yield* Usage;
		return handlers
			.handle("byModel", ({ query }) =>
				inOrg((organizationId) =>
					usage.byModel(
						{ organizationId },
						query.range !== undefined ? rangeStart(query.range) : undefined,
					),
				).pipe(Effect.orDie),
			)
			.handle("summary", ({ query }) =>
				inOrg((organizationId) => usage.summary(organizationId, query.range)).pipe(
					Effect.orDie,
				),
			)
			.handle("workerSeries", ({ query }) =>
				inOrg((organizationId) =>
					usage.workerSeries(organizationId, Math.min(query.days ?? 14, 90)),
				).pipe(Effect.orDie),
			)
			.handle("recentEvents", ({ query }) =>
				inOrg((organizationId) =>
					usage.recentEvents({ organizationId }, Math.min(query.limit ?? 25, 100)),
				).pipe(Effect.orDie),
			);
	}),
);

/** The dashboard's HttpApi, with every handler and the session middleware. */
export const dashboardRoutes = HttpApiBuilder.layer(DashboardApi).pipe(
	Layer.provide([PublicHandlers, WorkersHandlers, UsageHandlers]),
	Layer.provide(SessionAuthLive),
);

const RANGE_MS = { "24h": 24 * 3_600_000, "7d": 7 * 86_400_000, "14d": 14 * 86_400_000 };

function rangeStart(range: keyof typeof RANGE_MS): Date {
	return new Date(Date.now() - RANGE_MS[range]);
}
