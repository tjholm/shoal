import { Duration, Stream } from "effect";
import { HttpServerResponse } from "effect/http";

/** One server-sent event. `event` defaults to the SSE `message` type. */
export interface SseEvent {
	readonly event?: string;
	readonly data: unknown;
}

// Under Bun's 10s default socket idle timeout, and well under proxy idle
// timeouts (Cloudflare drops an origin after 100s of silence). A gap longer
// than Bun's timeout closes the socket without the chunked-encoding
// terminator, which proxies such as Envoy turn into an HTTP/2 RST_STREAM.
const KEEPALIVE_INTERVAL = Duration.seconds(5);

export const formatEvent = ({ event, data }: SseEvent): string =>
	`${event !== undefined ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

/** Stream pre-formatted SSE frames as `text/event-stream`, with an immediate
 *  comment so proxies flush headers, and comment keepalives while the source
 *  is quiet. */
export const sseResponse = <E>(
	frames: Stream.Stream<string, E>,
): HttpServerResponse.HttpServerResponse =>
	HttpServerResponse.stream(
		Stream.succeed(":ok\n\n").pipe(
			Stream.concat(
				frames.pipe(
					Stream.merge(
						Stream.tick(KEEPALIVE_INTERVAL).pipe(
							Stream.drop(1),
							Stream.map(() => ":ping\n\n"),
						),
						{ haltStrategy: "left" },
					),
				),
			),
			Stream.encodeText,
		),
		{
			contentType: "text/event-stream",
			headers: {
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			},
		},
	);
