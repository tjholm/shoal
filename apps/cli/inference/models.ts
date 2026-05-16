export async function fetchAvailableModels(backendUrl: string): Promise<string[]> {
  const res = await fetch(`${backendUrl}/v1/models`);
  if (!res.ok) {
    throw new Error(`Backend returned ${res.status} from /v1/models`);
  }
  const json = (await res.json()) as { data: Array<{ id: string }> };
  return json.data.map((m) => m.id);
}
