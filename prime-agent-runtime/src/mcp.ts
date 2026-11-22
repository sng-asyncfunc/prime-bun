import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { hostRequest } from "./bridge.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 2_500;
const EXPIRY_SKEW_MS = 30_000;
const STDERR_BYTE_LIMIT = 8 * 1024;
const STDERR_LINE_LIMIT = 40;
const SAFE_ENV = ["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"] as const;
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g;
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const INVENTORY_TIMEOUT_MS = 15_000;
const DEFAULT_PLUGIN_LIMIT = 50;
const MAX_PLUGIN_LIMIT = 200;
const DEFAULT_PLUGIN_SEARCH_LIMIT = 10;
const MAX_PLUGIN_SEARCH_LIMIT = 50;
const MAX_CURSOR_CHARS = 512;
const PLUGIN_CONNECTION_STATUSES = new Set(["connected", "not_connected"]);
const MAX_TOOL_PAGES = 25;
const DEFAULT_TOOL_SEARCH_LIMIT = 20;
const MAX_TOOL_SEARCH_LIMIT = 50;
const MAX_TOOL_SEARCH_SERVERS = 8;
const SECRET_KEY_RE = /token|secret|password|credential|authorization|api[_-]?key|private[_-]?key/i;

export class McpToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpToolError";
	}
}

export class McpStartupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpStartupError";
	}
}

export class McpDiscoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpDiscoveryError";
	}
}

export class McpCredentialsUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpCredentialsUnavailable";
	}
}

export interface McpToolMetadata {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface McpStatusRow {
	server: string;
	tools: Array<{ name: string; description: string }> | null;
	error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentDir(): string {
	const raw =
		(process.env.PRIME_AGENT_CODING_AGENT_DIR ?? "").trim() ||
		(process.env.PI_CODING_AGENT_DIR ?? "").trim() ||
		path.join(homedir(), ".prime", "agent");
	return path.resolve(raw.replace(/^~(?=\/|$)/, homedir()));
}

function readAuth(provider: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(agentDir(), "auth.json"), "utf8")) as unknown;
		if (!isRecord(parsed)) return null;
		const cred = parsed[provider];
		return isRecord(cred) ? cred : null;
	} catch {
		return null;
	}
}

function resolveConfigValue(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("!")) return "";
	return (process.env[trimmed] ?? trimmed).trim();
}

function boundAuth(provider: string, config: Record<string, unknown>): Record<string, unknown> | null {
	const cred = readAuth(provider);
	if (!cred) return null;
	const endpoint = cred.endpoint;
	if (typeof endpoint !== "string" || endpoint !== String(config.url ?? "")) return null;
	return cred;
}

function credentialsUnavailable(server: string): McpCredentialsUnavailable {
	return new McpCredentialsUnavailable(
		`MCP credentials for '${server}' are not available. Ask the user to connect it ` +
			`(/plugins or /mcp login ${server}); do not ask them to set environment variables.`,
	);
}

function staticToken(server: string, config: Record<string, unknown>): string {
	const cred = boundAuth(`mcp:${server}`, config);
	const bearer = cred?.bearer;
	return typeof bearer === "string" ? bearer.trim() : "";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		timer.unref?.();
		promise.then(
			(val) => {
				clearTimeout(timer);
				resolve(val);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

function parseTimeoutMs(value: unknown, fallback: number): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new RangeError("MCP timeouts must be positive milliseconds");
	}
	return value;
}

function parseToolResult(result: CallToolResult): unknown {
	const content = Array.isArray(result.content) ? result.content : [];
	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
			texts.push(block.text);
		}
	}
	if (result.isError) {
		throw new McpToolError(texts.join("\n") || "MCP tool returned an error");
	}
	if (result.structuredContent !== undefined) return result.structuredContent;
	if (texts.length > 0) return texts.join("\n");
	if (content.length > 0) return content;
	return result;
}

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeDiagnostic(
	raw: string,
	secrets: readonly string[],
	privateValues: readonly string[] = [],
	byteLimit = STDERR_BYTE_LIMIT,
): string {
	let value = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, " ");
	value = value.replace(ANSI_ESCAPE_RE, "").replace(CONTROL_CHAR_RE, "");
	for (const secret of secrets) {
		if (secret) value = value.replaceAll(secret, "[REDACTED]");
	}
	for (const priv of privateValues) {
		if (!priv) continue;
		if (priv.length >= 4) {
			value = value.replaceAll(priv, "[REDACTED]");
		} else {
			value = value.replace(new RegExp(`(?<!\\w)${escapeRegExp(priv)}(?!\\w)`, "g"), "[REDACTED]");
		}
	}
	const lines = value
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.slice(-STDERR_LINE_LIMIT);
	value = lines.join("\n");
	const encoded = Buffer.from(value, "utf8");
	if (encoded.byteLength > byteLimit) {
		value = encoded.subarray(encoded.byteLength - byteLimit).toString("utf8");
	}
	return value.trim();
}

