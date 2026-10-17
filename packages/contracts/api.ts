import { Context, Schema } from "effect";
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSchema,
} from "effect/http-api";
import {
	InvitationPublicInfo,
	ModelStatsReport,
	ModelUsage,
	ServerConfig,
	UsageBucket,
	UsageEventRow,
	UsageRange,
	UsageSummary,
	WorkerUsageSeries,
	WorkerDetail,
	WorkerInfo,
} from "./domain";

/** The organization the signed-in user is acting in. */
export class ActiveOrganization extends Context.Service<
	ActiveOrganization,
	{ readonly organizationId: string }
>()("@shoal/contracts/ActiveOrganization") {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
	"Unauthorized",
	{ message: Schema.String },
	{ httpApiStatus: 401 },
) {}

/** Requires a better-auth session cookie with an active organization. */
export class SessionAuth extends HttpApiMiddleware.Service<
	SessionAuth,
	{ provides: ActiveOrganization }
>()("@shoal/contracts/SessionAuth", { error: Unauthorized }) {}

export class WorkerNotFound extends Schema.TaggedError<WorkerNotFound>()(
	"WorkerNotFound",
	{ workerId: Schema.String },
	{ httpApiStatus: 404 },
) {}

const WorkerParams = { workerId: Schema.String };
const Days = Schema.optional(Schema.NumberFromString);
const Limit = Schema.optional(Schema.NumberFromString);

export class PublicGroup extends HttpApiGroup.make("public")
	.add(
		HttpApiEndpoint.get("config", "/config", { success: ServerConfig }),
		HttpApiEndpoint.get("invitation", "/invitations/:invitationId", {
			params: { invitationId: Schema.String },
			success: InvitationPublicInfo,
		}),
	)
	.prefix("/api") {}

export class WorkersGroup extends HttpApiGroup.make("workers")
	.add(
		HttpApiEndpoint.get("list", "/", { success: Schema.Array(WorkerInfo) }),
		HttpApiEndpoint.get("detail", "/:workerId", {
			params: WorkerParams,
			success: WorkerDetail,
			error: WorkerNotFound,
		}),
		HttpApiEndpoint.patch("rename", "/:workerId", {
			params: WorkerParams,
			payload: Schema.Struct({ name: Schema.NullOr(Schema.String) }),
			success: HttpApiSchema.NoContent,
		}),
		HttpApiEndpoint.delete("remove", "/:workerId", {
			params: WorkerParams,
			success: HttpApiSchema.NoContent,
			error: WorkerNotFound,
		}),
		HttpApiEndpoint.get("usageDaily", "/:workerId/usage/daily", {
			params: WorkerParams,
			query: { days: Days },
			success: Schema.Array(UsageBucket),
		}),
		HttpApiEndpoint.get("usageByModel", "/:workerId/usage/models", {
			params: WorkerParams,
			success: Schema.Array(ModelUsage),
		}),
		HttpApiEndpoint.get("recentEvents", "/:workerId/events", {
			params: WorkerParams,
			query: { limit: Limit },
			success: Schema.Array(UsageEventRow),
		}),
	)
	.middleware(SessionAuth)
	.prefix("/api/workers") {}

export class UsageGroup extends HttpApiGroup.make("usage")
	.add(
		HttpApiEndpoint.get("summary", "/summary", {
			query: { range: UsageRange },
			success: UsageSummary,
		}),
		HttpApiEndpoint.get("workerSeries", "/workers", {
			query: { days: Days },
			success: Schema.Array(WorkerUsageSeries),
		}),
		HttpApiEndpoint.get("byModel", "/models", {
			query: { range: Schema.optional(UsageRange) },
			success: Schema.Array(ModelUsage),
		}),
		HttpApiEndpoint.get("modelStats", "/models/stats", {
			query: { range: UsageRange },
			success: ModelStatsReport,
		}),
		HttpApiEndpoint.get("recentEvents", "/events", {
			query: { limit: Limit },
			success: Schema.Array(UsageEventRow),
		}),
	)
	.middleware(SessionAuth)
	.prefix("/api/usage") {}

/** The dashboard's API. The OpenAI/Anthropic surface, auth, the worker socket
 *  and the worker SSE feed are served alongside it as plain routes. */
export class DashboardApi extends HttpApi.make("shoal")
	.add(PublicGroup)
	.add(WorkersGroup)
	.add(UsageGroup) {}
