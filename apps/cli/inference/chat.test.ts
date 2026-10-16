import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { type CompletionChunk, toDelta } from "./chat";

const chunk = (delta: object): CompletionChunk =>
	({ choices: [{ delta }] }) as CompletionChunk;

describe("toDelta", () => {
	test("Ollama's `reasoning` is forwarded as reasoning", () => {
		expect(toDelta(chunk({ content: "", reasoning: "hmm" }))).toEqual(
			Option.some({ _tag: "Delta", reasoning: "hmm" }),
		);
	});

	test("vLLM's and LM Studio's `reasoning_content` is forwarded as reasoning", () => {
		expect(toDelta(chunk({ reasoning_content: "hmm" }))).toEqual(
			Option.some({ _tag: "Delta", reasoning: "hmm" }),
		);
	});

	test("content is forwarded without reasoning", () => {
		expect(toDelta(chunk({ content: "Hi" }))).toEqual(
			Option.some({ _tag: "Delta", content: "Hi" }),
		);
	});

	test("a chunk with reasoning and content keeps both", () => {
		expect(toDelta(chunk({ reasoning: "hmm", content: "Hi" }))).toEqual(
			Option.some({ _tag: "Delta", content: "Hi", reasoning: "hmm" }),
		);
	});

	test("empty strings and role-only chunks produce no delta", () => {
		expect(toDelta(chunk({ role: "assistant" }))).toEqual(Option.none());
		expect(toDelta(chunk({ content: "", reasoning: "", reasoning_content: "" }))).toEqual(
			Option.none(),
		);
	});
});