function privateConfigValues(config: Record<string, unknown>): string[] {
	const values = new Set<string>();
	const collect = (val: unknown): void => {
		if (typeof val === "string") {
			if (val) values.add(val);
		} else if (Array.isArray(val)) {
			for (const item of val) collect(item);
		} else if (isRecord(val)) {
			for (const [k, v] of Object.entries(val)) {
				collect(k);
				collect(v);
			}
		}
	};
	for (const key of ["command", "args", "cwd", "url", "headers", "env", "bearerTokenEnvVar"]) {
		collect(config[key]);
	}
	return [...values].sort((a, b) => b.length - a.length);
}

function stdioEnv(config: Record<string, unknown>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of SAFE_ENV) {
		const val = process.env[key];
		if (val !== undefined) env[key] = val;
	}
	const raw = config.env ?? {};
	if (!isRecord(raw)) {
		throw new Error("MCP stdio env must be an object");
	}
	if (config.credentialSource === "acp") {
		for (const [k, v] of Object.entries(raw)) {
			if (typeof v !== "string") throw new Error("ACP MCP stdio env must contain string values");
			env[k] = v;
		}
		return env;
	}
	for (const [key, ref] of Object.entries(raw)) {
		if (!isRecord(ref) || Object.keys(ref).length !== 1 || typeof ref.env !== "string") {
			throw new Error('MCP stdio env values must use {"env": "NAME"} references');
		}
		const source = ref.env;
		if (!(source in process.env) || process.env[source] === undefined) {
			throw new Error(`MCP stdio environment reference for '${key}' is unavailable`);
		}
		env[key] = process.env[source]!;
	}
	return env;
}

async function resolveAuthIdentity(server: string, config: Record<string, unknown>): Promise<string> {
	if (config.credentialSource === "static-token") {
		const token = staticToken(server, config);
		if (!token) throw credentialsUnavailable(server);
		return createHash("sha256").update(token).digest("hex");
	}
	const envName = typeof config.bearerTokenEnvVar === "string" ? config.bearerTokenEnvVar : undefined;
	let token = envName ? (process.env[envName] ?? "").trim() : "";
	if (config.oauth === true && !token) {
		const provider = `mcp:${server}`;
		let cred = boundAuth(provider, config);
		const expires = cred?.expires;
		if (typeof expires === "number" && expires <= Date.now() + EXPIRY_SKEW_MS) {
			try {
				await hostRequest("mcp.refresh", { server });
			} catch (err) {
				throw new Error(`Could not refresh MCP credentials for '${server}'`, { cause: err });
			}
			cred = boundAuth(provider, config);
		}
		token = resolveConfigValue(String(cred?.access ?? cred?.key ?? ""));
	}
	if (!token) {
		if (config.oauth === true || envName) throw credentialsUnavailable(server);
		return "anonymous";
	}
	return createHash("sha256").update(token).digest("hex");
}

async function resolveHeaders(server: string, config: Record<string, unknown>): Promise<Record<string, string>> {
	const raw = config.headers ?? {};
	if (!isRecord(raw) || !Object.values(raw).every((v) => typeof v === "string")) {
		throw new Error("MCP HTTP headers must contain strings");
	}
	const headers: Record<string, string> = { ...(raw as Record<string, string>) };
	if (config.credentialSource === "acp") return headers;
	if (config.credentialSource === "static-token") {
		const token = staticToken(server, config);
		if (!token) throw credentialsUnavailable(server);
		headers.Authorization = `Bearer ${token}`;
		return headers;
	}
	const envName = typeof config.bearerTokenEnvVar === "string" ? config.bearerTokenEnvVar : undefined;
	let token = envName ? (process.env[envName] ?? "").trim() : "";
	if (config.oauth === true && !token) {
		const cred = boundAuth(`mcp:${server}`, config);
		token = resolveConfigValue(String(cred?.access ?? cred?.key ?? ""));
	}
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	} else if (config.oauth === true || envName) {
		throw credentialsUnavailable(server);
	}
	return headers;
}

