import type {
	ModelCapability,
	ModelPurpose,
	WorkerModel,
} from "@shoal/protocol";

/**
 * Ollama's `/v1/models` only returns ids, so we follow up with one
 * `POST /api/show` per model to read its capabilities. Non-Ollama
 * OpenAI-compatible backends 404 on /api/show; we treat that as "capabilities
 * unknown" and surface the model anyway, with `purpose`/`capabilities` left
 * undefined so the server's permit-unknown rule applies.
 *
 * Probes fan out with a small concurrency cap — Ollama is local so individual
 * calls are cheap, but 50 sequential round-trips on first boot would still be
 * noticeably slow.
 */

const OLLAMA_PROBE_CONCURRENCY = 4;

/** Per-backend memo of whether /api/show is available. If the first round of
 *  probes against a given backend fails for every model, we flip to
 *  "unavailable" and stop probing — re-querying every refresh would just
 *  waste round-trips on a backend that will never answer. */
const ollamaProbeStatus = new Map<string, "available" | "unavailable">();

export async function probeOllamaCapabilities(
	backendUrl: string,
	ids: string[],
): Promise<WorkerModel[]> {
	if (ids.length === 0) return [];
	if (ollamaProbeStatus.get(backendUrl) === "unavailable") {
		return ids.map((id) => ({ id }));
	}

	const out = new Array<WorkerModel>(ids.length);
	let cursor = 0;
	let anySuccess = false;
	let anyAttempt = false;

	async function probeWorker(): Promise<void> {
		while (true) {
			const i = cursor++;
			if (i >= ids.length) return;
			anyAttempt = true;
			const id = ids[i];
			const caps = await fetchOllamaCapabilities(backendUrl, id);
			if (caps) anySuccess = true;
			out[i] = caps ?? { id };
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(OLLAMA_PROBE_CONCURRENCY, ids.length) }, () =>
			probeWorker(),
		),
	);

	if (anyAttempt && !anySuccess) {
		// Backend doesn't speak Ollama's /api/show — record so we don't keep
		// probing on every refresh. Log explicitly rather than silently degrading.
		ollamaProbeStatus.set(backendUrl, "unavailable");
		console.warn(
			`[worker] backend ${backendUrl} did not respond to /api/show; ` +
				`model capabilities will be reported as unknown and the server will ` +
				`route to it permissively.`,
		);
	} else if (anySuccess) {
		ollamaProbeStatus.set(backendUrl, "available");
	}

	return out;
}

interface OllamaShowResponse {
	capabilities?: string[];
}

interface OllamaPsResponse {
	models?: Array<{ model?: string; name?: string }>;
}

/** Currently-resident models, per Ollama's `GET /api/ps`. Each entry carries
 *  both `model` (the id used in /v1 requests) and `name`; we prefer `model`
 *  for the residency set so the strings match what shoal routes against. */
export async function fetchOllamaLoadedModels(
	backendUrl: string,
): Promise<string[]> {
	const res = await fetch(`${backendUrl}/api/ps`);
	if (!res.ok) {
		throw new Error(`Ollama /api/ps returned ${res.status}`);
	}
	const body = (await res.json()) as OllamaPsResponse;
	const ids: string[] = [];
	for (const m of body.models ?? []) {
		const id = m.model ?? m.name;
		if (typeof id === "string") ids.push(id);
	}
	return ids;
}

async function fetchOllamaCapabilities(
	backendUrl: string,
	model: string,
): Promise<WorkerModel | null> {
	try {
		const res = await fetch(`${backendUrl}/api/show`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: model }),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as OllamaShowResponse;
		const caps = body.capabilities ?? [];

		// Ollama uses `completion` for chat-style generation and `embedding` for
		// embedding models — these are mutually exclusive in practice. Image/TTS
		// aren't served from Ollama, so we don't try to detect them here.
		let purpose: ModelPurpose | undefined;
		if (caps.includes("completion")) purpose = "chat";
		else if (caps.includes("embedding")) purpose = "embedding";

		const capabilities: ModelCapability[] = [];
		if (caps.includes("tools")) capabilities.push("tools");
		if (caps.includes("vision")) capabilities.push("vision");
		if (caps.includes("thinking")) capabilities.push("thinking");

		const out: WorkerModel = { id: model };
		if (purpose !== undefined) out.purpose = purpose;
		if (capabilities.length > 0) out.capabilities = capabilities;
		return out;
	} catch {
		return null;
	}
}
