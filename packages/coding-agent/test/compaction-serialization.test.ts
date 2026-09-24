import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.js";

describe("serializeConversation", () => {
	it("pairs repeated tool calls with results and preserves error status", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				api: "openai-responses",
				provider: "openai",
				model: "test",
				timestamp: 0,
				stopReason: "toolUse",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				content: [
					{ type: "toolCall", id: "long-id-a", name: "javascript", arguments: { code: "1" } },
					{ type: "toolCall", id: "long-id-b", name: "javascript", arguments: { code: "2" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "long-id-b",
				toolName: "javascript",
				content: [{ type: "text", text: "failed" }],
				isError: true,
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "long-id-a",
				toolName: "javascript",
				content: [{ type: "text", text: "one" }],
				isError: false,
				timestamp: 2,
			},
		];
		const result = serializeConversation(messages);
		expect(result).toContain('#1 javascript(code="1"); #2 javascript(code="2")');
		expect(result).toContain("[Tool result (javascript, error) #2]: failed");
		expect(result).toContain("[Tool result (javascript) #1]: one");
		expect(result).not.toContain("long-id-");
	});
	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "javascript",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result (javascript)]:");
		expect(result).toContain("[... 3000 more characters truncated]");
		expect(result).not.toContain("x".repeat(3000));
		// First 2000 chars should be present
		expect(result).toContain("x".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "javascript",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result (javascript)]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