async function loadServerConfig(server: string): Promise<Record<string, unknown>> {
	let config: Record<string, unknown>;
	try {
		config = await withTimeout(
			hostRequest("mcp.config", { server }),
			DEFAULT_STARTUP_TIMEOUT_MS,
			`Timed out loading MCP configuration for '${server}'`,
		);
	} catch (err) {
		throw new Error(`Could not load MCP configuration for '${server}'`, { cause: err });
	}
	if (!isRecord(config) || Object.keys(config).length === 0) {
		throw new Error(`MCP server '${server}' is not declared in user settings`);
	}
	if (config.enabled === false) {
		throw new Error(`MCP server '${server}' is disabled`);
	}
	if (config.type === "http") {
		const copy = { ...config };
		if (copy.credentialSource !== "acp") {
			copy._authIdentity = await resolveAuthIdentity(server, copy);
		}
		return copy;
	}
	return config;
}

function validateName(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !value) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
}

function validateLimit(value: unknown, label: string, maximum: number): void {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
		throw new RangeError(`${label} must be an integer between 1 and ${maximum}`);
	}
}

function validateCursor(value: unknown): void {
	if (typeof value !== "string" || !value || value.length > MAX_CURSOR_CHARS) {
		throw new RangeError(`cursor must be a non-empty string of at most ${MAX_CURSOR_CHARS} characters`);
	}
}

