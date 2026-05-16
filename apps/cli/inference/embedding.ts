export async function embeddingInference(
  backendUrl: string,
  model: string,
  input: string | string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const res = await fetch(`${backendUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Backend returned ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data.map((d) => d.embedding);
}
