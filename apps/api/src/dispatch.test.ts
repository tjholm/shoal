import { describe, expect, it } from "bun:test";
import { BunCrypto } from "@effect/platform-bun";
import { Deferred, Effect, Layer, Option, type Scope, Stream } from "effect";
import { Dispatcher, type JobChange } from "./dispatch";
import { Usage } from "./usage";
import { type LiveWorker, WorkerRegistry } from "./workers/registry";

const worker: LiveWorker = {
	workerId: "w",
	organizationId: "org",
	keyId: null,
	connection: { send: () => Effect.void, close: () => Effect.void },
	loadedModels: [],
	availableModels: [],
	inFlight: 0,
	maxConcurrent: 1,
	jobsCompleted: 0,
	connectedAt: 0,
};

// The one connected worker always has a slot. The registry's own database
// and socket handling aren't what's under test.
const registry = Layer.succeed(WorkerRegistry, {
	reserve: () => Effect.succeed({ _tag: "Reserved", worker }),
	release: () => Effect.void,
	get: () => Effect.succeed(Option.none()),
} as unknown as WorkerRegistry["Service"]);

/** Runs `test` against a dispatcher whose usage writes land when `written`
 *  is completed, like a slow database. */
const withDispatcher = <A, E>(
	test: (
		dispatcher: Dispatcher["Service"],
		written: Deferred.Deferred<void>,
	) => Effect.Effect<A, E, Scope.Scope>,
) =>
	Effect.gen(function* () {
		const written = yield* Deferred.make<void>();
		const usage = Layer.succeed(Usage, {
			record: () => Deferred.await(written),
		} as unknown as Usage["Service"]);
		return yield* Effect.gen(function* () {
			return yield* test(yield* Dispatcher, written);
		}).pipe(
			Effect.scoped,
			Effect.provide(Dispatcher.layer.pipe(Layer.provide([registry, usage, BunCrypto.layer]))),
		);
	}).pipe(Effect.runPromise);

const chat = { organizationId: "org", task: "chat", model: "gemma", input: [] } as const;

const summarise = (change: JobChange) =>
	change.type === "deleted"
		? "deleted"
		: `upsert completionTokens=${change.job.completionTokens}`;

describe("Dispatcher activity", () => {
	it("keeps a finished chat job visible until its usage is written, then deletes it", () =>
		withDispatcher((dispatcher, written) =>
			Effect.gen(function* () {
				const changes = yield* dispatcher.subscribe("org");
				const { jobId } = yield* dispatcher.dispatch(chat);
				yield* dispatcher.receive("w", {
					type: "done",
					jobId,
					finishReason: "stop",
					usage: { promptTokens: 3, completionTokens: 5 },
				});

				const whileWriting = yield* dispatcher.running("org");
				expect(whileWriting.map((job) => job.completionTokens)).toEqual([5]);

				yield* Deferred.succeed(written, undefined);
				const seen = yield* changes.pipe(Stream.take(3), Stream.runCollect);
				expect(Array.from(seen, summarise)).toEqual([
					"upsert completionTokens=null",
					"upsert completionTokens=5",
					"deleted",
				]);
				expect(yield* dispatcher.running("org")).toEqual([]);
			}),
		));

	it("deletes a failed job straight away", () =>
		withDispatcher((dispatcher) =>
			Effect.gen(function* () {
				const changes = yield* dispatcher.subscribe("org");
				const { jobId } = yield* dispatcher.dispatch(chat);
				yield* dispatcher.receive("w", { type: "error", jobId, message: "out of memory" });

				const seen = yield* changes.pipe(Stream.take(2), Stream.runCollect);
				expect(Array.from(seen, summarise)).toEqual(["upsert completionTokens=null", "deleted"]);
				expect(yield* dispatcher.running("org")).toEqual([]);
			}),
		));

	it("reports only the subscribing org's jobs", () =>
		withDispatcher((dispatcher) =>
			Effect.gen(function* () {
				const changes = yield* dispatcher.subscribe("other-org");
				yield* dispatcher.dispatch(chat);
				expect(yield* dispatcher.running("other-org")).toEqual([]);
				const seen = yield* changes.pipe(
					Stream.take(1),
					Stream.runCollect,
					Effect.timeoutOption("50 millis"),
				);
				expect(Option.isNone(seen)).toBe(true);
			}),
		));
});