class AsyncMutex {
	private chain: Promise<void> = Promise.resolve();
	async run<T>(fn: () => Promise<T>): Promise<T> {
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prev = this.chain;
		this.chain = prev.then(() => next);
		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

class Generation {
	readonly server: string;
	readonly config: Record<string, unknown>;
	readonly configKey: string;
	readonly startupTimeoutMs: number;
	readonly callTimeoutMs: number;
	client: Client | null = null;
	tools = new Map<string, McpToolMetadata>();
	closed = false;

	private callMutex = new AsyncMutex();
	private stderrChunks: string[] = [];
	private stderrCapture = true;
	private stderrSecrets: string[] = [];
	private stderrDisclosable = true;
	private diagnosticPrivateValues: string[] = [];

	constructor(server: string, config: Record<string, unknown>) {
		this.server = server;
		this.config = config;
		this.configKey = JSON.stringify(config);
		this.startupTimeoutMs = parseTimeoutMs(config.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
		this.callTimeoutMs = parseTimeoutMs(config.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);
	}

	async open(): Promise<void> {
		const kind = this.config.type;
		let transport: StreamableHTTPClientTransport | StdioClientTransport;
		if (kind === "http") {
			const url = this.config.url;
			if (typeof url !== "string" || !url) {
				throw new Error(`MCP server '${this.server}' requires a URL`);
			}
			const headers = await resolveHeaders(this.server, this.config);
			transport = new StreamableHTTPClientTransport(new URL(url), {
				requestInit: { headers, redirect: "manual" },
			});
		} else if (kind === "stdio") {
			const command = this.config.command;
			const args = this.config.args ?? [];
			const cwd = this.config.cwd;
			if (
				typeof command !== "string" ||
				!command ||
				!Array.isArray(args) ||
				!args.every((a) => typeof a === "string")
			) {
				throw new Error(`MCP server '${this.server}' requires command and string args`);
			}
			if (cwd !== undefined && cwd !== null && typeof cwd !== "string") {
				throw new Error(`MCP server '${this.server}' cwd must be a string`);
			}
			const env = stdioEnv(this.config);
			const rawEnv = isRecord(this.config.env) ? this.config.env : {};
			const configuredValues = Object.keys(rawEnv)
				.map((k) => env[k])
				.filter((v): v is string => typeof v === "string");
			this.stderrDisclosable = !configuredValues.some((v) => v.length > 0 && v.length < 4);
			this.stderrSecrets = [...new Set(configuredValues.filter((v) => v.length >= 4))].sort(
				(a, b) => b.length - a.length,
			);
			this.diagnosticPrivateValues = [...privateConfigValues(this.config), process.cwd()];
			transport = new StdioClientTransport({
				command,
				args: args as string[],
				cwd: typeof cwd === "string" ? cwd : undefined,
				env,
				stderr: "pipe",
			});
			transport.stderr?.on("data", (chunk: Buffer) => {
				if (!this.stderrCapture) return;
				this.stderrChunks.push(chunk.toString("utf8"));
				let joined = this.stderrChunks.join("");
				if (Buffer.byteLength(joined, "utf8") > STDERR_BYTE_LIMIT) {
					joined = Buffer.from(joined, "utf8").subarray(-STDERR_BYTE_LIMIT).toString("utf8");
					this.stderrChunks = [joined];
				}
			});
		} else {
			throw new Error(`MCP server '${this.server}' has unsupported transport ${JSON.stringify(kind)}`);
		}

		const client = new Client({ name: "prime-agent-bun-repl", version: "0.10.5" });
		this.client = client;
		try {
			await withTimeout(
				(async () => {
					await client.connect(transport);
					await this.discover();
				})(),
				this.startupTimeoutMs,
				`MCP server '${this.server}' startup timed out after ${this.startupTimeoutMs}ms`,
			);
			this.stderrCapture = false;
			this.stderrChunks = [];
		} catch (error) {
			await this.close().catch(() => undefined);
			if (kind === "stdio" && !(error instanceof McpDiscoveryError)) {
				throw this.makeStartupError(error);
			}
			throw error;
		}
	}

	private makeStartupError(error: unknown): McpStartupError {
		const errName = error instanceof Error ? error.name : "Error";
		const errMsg = error instanceof Error ? error.message : String(error);
		const original = this.stderrDisclosable
			? sanitizeDiagnostic(`${errName}: ${errMsg}`, this.stderrSecrets, this.diagnosticPrivateValues, 1024) ||
				errName
			: `${errName}: details omitted for safe redaction`;
		const stderr = this.stderrDisclosable
			? sanitizeDiagnostic(this.stderrChunks.join(""), this.stderrSecrets, this.diagnosticPrivateValues)
			: "";
		const detail = stderr ? ` Stderr tail:\n${stderr}` : "";
		return new McpStartupError(`MCP stdio server failed during startup (${original}).${detail}`);
	}

	async discover(): Promise<void> {
		if (!this.client) throw new Error("MCP client is not connected");
		const tools = new Map<string, McpToolMetadata>();
		const seenCursors = new Set<string>();
		let cursor: string | undefined;
		let pages = 0;
		while (true) {
			const response = cursor ? await this.client.listTools({ cursor }) : await this.client.listTools();
			pages += 1;
			for (const tool of response.tools ?? []) {
				if (typeof tool.name !== "string") continue;
				tools.set(tool.name, {
					name: tool.name,
					description: typeof tool.description === "string" ? tool.description : "",
					inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : {},
				});
			}
			const nextCursor = response.nextCursor;
			if (nextCursor === undefined || nextCursor === null) break;
			if (typeof nextCursor !== "string" || !nextCursor) {
				throw new McpDiscoveryError(
					`MCP server '${this.server}' returned a malformed tools/list pagination cursor`,
				);
			}
			if (seenCursors.has(nextCursor)) {
				throw new McpDiscoveryError(
					`MCP server '${this.server}' repeated a tools/list pagination cursor; its tool inventory cannot be completed`,
				);
			}
			if (pages >= MAX_TOOL_PAGES) {
				throw new McpDiscoveryError(
					`MCP server '${this.server}' paginated tools/list beyond ${MAX_TOOL_PAGES} pages; refusing to publish a partial tool inventory`,
				);
			}
			seenCursors.add(nextCursor);
			cursor = nextCursor;
		}
		this.tools = tools;
	}

	allows(tool: string): boolean {
		const enabled = this.config.enabledTools;
		const disabled = this.config.disabledTools;
		if (Array.isArray(enabled) && !enabled.includes(tool)) return false;
		if (Array.isArray(disabled) && disabled.includes(tool)) return false;
		return true;
	}

	async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.allows(tool)) {
			throw new Error(`MCP tool '${tool}' is disabled for server '${this.server}'`);
		}
		if (!this.tools.has(tool)) {
			throw new Error(`MCP server '${this.server}' has no tool '${tool}'`);
		}
		return this.callMutex.run(async () => {
			if (!this.client) throw new Error(`MCP server '${this.server}' is closed`);
			const result = await withTimeout(
				this.client.callTool({ name: tool, arguments: args }),
				this.callTimeoutMs,
				`MCP tool '${tool}' on '${this.server}' timed out after ${this.callTimeoutMs}ms`,
			);
			return parseToolResult(result as CallToolResult);
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const client = this.client;
		this.client = null;
		if (client) {
			await withTimeout(client.close(), SHUTDOWN_TIMEOUT_MS, "MCP client close timed out").catch(() => undefined);
		}
	}
}

class McpRegistry {
	private generations = new Map<string, Generation>();
	private locks = new Map<string, AsyncMutex>();
	private state: "open" | "shutting_down" | "shut_down" = "open";
	private shutdownPromise: Promise<void> | null = null;

	private assertOpen(): void {
		if (this.state !== "open") {
			throw new Error(`MCP registry is ${this.state.replace(/_/g, " ")}`);
		}
	}

	private lockFor(server: string): AsyncMutex {
		let lock = this.locks.get(server);
		if (!lock) {
			lock = new AsyncMutex();
			this.locks.set(server, lock);
		}
		return lock;
	}

	private async getLocked(server: string): Promise<Generation> {
		this.assertOpen();
		const current = this.generations.get(server);
		const config = await loadServerConfig(server);
		this.assertOpen();
		const configKey = JSON.stringify(config);
		if (current && current.configKey === configKey && !current.closed) {
			return current;
		}
		if (current) {
			await current.close();
			if (this.generations.get(server) === current) {
				this.generations.delete(server);
			}
		}
		this.assertOpen();
		const generation = new Generation(server, config);
		this.generations.set(server, generation);
		try {
			await generation.open();
		} catch (error) {
			if (this.generations.get(server) === generation) {
				this.generations.delete(server);
			}
			throw error;
		}
		return generation;
	}

	async get(server: string): Promise<Generation> {
		this.assertOpen();
		validateName(server, "server");
		return this.lockFor(server).run(() => this.getLocked(server));
	}

	async tools(server: string): Promise<McpToolMetadata[]> {
		const gen = await this.get(server);
		const list: McpToolMetadata[] = [];
		for (const [name, tool] of gen.tools) {
			if (gen.allows(name)) list.push(structuredClone(tool));
		}
		return list;
	}

	async search(server: string, query: string, limit: number): Promise<Array<{ connectionId: string; name: string; description: string }>> {
		const gen = await this.get(server);
		const needle = query.toLowerCase();
		const matches: Array<{ connectionId: string; name: string; description: string }> = [];
		for (const [name, tool] of gen.tools) {
			if (!gen.allows(name)) continue;
			const haystack = `${name}\n${tool.description}`.toLowerCase();
			if (!haystack.includes(needle)) continue;
			matches.push({ connectionId: gen.server, name, description: tool.description });
			if (matches.length >= limit) break;
		}
		return matches;
	}

	async describe(server: string, tool: string): Promise<McpToolMetadata> {
		const gen = await this.get(server);
		const found = gen.tools.get(tool);
		if (!found) throw new Error(`MCP server '${server}' has no tool '${tool}'`);
		if (!gen.allows(tool)) throw new Error(`MCP tool '${tool}' is disabled for server '${server}'`);
		return structuredClone(found);
	}

	async call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
		this.assertOpen();
		validateName(server, "server");
		return this.lockFor(server).run(async () => {
			const gen = await this.getLocked(server);
			return gen.call(tool, args);
		});
	}

	async reload(server?: string): Promise<void> {
		this.assertOpen();
		const names =
			server !== undefined ? [server] : [...new Set([...this.locks.keys(), ...this.generations.keys()])];
		await Promise.all(
			names.map((name) =>
				this.lockFor(name).run(async () => {
					const gen = this.generations.get(name);
					if (gen) {
						await gen.close();
						if (this.generations.get(name) === gen) this.generations.delete(name);
					}
				}),
			),
		);
	}

	async shutdown(): Promise<void> {
		if (this.state === "shut_down") return;
		if (!this.shutdownPromise) {
			this.state = "shutting_down";
			this.shutdownPromise = (async () => {
				const gens = [...this.generations.values()];
				this.generations.clear();
				await withTimeout(
					Promise.allSettled(gens.map((g) => g.close())),
					SHUTDOWN_TIMEOUT_MS,
					"MCP shutdown timed out",
				).catch(() => undefined);
				this.state = "shut_down";
			})();
		}
		await this.shutdownPromise;
	}
}

const registry = new McpRegistry();

function sanitizeInventoryValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeInventoryValue);
	if (isRecord(value)) return sanitizeInventoryEntry(value);
	return value;
}

