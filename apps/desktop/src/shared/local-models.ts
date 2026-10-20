/** Where the app's own llama-server listens. Fixed so the URL can sit in the
 *  shared worker.json like any other backend. */
export const LOCAL_MODELS_URL = "http://127.0.0.1:45129";

/** Models suggested in the window; any `<user>/<repo>[:quant]` GGUF repo works. */
export const SUGGESTED_MODELS = [
	"ggml-org/gemma-3-1b-it-GGUF",
	"ggml-org/gemma-3-4b-it-GGUF",
	"ggml-org/Qwen3-4B-GGUF",
	"ggml-org/embeddinggemma-300M-GGUF",
] as const;
