import { afterEach, describe, expect, test } from "bun:test";
import { setHostRequestOverride } from "../src/bridge.ts";
import {
	listConnections,
	listPlugins,
	McpCredentialsUnavailable,
	searchPlugins,
	status as mcpStatus,
} from "../src/mcp.ts";

afterEach(() => {
	setHostRequestOverride(null);
});

describe("mcp registry & discovery", () => {
	test("listConnections, listPlugins, and searchPlugins sanitize secret-looking keys", async () => {
		setHostRequestOverride(async (type, payload) => {
			if (type === "mcp.list_connections") {
				return {
					connections: [
						{
							connectionId: "linear",
							label: "Linear",
							status: "connected",
							accessToken: "super-secret-token",
							nested: { api_key: "leaked", safe: "ok" },
						},
					],
				};
			}
			if (type === "mcp.list_plugins") {
				expect(payload?.limit).toBe(10);
				return {
					plugins: [{ id: "linear", label: "Linear", clientSecret: "shh" }],
					nextCursor: "cur-2",
				};
			}
			if (type === "mcp.search_plugins") {
				expect(payload?.query).toBe("issue");
				return {
					plugins: [{ id: "linear", label: "Linear", authorization: "Bearer xxx" }],
					nextCursor: null,
				};
			}
			throw new Error(`unexpected ${type}`);
		});

		const conns = await listConnections();
		expect(conns).toEqual([
			{
				connectionId: "linear",
				label: "Linear",
				status: "connected",
				nested: { safe: "ok" },
			},
		]);

		const page = await listPlugins({ limit: 10 });
		expect(page.nextCursor).toBe("cur-2");
		expect(page.plugins).toEqual([{ id: "linear", label: "Linear" }]);

		const found = await searchPlugins("issue");
		expect(found.nextCursor).toBeNull();
		expect(found.plugins).toEqual([{ id: "linear", label: "Linear" }]);
	});

	test("status() reports per-server errors without failing the whole batch", async () => {
		setHostRequestOverride(async (type, payload) => {
			if (type === "mcp.config") {
				if (payload?.server === "missing") return {};
				if (payload?.server === "disabled") return { type: "http", url: "https://example.com", enabled: false };
				if (payload?.server === "unauthed") {
					return { type: "http", url: "https://example.com", oauth: true };
				}
			}
			throw new Error(`unexpected ${type}`);
		});

		const rows = await mcpStatus(["missing", "disabled", "unauthed"], 2000);
		expect(rows.length).toBe(3);
		expect(rows[0]!.server).toBe("missing");
		expect(rows[0]!.tools).toBeNull();
		expect(rows[0]!.error).toContain("not declared");

		expect(rows[1]!.server).toBe("disabled");
		expect(rows[1]!.tools).toBeNull();
		expect(rows[1]!.error).toContain("disabled");

		expect(rows[2]!.server).toBe("unauthed");
		expect(rows[2]!.tools).toBeNull();
		expect(rows[2]!.error).toContain(McpCredentialsUnavailable.name);
	});
});
