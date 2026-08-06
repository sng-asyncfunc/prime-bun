import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { asRecord, requireString, type SkillContext } from "../../_shared/context.ts";

interface SearchOptions {
	maxOutput?: number;
	timeout?: number;
	numResults?: number;
}

function environmentInteger(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) ? value : fallback;
}

function agentDir(): string {
	const configured =
		process.env.PRIME_AGENT_CODING_AGENT_DIR ??
		process.env.PI_CODING_AGENT_DIR ??
		resolve(homedir(), ".prime", "agent");
	return resolve(configured.replace(/^~(?=\/|$)/, homedir()));
}

function resolveConfigValue(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("!")) return "";
	return (process.env[trimmed] ?? trimmed).trim();
}

async function resolveApiKey(): Promise<string> {
	const environmentKey = process.env.SERPER_API_KEY?.trim();
	if (environmentKey) return environmentKey;
	try {
		const auth = asRecord(JSON.parse(await readFile(resolve(agentDir(), "auth.json"), "utf8")));
		const credential = asRecord(auth.serper);
		if (credential.type === "api_key") return resolveConfigValue(String(credential.key ?? ""));
	} catch {
		return "";
	}
	return "";
}

function formatResults(data: Record<string, unknown>, query: string, numResults: number): string {
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

export function createSkill(_context: SkillContext) {
	return async (query: string, options: SearchOptions = {}): Promise<string> => {
		requireString(query, "query");
		const apiKey = await resolveApiKey();
		if (!apiKey) {
			return (
				"Web search is not set up yet: no Serper API key is configured.\n" +
				"Tell the user how to enable it:\n" +
				"  1. Get a free API key at https://serper.dev (sign up, copy the key).\n" +
				'  2. In Prime Agent, run /login and choose "Serper (web search)", then paste the key.\n' +
				"Do not ask the user to set environment variables. Once the key is saved, web search works automatically."
			);
		}
		const maxOutput = options.maxOutput ?? 8192;
		const timeout = options.timeout ?? environmentInteger("PRIME_AGENT_WEBSEARCH_TIMEOUT", 45);
		const numResults = options.numResults ?? environmentInteger("PRIME_AGENT_WEBSEARCH_NUM_RESULTS", 5);
		let result: string;
		try {
			const response = await fetch("https://google.serper.dev/search", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
				body: JSON.stringify({ q: query }),
				signal: AbortSignal.timeout(timeout * 1000),
			});
			if (!response.ok) {
				throw new Error(`Serper search error (${response.status}): ${await response.text()}`);
			}
			result = formatResults(asRecord(await response.json()), query, numResults);
		} catch (error) {
			result = `Error searching for '${query}': ${error instanceof Error ? error.message : String(error)}`;
		}
		let output = `Results for query "${query}":\n\n${result}`;
		if (output.length > maxOutput) {
			const marker = `\n... [output truncated, ${output.length} chars total] ...\n`;
			const half = Math.max(0, Math.floor((maxOutput - marker.length) / 2));
			output = `${output.slice(0, half)}${marker}${output.slice(-half)}`.slice(0, maxOutput);
		}
		return output;
	};
}
