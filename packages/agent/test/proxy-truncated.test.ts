import { getModel } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.js";

afterEach(() => vi.unstubAllGlobals());

it.each(["done", "error"] as const)("preserves an explicit %s terminal event", async (type) => {
	const terminal = {
		type,
		reason: type === "done" ? "stop" : "error",
		errorMessage: "provider error",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	vi.stubGlobal("fetch", async () => new Response(`data: ${JSON.stringify(terminal)}\n\n`));
	const stream = streamProxy(
		getModel("openai", "gpt-4o"),
		{ messages: [] },
		{ authToken: "test", proxyUrl: "https://example.invalid" },
	);
	const events = [];
	for await (const event of stream) events.push(event.type);
	expect(events).toEqual([type]);
	expect((await stream.result()).stopReason).toBe(terminal.reason);
});

it("settles a proxy stream that ends before a terminal event", async () => {
	vi.stubGlobal("fetch", async () => new Response('data: {"type":"start"}\n\n'));
	const stream = streamProxy(
		getModel("openai", "gpt-4o"),
		{ messages: [] },
		{ authToken: "test", proxyUrl: "https://example.invalid" },
	);
	const events = [];
	for await (const event of stream) events.push(event.type);
	// Assert the error first so the broken implementation does not hang on result().
	expect(events).toEqual(["start", "error"]);
	const result = await stream.result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toMatch(/truncated/i);
});
