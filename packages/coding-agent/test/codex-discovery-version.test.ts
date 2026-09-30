import { Buffer } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

afterEach(() => vi.unstubAllGlobals());

it("discovers Sol and Luna through the supported Codex client version gate", async () => {
	const auth = AuthStorage.inMemory();
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
	).toString("base64url");
	auth.setRuntimeApiKey("openai-codex", `header.${payload}.signature`);
	const registry = ModelRegistry.inMemory(auth);
	const base = registry.getAll().find((model) => model.provider === "openai-codex")!;
	registry.registerProvider("openai-codex", {
		baseUrl: base.baseUrl,
		api: base.api,
		apiKey: "test-key",
		models: ["gpt-6-sol", "gpt-6-luna"].map((id) => ({ ...base, id, name: id })),
	});
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : input);
		const minor = Number(url.searchParams.get("client_version")?.split(".")[1]);
		return Response.json({ models: minor >= 155 ? [{ slug: "gpt-6-sol" }, { slug: "gpt-6-luna" }] : [] });
	});
	const ids = (await registry.getExecutableModels())
		.filter((model) => model.provider === "openai-codex")
		.map((model) => model.id);
	expect(ids).toContain("gpt-6-sol");
	expect(ids).toContain("gpt-6-luna");
});