function sanitizeInventoryEntry(entry: Record<string, unknown>): Record<string, unknown> {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry)) {
		if (SECRET_KEY_RE.test(key)) continue;
		cleaned[key] = sanitizeInventoryValue(value);
	}
	return cleaned;
}

async function hostInventory(requestType: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	let outcome: string | null = null;
	let result: Record<string, unknown> | undefined;
	try {
		result = await withTimeout(
			hostRequest(requestType, payload),
			INVENTORY_TIMEOUT_MS,
			`MCP ${requestType} request timed out`,
		);
	} catch (error) {
		outcome = error instanceof Error && error.message.includes("timed out") ? "timed out" : "failed";
	}
	if (outcome !== null) {
		throw new Error(`MCP ${requestType} request ${outcome}`);
	}
	if (!isRecord(result)) {
		throw new Error(`MCP ${requestType} returned a malformed response`);
	}
	return result;
}

function inventoryEntries(result: Record<string, unknown>, key: string): Record<string, unknown>[] {
	const entries = result[key];
	if (!Array.isArray(entries) || !entries.every(isRecord)) {
		throw new Error(`MCP ${key} inventory from the host is malformed`);
	}
	return entries;
}

function pluginPage(result: Record<string, unknown>): { plugins: Record<string, unknown>[]; nextCursor: string | null } {
	const entries = inventoryEntries(result, "plugins");
	const nextCursor = result.nextCursor ?? null;
	if (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor)) {
		throw new Error("MCP plugin inventory from the host is malformed");
	}
	return {
		plugins: entries.map(sanitizeInventoryEntry),
		nextCursor,
	};
}

