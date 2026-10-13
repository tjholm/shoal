import type { SpeechOptions } from "@shoal/protocol";
import { Effect } from "effect";
import { Base64 } from "effect/encoding";
import { HttpClientRequest } from "effect/http";
import { execute } from "./backend";
import { BackendError } from "./errors";

export interface GeneratedAudio {
	readonly b64: string;
	readonly mimeType: string;
}

const FORMAT_MIME: Record<string, string> = {
	mp3: "audio/mpeg",
	opus: "audio/opus",
	aac: "audio/aac",
	flac: "audio/flac",
	wav: "audio/wav",
	pcm: "audio/pcm",
};

/**
 * Run TTS via the backend's `/v1/audio/speech`. The backend returns raw audio
 * bytes; we base64-encode them so the worker→server WS protocol (JSON only)
 * can carry the payload alongside the format's MIME type.
 */
export const speechInference = Effect.fnUntraced(function* (
	backendUrl: string,
	model: string,
	input: string,
	options: SpeechOptions | undefined,
) {
	const url = `${backendUrl}/v1/audio/speech`;
	const response = yield* execute(
		HttpClientRequest.post(url).pipe(
			HttpClientRequest.bodyJsonUnsafe({
				model,
				input,
				voice: options?.voice,
				response_format: options?.responseFormat,
				speed: options?.speed,
				instructions: options?.instructions,
			}),
		),
	);
	const bytes = yield* response.arrayBuffer.pipe(
		Effect.mapError(
			(cause) => new BackendError({ url, message: cause.message, cause }),
		),
	);
	// Prefer the backend's declared Content-Type; fall back to the format the
	// caller asked for. If neither is available the format is genuinely
	// unknown — surface octet-stream rather than guessing a codec.
	const mimeType =
		response.headers["content-type"] ??
		FORMAT_MIME[options?.responseFormat ?? ""] ??
		"application/octet-stream";
	return { b64: Base64.encode(new Uint8Array(bytes)), mimeType };
});
