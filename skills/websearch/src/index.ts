import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { asRecord, requireString, type SkillContext } from "../../_shared/context.ts";

type WebSearchProvider = "serper" | "eco";

interface ProviderConfig {
	keyEnv: string;
	name: string;
	signupUrl: string;
}

interface SearchOptions {
	maxOutput?: number;
	timeout?: number;
	numResults?: number;
}

// Per provider id (the host passes the /settings choice as PRIME_AGENT_WEBSEARCH_PROVIDER;
// the id is also the key's auth.json slot): the key's env var, the provider's name (its
// /mcp row is "<name> (web search)"), and where to get a key.
const PROVIDERS: Record<WebSearchProvider, ProviderConfig> = {
	serper: {
		keyEnv: "SERPER_API_KEY",
		name: "Serper",
		signupUrl: "https://serper.dev",
	},
	eco: {
		keyEnv: "YOU_API_KEY",
		name: "You.com Eco",
		signupUrl: "https://you.com/platform",
	},
};

function resolveProvider(): WebSearchProvider {
	const raw = process.env.PRIME_AGENT_WEBSEARCH_PROVIDER?.trim();
	if (!raw || raw === "serper") return "serper";
	if (raw === "eco") return "eco";
	throw new Error(`Unsupported web search provider: ${raw}`);
}

function environmentInteger(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) ? value : fallback;
}

function agentDir(): string {
	const configured =
		process.env.PRIME_AGENT_CODING_AGENT_DIR ||
		process.env.PI_CODING_AGENT_DIR ||
		resolve(homedir(), ".prime", "agent");
	return resolve(configured.replace(/^~(?=\/|$)/, homedir()));
}

function resolveConfigValue(value: string): string {
	// Stored keys may be a literal or an env-var name; "!command" refs can't be run
	// safely here, so skip them (the host injects those resolved at session start).
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("!")) return "";
	return (process.env[trimmed] || trimmed).trim();
}

async function resolveApiKey(provider: WebSearchProvider): Promise<string> {
	// Read auth.json on each call (not just the injected env var) so a key added
	// via /mcp after the kernel started is still picked up. Env var wins.
	const { keyEnv } = PROVIDERS[provider];
	const environmentKey = process.env[keyEnv]?.trim();
	if (environmentKey) return environmentKey;
	try {
		const auth = asRecord(JSON.parse(await readFile(resolve(agentDir(), "auth.json"), "utf8")));
		const credential = asRecord(auth[provider]);
		if (credential.type === "api_key") {
			return resolveConfigValue(String(credential.key ?? ""));
		}
	} catch {
		return "";
	}
	return "";
}

function formatSerperResults(data: Record<string, unknown>, query: string, numResults: number): string {
	const sections: string[] = [];
	const graph = asRecord(data.knowledgeGraph);
	if (Object.keys(graph).length > 0) {
		const lines: string[] = [];
		const title = String(graph.title ?? "").trim();
		const description = String(graph.description ?? "").trim();
		if (title) lines.push(`Knowledge Graph: ${title}`);
		if (description) lines.push(description);
		for (const [key, value] of Object.entries(asRecord(graph.attributes))) {
			const text = String(value).trim();
			if (text) lines.push(`${key}: ${text}`);
		}
		if (lines.length > 0) sections.push(lines.join("\n"));
	}

	const organic = Array.isArray(data.organic) ? data.organic.slice(0, numResults) : [];
	organic.forEach((raw, index) => {
		const result = asRecord(raw);
		const lines = [`Result ${index}: ${String(result.title ?? "").trim() || "Untitled"}`];
		const link = String(result.link ?? "").trim();
		const snippet = String(result.snippet ?? "").trim();
		if (link) lines.push(`URL: ${link}`);
		if (snippet) lines.push(snippet);
		sections.push(lines.join("\n"));
	});

	const questions = Array.isArray(data.peopleAlsoAsk) ? data.peopleAlsoAsk.slice(0, 3) : [];
	const formattedQuestions = questions.flatMap((raw) => {
		const item = asRecord(raw);
		const question = String(item.question ?? "").trim();
		if (!question) return [];
		const answer = String(item.snippet ?? "").trim();
		return [`Q: ${question}${answer ? `\nA: ${answer}` : ""}`];
	});
	if (formattedQuestions.length > 0) sections.push(`People Also Ask:\n${formattedQuestions.join("\n")}`);
	return sections.length > 0 ? sections.join("\n\n---\n\n") : `No results returned for query: ${query}`;
}