function boundedError(error: unknown): string {
	const name = error instanceof Error ? error.name : "Error";
	if (error instanceof McpCredentialsUnavailable) {
		return `${name}: credentials for this connection are not available; the user must connect it`;
	}
	if (error instanceof McpStartupError) {
		return `${name}: the MCP server failed during startup`;
	}
	if (error instanceof Error && error.message.includes("timed out")) {
		return `${name}: opening or querying the connection timed out`;
	}
	return `${name}: the connection could not be opened or searched`;
}

export async function listTools(server: string): Promise<McpToolMetadata[]> {
	return registry.tools(server);
}

export async function callTool(
	server: string,
	tool: string,
	args?: Record<string, unknown> | null,
): Promise<unknown> {
	validateName(tool, "tool");
	if (args !== undefined && args !== null && !isRecord(args)) {
		throw new TypeError("arguments must be an object or null/undefined");
	}
	return registry.call(server, tool, args ?? {});
}

export async function reload(server?: string): Promise<void> {
	if (server !== undefined) validateName(server, "server");
	await registry.reload(server);
}

export async function close(): Promise<void> {
	await registry.shutdown();
}

export async function status(servers: string[], timeoutMs = 10_000): Promise<McpStatusRow[]> {
	const timeout = Math.max(timeoutMs, 1);
	return Promise.all(
		servers.map(async (server): Promise<McpStatusRow> => {
			try {
				const tools = await withTimeout(
					listTools(server),
					timeout,
					`TimeoutError: listing tools for '${server}' timed out after ${timeout}ms`,
				);
				return {
					server,
					tools: tools.map((t) => ({ name: t.name, description: t.description || "" })),
					error: null,
				};
			} catch (error) {
				const name = error instanceof Error ? error.name : "Error";
				const message = error instanceof Error ? error.message : String(error);
				return {
					server,
					tools: null,
					error: `${name}: ${message}`,
				};
			}
		}),
	);
}

