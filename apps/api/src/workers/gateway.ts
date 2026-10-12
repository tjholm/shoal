import {
	type ServerMessage,
	ServerMessageJson,
	type WorkerMessage,
	WorkerMessageJson,
} from "@shoal/protocol";
import { Duration, Effect, Layer, Option, Ref, Schedule, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import { Auth, type Principal } from "../auth";
import { Dispatcher } from "../dispatch";
import { type WorkerConnection, WorkerRegistry } from "./registry";

const PING_INTERVAL = Duration.seconds(10);
const MAX_MISSED_PINGS = 3;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_INTERNAL_ERROR = 1011;

const encodeServerMessage = Schema.encodeSync(ServerMessageJson);
const decodeWorkerMessage = Schema.decodeUnknownEffect(WorkerMessageJson);

/** `GET /ws/workers?token=<api key>`: the socket workers connect to. */
export const workerGatewayRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const auth = yield* Auth;
		const registry = yield* WorkerRegistry;
		const dispatcher = yield* Dispatcher;

		const serve = Effect.fnUntraced(function* (
			socket: Socket.Socket,
			principal: Option.Option<Principal>,
		) {
			const writer = yield* socket.writer;
			const connection: WorkerConnection = {
				send: (message: ServerMessage) =>
					writer.write(encodeServerMessage(message)).pipe(
						// A send racing the socket closing is harmless: the close
						// path abandons the worker's jobs.
						Effect.catch((err) =>
							Effect.logDebug(`dropped ${message.type} to closed worker socket`, err),
						),
					),
				close: (code, reason) =>
					writer
						.write(new Socket.CloseEvent(code, reason))
						.pipe(Effect.catch(() => Effect.void)),
			};

			// Always accept the upgrade and reject afterwards with a close frame:
			// a non-101 response to an upgrade crashes portless's proxy in dev,
			// whereas a close frame passes through as ordinary WS traffic.
			if (Option.isNone(principal)) {
				return yield* connection.close(CLOSE_POLICY_VIOLATION, "invalid api key");
			}
			const { organizationId, keyId } = principal.value;

			const workerId = yield* Ref.make(Option.none<string>());
			const missedPings = yield* Ref.make(0);

			const register = (
				message: Extract<WorkerMessage, { type: "register_new" | "register_resume" }>,
			) =>
				Effect.gen(function* () {
					const options = {
						organizationId,
						keyId,
						connection,
						maxConcurrent: message.maxConcurrent,
						name: message.name,
					};
					if (message.type === "register_new") {
						const registered = yield* registry.registerNew(options);
						yield* Ref.set(workerId, Option.some(registered.workerId));
						yield* connection.send({ type: "registered", ...registered });
						yield* Effect.log(
							`worker registered (new): ${registered.workerId} (org ${organizationId})`,
						);
						return;
					}
					yield* registry.registerResume({
						...options,
						workerId: message.workerId,
						secret: message.secret,
					});
					yield* Ref.set(workerId, Option.some(message.workerId));
					yield* connection.send({ type: "registered", workerId: message.workerId });
					yield* Effect.log(
						`worker registered (resume): ${message.workerId} (org ${organizationId})`,
					);
				}).pipe(
					Effect.catchTags({
						WorkerAuthFailed: () =>
							connection.close(CLOSE_POLICY_VIOLATION, "invalid worker credentials"),
						WorkerAlreadyConnected: () =>
							connection.close(CLOSE_POLICY_VIOLATION, "worker already connected"),
						DatabaseError: (err) =>
							Effect.logError("worker register failed", err).pipe(
								Effect.andThen(connection.close(CLOSE_INTERNAL_ERROR, "register failed")),
							),
					}),
				);

			const handle = (message: WorkerMessage) =>
				Effect.gen(function* () {
					if (message.type === "register_new" || message.type === "register_resume") {
						return yield* register(message);
					}
					// Anything else before registration is ignored.
					const id = yield* Ref.get(workerId);
					if (Option.isNone(id)) return;
					switch (message.type) {
						case "pong":
							return yield* Ref.set(missedPings, 0);
						case "stats":
							return yield* registry.recordStats(id.value, message);
						case "models":
							return yield* registry.recordModels(id.value, message.models);
						default:
							return yield* dispatcher.receive(id.value, message);
					}
				});

			const heartbeat = Effect.gen(function* () {
				const missed = yield* Ref.getAndUpdate(missedPings, (n) => n + 1);
				if (missed >= MAX_MISSED_PINGS) {
					yield* Effect.log(`evicting worker (missed ${missed} pings)`);
					yield* connection.close(CLOSE_GOING_AWAY, "ping timeout");
					return;
				}
				yield* connection.send({ type: "ping" });
			}).pipe(Effect.repeat(Schedule.spaced(PING_INTERVAL)), Effect.delay(PING_INTERVAL));

			const disconnect = Ref.get(workerId).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.void,
						onSome: (id) =>
							Effect.log(`worker disconnected: ${id}`).pipe(
								Effect.andThen(dispatcher.abandonWorker(id)),
								Effect.andThen(registry.disconnect(id)),
							),
					}),
				),
			);

			const pull = yield* Socket.readerString(socket);
			yield* Effect.forkScoped(heartbeat);
			yield* Effect.gen(function* () {
				while (true) {
					for (const frame of yield* pull) {
						yield* decodeWorkerMessage(frame).pipe(
							Effect.matchEffect({
								onFailure: (err) =>
									Effect.logWarning(`invalid worker message: ${err.message}`),
								onSuccess: handle,
							}),
						);
					}
				}
			}).pipe(
				Effect.catchIf(
					(err) =>
						err._tag === "SocketError" && err.reason._tag === "SocketCloseError",
					() => Effect.void,
				),
				Effect.ensuring(disconnect),
			);
		}, Effect.scoped);

		yield* router.add(
			"GET",
			"/ws/workers",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const token = new URL(request.url, "http://shoal").searchParams.get("token");
				const principal = token
					? yield* auth.verifyApiKey(token).pipe(
							Effect.tapError((err) => Effect.logError("api key verification failed", err)),
							Effect.orElseSucceed(() => Option.none<Principal>()),
						)
					: Option.none<Principal>();
				const socket = yield* request.upgrade;
				yield* serve(socket, principal).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("worker connection ended badly", cause),
					),
				);
				return HttpServerResponse.empty();
			}),
		);
	}),
);

