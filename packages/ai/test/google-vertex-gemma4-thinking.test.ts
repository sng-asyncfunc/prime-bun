import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it } from "vitest";
import { streamSimpleGoogleVertex } from "../src/providers/google-vertex.js";
import type { Model, SimpleStreamOptions } from "../src/types.js";

const model: Model<"google-vertex"> = {
	id: "gemma-4-26b-a4b-it",
	name: "Gemma 4 test fixture",
	api: "google-vertex",
	provider: "google-vertex",
	baseUrl: "https://{location}-aiplatform.googleapis.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131072,
	maxTokens: 8192,
};

describe("Vertex Gemma 4 thinking", () => {
	it.each([
		[undefined, "MINIMAL"],
		["minimal", "MINIMAL"],
		["low", "MINIMAL"],
		["medium", "HIGH"],
		["high", "HIGH"],
	] satisfies [SimpleStreamOptions["reasoning"], string][])(
		"maps %s to %s without budgets",
		async (reasoning, level) => {
			let params: GenerateContentParameters | undefined;
			await streamSimpleGoogleVertex(
				model,
				{ messages: [] },
				{
					apiKey: "fake-key",
					reasoning,
					onPayload: (payload) => {
						params = payload as GenerateContentParameters;
						throw new Error("Captured locally; never send this request");
					},
				},
			).result();
			expect(params?.config?.thinkingConfig).toEqual({
				...(reasoning ? { includeThoughts: true } : {}),
				thinkingLevel: level,
			});
		},
	);
});
