import { Config, Context, Effect, Layer, Option, Schema } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export class MissingPublicUrl extends Schema.TaggedError<MissingPublicUrl>()(
	"MissingPublicUrl",
	{ message: Schema.String },
) {}

/** Process-wide settings, read once from the environment at startup. */
export class ShoalConfig extends Context.Service<
	ShoalConfig,
	{
		readonly port: number;
		/** Origin the dashboard is served from; trusted by better-auth. */
		readonly appUrl: string;
		/** Public origin of this server. When unset, better-auth uses the
		 *  portless dev origin and worker URLs derive from the request host. */
		readonly serverUrl: Option.Option<string>;
		/** Open public sign-up. Otherwise only the first user may sign up. */
		readonly allowSignup: boolean;
		readonly schedulerEnabled: boolean;
		readonly usageRetentionDays: number;
		readonly usagePruneCron: string;
		/** Built dashboard to serve at every non-API path, if present. */
		readonly dashboardDir: Option.Option<string>;
	}
>()("@shoal/api/ShoalConfig") {
	static readonly layer = Layer.effect(
		ShoalConfig,
		Effect.gen(function* () {
			const serverUrl = yield* Config.option(Config.String("SHOAL_SERVER_URL"));
			const appUrl = yield* Config.option(Config.String("SHOAL_APP_URL"));
			const production =
				(yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"))) ===
				"production";
			// The portless dev origins only make sense in development; in production
			// they would break sign-in and hand workers an unreachable URL.
			if (production && (Option.isNone(serverUrl) || Option.isNone(appUrl))) {
				return yield* new MissingPublicUrl({
					message:
						"SHOAL_SERVER_URL and SHOAL_APP_URL must be set in production, to the address people and workers reach this server at (e.g. http://192.168.1.10:3000 or https://shoal.example.com).",
				});
			}
			return ShoalConfig.of({
				port: yield* Config.Port("PORT").pipe(Config.withDefault(3000)),
				appUrl: Option.getOrElse(appUrl, () => "https://web.shoal.localhost"),
				serverUrl,
				allowSignup: yield* Config.Boolean("SHOAL_ALLOW_SIGNUP").pipe(
					Config.withDefault(false),
				),
				schedulerEnabled: yield* Config.Boolean(
					"SHOAL_SCHEDULER_ENABLED",
				).pipe(Config.withDefault(true)),
				usageRetentionDays: yield* Config.schema(
					PositiveInt,
					"SHOAL_USAGE_RETENTION_DAYS",
				).pipe(Config.withDefault(14)),
				usagePruneCron: yield* Config.String("SHOAL_USAGE_PRUNE_CRON").pipe(
					Config.withDefault("0 * * * *"),
				),
				dashboardDir: yield* Config.option(
					Config.String("SHOAL_DASHBOARD_DIR"),
				),
			});
		}),
	);
}
