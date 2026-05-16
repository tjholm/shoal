export interface ImageOptions {
  size?: string;
  n?: number;
  quality?: string;
  style?: string;
  responseFormat?: "url" | "b64_json";
}

export interface GeneratedImage {
  b64?: string;
  url?: string;
  revisedPrompt?: string;
}

export async function imageInference(
  backendUrl: string,
  model: string,
  prompt: string,
  options?: ImageOptions,
  signal?: AbortSignal,
): Promise<GeneratedImage[]> {
  const body: Record<string, unknown> = { model, prompt };
  if (options?.size !== undefined) body.size = options.size;
  if (options?.n !== undefined) body.n = options.n;
  if (options?.quality !== undefined) body.quality = options.quality;
  if (options?.style !== undefined) body.style = options.style;
  if (options?.responseFormat !== undefined) body.response_format = options.responseFormat;

  const res = await fetch(`${backendUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Backend returned ${res.status}: ${errBody}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  };
  if (!Array.isArray(json.data)) {
    throw new Error("Backend image response missing 'data' array");
  }
  return json.data.map((d) => ({
    b64: d.b64_json,
    url: d.url,
    revisedPrompt: d.revised_prompt,
  }));
}
