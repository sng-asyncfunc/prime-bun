import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";

describe("current built-in model catalog", () => {
	it("exposes Gemini 3.7 Flash through the direct Google and Vertex providers", () => {
		const googleModel = getModel("google", "gemini-3.7-flash");
		const vertexModel = getModel("google-vertex", "gemini-3.7-flash");

		expect(googleModel?.api).toBe("google-generative-ai");
		expect(googleModel?.input).toEqual(["text", "image"]);
		expect(vertexModel?.api).toBe("google-vertex");
		expect(vertexModel?.input).toEqual(["text", "image"]);
	});

	it("exposes DeepSeek V4 Flash Vision with image input and V4 reasoning semantics", () => {
		const model = getModel("deepseek", "deepseek-v4-flash-vision-exp");

		expect(model?.api).toBe("openai-completions");
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.compat).toMatchObject({
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		});
		expect(model && getSupportedThinkingLevels(model)).toEqual(["off", "high", "xhigh"]);
	});
});
