import os from "node:os";
import {
	Config,
	Context,
	Crypto,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Schema,
} from "effect";
import { Hex } from "effect/encoding";

export const WorkerIdentity = Schema.Struct({
	workerId: Schema.String,
	secret: Schema.String,
});
export type WorkerIdentity = typeof WorkerIdentity.Type;

const IdentityFile = Schema.fromJsonString(WorkerIdentity);

export class IdentityFileError extends Schema.TaggedError<IdentityFileError>()(
	"IdentityFileError",
	{
		path: Schema.String,
		reason: Schema.String,
		cause: Schema.Defect(),
	},
) {
	get message(): string {
		return (
			`Failed to ${this.reason} worker identity at ${this.path}. ` +
			`Delete the file to re-register as a new worker.`
		);
	}
}

/** The credentials this host uses to resume as the same worker on a given
 *  Shoal server. */
export class IdentityStore extends Context.Service<
	IdentityStore,
	{
		readonly path: string;
		readonly load: Effect.Effect<
			Option.Option<WorkerIdentity>,
			IdentityFileError
		>;
		save(identity: WorkerIdentity): Effect.Effect<void, IdentityFileError>;
	}
>()("@shoal/client-core/identity/IdentityStore") {
	/**
	 * Identity is keyed by a hash of the server URL so a single host can
	 * connect to multiple Shoal servers (prod / staging / homelab) without
	 * collision.
	 */
	static readonly layer = (serverUrl: string) =>
		Layer.effect(
			IdentityStore,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const crypto = yield* Crypto.Crypto;

				const stateRoot = yield* Config.String("XDG_STATE_HOME").pipe(
					Config.withDefault(path.join(os.homedir(), ".local", "state")),
				);
				const digest = yield* crypto.digest(
					"SHA-256",
					new TextEncoder().encode(serverUrl),
				);
				const file = path.join(
					stateRoot,
					"shoal",
					`identity-${Hex.encode(digest).slice(0, 16)}.json`,
				);

				const load = Effect.gen(function* () {
					if (!(yield* fs.exists(file))) return Option.none();
					const raw = yield* fs.readFileString(file);
					return Option.some(yield* Schema.decodeEffect(IdentityFile)(raw));
				}).pipe(
					Effect.mapError(
						(cause) => new IdentityFileError({ path: file, reason: "read", cause }),
					),
				);

				const save = (identity: WorkerIdentity) =>
					Effect.gen(function* () {
						yield* fs.makeDirectory(path.dirname(file), {
							recursive: true,
							mode: 0o700,
						});
						yield* fs.writeFileString(
							file,
							JSON.stringify(identity, null, 2),
							{ mode: 0o600 },
						);
					}).pipe(
						Effect.mapError(
							(cause) =>
								new IdentityFileError({ path: file, reason: "write", cause }),
						),
					);

				return IdentityStore.of({ path: file, load, save });
			}),
		);
}
