export interface SpeechOptions {
  voice?: string;
  responseFormat?: string;
  speed?: number;
  instructions?: string;
}

export interface GeneratedAudio {
  b64: string;
  mimeType: string;
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
export async function speechInference(
  backendUrl: string,
  model: string,
  input: string,
  options?: SpeechOptions,
  signal?: AbortSignal,
): Promise<GeneratedAudio> {
  const body: Record<string, unknown> = { model, input };
  if (options?.voice !== undefined) body.voice = options.voice;
  if (options?.responseFormat !== undefined) body.response_format = options.responseFormat;
  if (options?.speed !== undefined) body.speed = options.speed;
  if (options?.instructions !== undefined) body.instructions = options.instructions;

  const res = await fetch(`${backendUrl}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Backend returned ${res.status}: ${errBody}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const b64 = Buffer.from(bytes).toString("base64");
  // Prefer the backend's declared Content-Type; fall back to the format the
  // caller asked for. If neither is available the format is genuinely
  // unknown — surface octet-stream rather than guessing a codec.
  const headerType = res.headers.get("content-type") ?? undefined;
  const mimeType =
    headerType ?? FORMAT_MIME[options?.responseFormat ?? ""] ?? "application/octet-stream";
  return { b64, mimeType };
}
