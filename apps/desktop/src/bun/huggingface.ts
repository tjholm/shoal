import type { ModelQuant, ModelSearchResult } from "../shared/rpc";

/** Hugging Face's API only allows browser requests from huggingface.co, so
 *  the window searches through the main process. */
const API = "https://huggingface.co/api/models";

const getJson = async <T>(url: string): Promise<T> => {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Hugging Face answered HTTP ${response.status} for ${url}`);
	return (await response.json()) as T;
};

/** GGUF repos matching `query`, most downloaded first. */
export const searchModels = async (query: string): Promise<ReadonlyArray<ModelSearchResult>> => {
	const params = new URLSearchParams({ search: query, filter: "gguf", sort: "downloads", limit: "8" });
	const found = await getJson<ReadonlyArray<{ id: string; downloads?: number }>>(`${API}?${params}`);
	return found.map((m) => ({ id: m.id, downloads: m.downloads ?? 0 }));
};

// e.g. gemma-3-1b-it-Q4_K_M, model-UD-Q4_K_XL, model-BF16-00001-of-00002
const QUANT = /-((?:UD-)?(?:I?Q\d\w*|BF16|F16|F32))(?:-\d{5}-of-\d{5})?\.gguf$/i;
// Vision projectors and multi-token-prediction heads ride along with a model; they aren't one.
const SIDECAR = /^(mmproj|mtp)/i;

/** The quantizations `repo` offers, smallest first, with split files summed. */
export const modelQuants = async (repo: string): Promise<ReadonlyArray<ModelQuant>> => {
	const files = await getJson<ReadonlyArray<{ type: string; path: string; size: number }>>(
		`${API}/${repo}/tree/main?recursive=true`,
	);
	const sizes = new Map<string, number>();
	for (const file of files) {
		const name = file.path.split("/").at(-1) ?? "";
		const tag = file.type === "file" && !SIDECAR.test(name) ? QUANT.exec(name)?.[1] : undefined;
		if (tag) sizes.set(tag, (sizes.get(tag) ?? 0) + file.size);
	}
	return [...sizes].map(([tag, bytes]) => ({ tag, bytes })).sort((a, b) => a.bytes - b.bytes);
};