export async function listConnections(): Promise<Record<string, unknown>[]> {
	const result = await hostInventory("mcp.list_connections", {});
	const connections = inventoryEntries(result, "connections");
	for (const entry of connections) {
		if (typeof entry.connectionId !== "string" || !entry.connectionId) {
			throw new Error("MCP connection inventory from the host is malformed");
		}
	}
	return connections.map(sanitizeInventoryEntry);
}

export async function listPlugins(options?: {
	connectionStatus?: string;
	limit?: number;
	cursor?: string;
}): Promise<{ plugins: Record<string, unknown>[]; nextCursor: string | null }> {
	const connectionStatus = options?.connectionStatus;
	const limit = options?.limit ?? DEFAULT_PLUGIN_LIMIT;
	const cursor = options?.cursor;
	if (connectionStatus !== undefined && !PLUGIN_CONNECTION_STATUSES.has(connectionStatus)) {
		throw new RangeError("connectionStatus must be undefined, 'connected' or 'not_connected'");
	}
	validateLimit(limit, "limit", MAX_PLUGIN_LIMIT);
	const payload: Record<string, unknown> = { limit };
	if (connectionStatus !== undefined) payload.connectionStatus = connectionStatus;
	if (cursor !== undefined) {
		validateCursor(cursor);
		payload.cursor = cursor;
	}
	const result = await hostInventory("mcp.list_plugins", payload);
	return pluginPage(result);
}

export async function searchPlugins(
	query: string,
	limit = DEFAULT_PLUGIN_SEARCH_LIMIT,
): Promise<{ plugins: Record<string, unknown>[]; nextCursor: string | null }> {
	if (typeof query !== "string" || !query.trim()) {
		throw new TypeError("query must be a non-empty string");
	}
	validateLimit(limit, "limit", MAX_PLUGIN_SEARCH_LIMIT);
	const result = await hostInventory("mcp.search_plugins", { query: query.trim(), limit });
	return pluginPage(result);
}

export async function searchTools(
	query: string,
	options?: { connectionId?: string; limit?: number } | string,
	limitArg?: number,
): Promise<{
	tools: Array<{ connectionId: string; name: string; description: string }>;
	searched: string[];
	unavailable: Array<{ connectionId: string; error: string }>;
	truncated: boolean;
}> {
	if (typeof query !== "string" || !query.trim()) {
		throw new TypeError("query must be a non-empty string");
	}
	const opts = typeof options === "string" ? { connectionId: options, limit: limitArg } : (options ?? {});
	const limit = opts.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
	validateLimit(limit, "limit", MAX_TOOL_SEARCH_LIMIT);
	const needle = query.trim();

	if (opts.connectionId !== undefined) {
		validateName(opts.connectionId, "connection");
		const tools = await registry.search(opts.connectionId, needle, limit);
		return {
			tools,
			searched: [opts.connectionId],
			unavailable: [],
			truncated: tools.length >= limit,
		};
	}

	const connections = await listConnections();
	const candidates = connections
		.filter((entry) => entry.status === "connected")
		.map((entry) => String(entry.connectionId));
	const scoped = candidates.slice(0, MAX_TOOL_SEARCH_SERVERS);
	const tools: Array<{ connectionId: string; name: string; description: string }> = [];
	const searched: string[] = [];
	const unavailable: Array<{ connectionId: string; error: string }> = [];

	for (const connection of scoped) {
		try {
			const found = await registry.search(connection, needle, limit);
			searched.push(connection);
			if (tools.length < limit) {
				tools.push(...found.slice(0, limit - tools.length));
			}
		} catch (error) {
			unavailable.push({ connectionId: connection, error: boundedError(error) });
		}
	}

	return {
		tools,
		searched,
		unavailable,
		truncated: tools.length >= limit || candidates.length > scoped.length,
	};
}

export async function describeTool(connectionId: string, tool: string): Promise<McpToolMetadata> {
	validateName(connectionId, "connection");
	validateName(tool, "tool");
	return registry.describe(connectionId, tool);
}

export const mcpNamespace = Object.freeze({
	listTools,
	callTool,
	listPlugins,
	searchPlugins,
	listConnections,
	searchTools,
	describeTool,
	reload,
	close,
	status,
	McpCredentialsUnavailable,
	McpDiscoveryError,
	McpStartupError,
	McpToolError,
});
