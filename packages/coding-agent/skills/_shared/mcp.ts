import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { asRecord, type SkillContext } from "./context.ts";

const EXPIRY_SKEW_MS = 30_000;

interface McpIntegrationOptions {
	server: string;
	url?: string;
	bearerTokenEnv?: string;
}

interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface McpIntegration {
	listTools: () => Promise<McpTool[]>;
	callTool: (tool: string, arguments_?: Record<string, unknown>) => Promise<unknown>;
	[name: string]: unknown;
}

export class McpToolError extends Error {}

export class McpNotEnabledError extends Error {
	constructor(server: string) {
		super(
			`The '${server}' integration is not enabled: no credentials found. ` +
				`Tell the user to run \`/mcp login ${server}\` in Prime Agent to connect it. ` +
				"Do not ask them to set environment variables.",
		);
		this.name = "McpNotEnabledError";
	}
}

function agentDir(): string {
	const configured =
		process.env.PRIME_AGENT_CODING_AGENT_DIR ??
		process.env.PI_CODING_AGENT_DIR ??
		resolve(homedir(), ".prime", "agent");
	return resolve(configured.replace(/^~(?=\/|$)/, homedir()));
}

async function readCredential(provider: string): Promise<Record<string, unknown> | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(resolve(agentDir(), "auth.json"), "utf8"));
		const credential = asRecord(parsed)[provider];
		if (typeof credential === "object" && credential !== null && !Array.isArray(credential)) {
			return credential as Record<string, unknown>;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function resolveConfigValue(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("!")) return "";
	return (process.env[trimmed] ?? trimmed).trim();
}

async function readUsableToken(
	provider: string,
	bearerTokenEnv?: string,
): Promise<string | undefined> {
	if (bearerTokenEnv) {
		const token = process.env[bearerTokenEnv]?.trim();
		if (token) return token;
	}
	const credential = await readCredential(provider);
	if (!credential) return undefined;
	if (credential.type === "api_key") {
		return resolveConfigValue(String(credential.key ?? "")) || undefined;
	}
	const access = String(credential.access ?? "");
	const expires = credential.expires;
	if (access && typeof expires === "number" && Date.now() < expires - EXPIRY_SKEW_MS) {
		return access;
	}
	return undefined;
}

function normalizeToolResult(result: CallToolResult): unknown {
	const texts = result.content.flatMap((block) =>
		block.type === "text" ? [block.text] : [],
	);
	if (result.isError) {
		throw new McpToolError(texts.join("\n") || "MCP tool returned an error");
	}
	if (result.structuredContent !== undefined) return result.structuredContent;
	if (texts.length > 0) return texts.join("\n");
	if (result.content.length > 0) return result.content;
	return result;
}

export function createMcpIntegration(
	context: SkillContext,
	options: McpIntegrationOptions,
): McpIntegration {
	if (!options.server) throw new TypeError("MCP integration server must be non-empty");
	const provider = `mcp:${options.server}`;
	let tools: Map<string, McpTool> | undefined;

	const resolveToken = async (): Promise<string> => {
		let token = await readUsableToken(provider, options.bearerTokenEnv);
		if (token) return token;
		if (await readCredential(provider)) {
			let refreshError: unknown;
			try {
				await context.hostRequest("mcp.refresh", { server: options.server });
			} catch (error) {
				refreshError = error;
			}
			token = await readUsableToken(provider, options.bearerTokenEnv);
			if (token) return token;
			if (refreshError) {
				throw new Error(
					`Failed to refresh credentials for '${options.server}': ${String(refreshError)}`,
					{ cause: refreshError },
				);
			}
		}
		throw new McpNotEnabledError(options.server);
	};

	const resolveConnection = async (): Promise<{ url: string; headers: HeadersInit }> => {
		let config: Record<string, unknown> = {};
		try {
			config = asRecord(await context.hostRequest("mcp.config", { server: options.server }));
		} catch {
			// Fall back to the bundled endpoint.
		}
		const url = typeof config.url === "string" && config.url ? config.url : options.url;
		if (!url) throw new Error(`MCP integration '${options.server}' has no endpoint URL`);
		const configuredHeaders = asRecord(config.headers);
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(configuredHeaders)) headers[key] = String(value);
		headers.Authorization = `Bearer ${await resolveToken()}`;
		return { url, headers };
	};

	const withClient = async <T>(run: (client: Client) => Promise<T>): Promise<T> => {
		const connection = await resolveConnection();
		const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
			requestInit: { headers: connection.headers },
		});
		const client = new Client({ name: "prime-agent-bun-repl", version: "1.0.0" });
		await client.connect(transport);
		try {
			return await run(client);
		} finally {
			await client.close();
		}
	};

	const ensureTools = async (): Promise<Map<string, McpTool>> => {
		if (tools) return tools;
		const listed = await withClient((client) => client.listTools());
		tools = new Map(
			listed.tools.map((tool) => [
				tool.name,
				{
					name: tool.name,
					description: tool.description ?? "",
					inputSchema: asRecord(tool.inputSchema),
				},
			]),
		);
		return tools;
	};

	const target: McpIntegration = {
		listTools: async () => [...(await ensureTools()).values()].map((tool) => ({ ...tool })),
		callTool: async (tool, arguments_ = {}) =>
			withClient(async (client) => normalizeToolResult(await client.callTool({ name: tool, arguments: arguments_ }))),
	};

	return new Proxy(target, {
		get(current, property, receiver) {
			if (property === "then") return undefined;
			if (typeof property !== "string" || property.startsWith("_") || property in current) {
				return Reflect.get(current, property, receiver);
			}
			return async (arguments_: Record<string, unknown> = {}): Promise<unknown> => {
				const available = await ensureTools();
				if (!available.has(property)) {
					throw new Error(
						`'${options.server}' has no tool '${property}'. Available: ${
							[...available.keys()].sort().join(", ") || "(none)"
						}`,
					);
				}
				return target.callTool(property, arguments_);
			};
		},
	});
}