function formatEcoResults(data: Record<string, unknown>, query: string, numResults: number): string {
	const web = asRecord(data.results).web;
	const organic = Array.isArray(web)
		? web.map((raw) => {
				const item = asRecord(raw);
				return {
					title: item.title,
					link: item.url,
					snippet: item.description,
				};
			})
		: [];
	return formatSerperResults({ organic }, query, numResults);
}

async function fetchSerper(query: string, apiKey: string, timeout: number, numResults: number): Promise<string> {
	const response = await fetch("https://google.serper.dev/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-KEY": apiKey,
		},
		body: JSON.stringify({ q: query }),
		signal: AbortSignal.timeout(timeout * 1000),
	});
	if (!response.ok) {
		throw new Error(`Serper search error (${response.status}): ${await response.text()}`);
	}
	return formatSerperResults(asRecord(await response.json()), query, numResults);
}

async function fetchEco(query: string, apiKey: string, timeout: number, numResults: number): Promise<string> {
	const url = new URL("https://ydc-index.io/v1/eco_search");
	url.searchParams.set("query", query);
	const response = await fetch(url, {
		method: "GET",
		headers: { "X-API-Key": apiKey },
		signal: AbortSignal.timeout(timeout * 1000),
	});
	if (!response.ok) {
		throw new Error(`Eco search error (${response.status}): ${await response.text()}`);
	}
	return formatEcoResults(asRecord(await response.json()), query, numResults);
}

export function createSkill(_context: SkillContext) {
	return async (query: string, options: SearchOptions = {}): Promise<string> => {
		requireString(query, "query");
		const provider = resolveProvider();
		const apiKey = await resolveApiKey(provider);
		if (!apiKey) {
			const { name, signupUrl } = PROVIDERS[provider];
			return (
				`Web search is not set up yet: no ${name} API key is configured.\n` +
				"Tell the user how to enable it:\n" +
				`  1. Get a free API key at ${signupUrl} (sign up, copy the key).\n` +
				`  2. In Prime Agent, run /mcp, choose "${name} (web search)", and paste the key.\n` +
				"Do not ask the user to set environment variables. Once the key is saved, web search works automatically."
			);
		}
		const maxOutput = options.maxOutput ?? 8192;
		const timeout = options.timeout ?? environmentInteger("PRIME_AGENT_WEBSEARCH_TIMEOUT", 45);
		const numResults = options.numResults ?? environmentInteger("PRIME_AGENT_WEBSEARCH_NUM_RESULTS", 5);
		let result: string;
		try {
			const fetcher = provider === "eco" ? fetchEco : fetchSerper;
			result = await fetcher(query, apiKey, timeout, numResults);
		} catch (error) {
			result = `Error searching for '${query}': ${error instanceof Error ? error.message : String(error)}`;
		}
		let output = `Results for query "${query}":\n\n${result}`;
		if (output.length > maxOutput) {
			const marker = `\n... [output truncated, ${output.length} chars total] ...\n`;
			const half = Math.max(0, Math.floor((maxOutput - marker.length) / 2));
			output = `${output.slice(0, half)}${marker}${output.slice(output.length - half)}`;
			if (output.length > maxOutput) {
				output = output.slice(0, maxOutput);
			}
		}
		return output;
	};
}
