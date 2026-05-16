/**
 * Inference modules that proxy to a local OpenAI-compatible endpoint
 * (e.g. Ollama for chat/embeddings, openedai-speech / kokoro-fastapi for TTS).
 *
 * The worker doesn't run inference itself — each per-task module forwards to
 * whatever is running at the configured backend URL. Construct a client once
 * via `createInferenceClient` and inject it where inference is needed; this
 * keeps all backend coupling at the construction site, so tests can pass in
 * a fake client without touching module-level state.
 */

import {
  type ChatChunk,
  chatInference,
  type ChatOptions,
  type ToolCallDelta,
  type Usage,
} from "./chat";
import { embeddingInference } from "./embedding";
import { type GeneratedImage, imageInference, type ImageOptions } from "./image";
import { fetchAvailableModels } from "./models";
import { type GeneratedAudio, speechInference, type SpeechOptions } from "./speech";

export type {
  ChatChunk,
  ChatOptions,
  GeneratedAudio,
  GeneratedImage,
  ImageOptions,
  SpeechOptions,
  ToolCallDelta,
  Usage,
};

export interface InferenceClient {
  listModels(): Promise<string[]>;
  chat(
    model: string,
    messages: unknown[],
    options?: ChatOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatChunk>;
  embedding(
    model: string,
    input: string | string[],
    signal?: AbortSignal,
  ): Promise<number[][]>;
  image(
    model: string,
    prompt: string,
    options?: ImageOptions,
    signal?: AbortSignal,
  ): Promise<GeneratedImage[]>;
  speech(
    model: string,
    input: string,
    options?: SpeechOptions,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio>;
}

export function createInferenceClient(config: { backendUrl: string }): InferenceClient {
  const backendUrl = config.backendUrl.replace(/\/+$/, "");
  return {
    listModels: () => fetchAvailableModels(backendUrl),
    chat: (model, messages, options, signal) =>
      chatInference(backendUrl, model, messages, options, signal),
    embedding: (model, input, signal) =>
      embeddingInference(backendUrl, model, input, signal),
    image: (model, prompt, options, signal) =>
      imageInference(backendUrl, model, prompt, options, signal),
    speech: (model, input, options, signal) =>
      speechInference(backendUrl, model, input, options, signal),
  };
}
