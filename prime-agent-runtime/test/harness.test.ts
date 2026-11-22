import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearHarnessStateCache, getHarnessState, harnessQueryTerms } from "../src/harness.ts";

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeTempDir(prefix = "prime-harness-test-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function setEnv(key: string, value: string | undefined): void {
	if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

afterEach(() => {
	clearHarnessStateCache();
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
		delete savedEnv[k];
	}
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("HarnessState", () => {
	test("CRUD across memory, prompt, subagent, skill, and refinements with persistence", () => {
		const agentDir = makeTempDir("agent-");
		const localDir = makeTempDir("local-");
		setEnv("PRIME_AGENT_CODING_AGENT_DIR", agentDir);
		setEnv("RLM_HARNESS_STATE_DIR", localDir);

		const state = getHarnessState();
		const mem = state.createMemory("API Pagination", "Always follow nextCursor until null.", { path: "api" });
		expect(mem.id).toBe("api_pagination");
		expect(mem.version).toBe(1);
		expect(mem.scope).toBe("local");

		const updated = state.updateMemory(mem.id, "API Pagination", "Follow nextCursor up to 25 pages.");
		expect(updated.version).toBe(2);
		expect(updated.path).toBe("api");

		const prompt = state.createPromptNote("Concise Answers", "Keep summaries brief.");
		expect(prompt.path).toBe("policy");

		const sub = state.createSubagent("Reviewer", "Review changed files for bugs.");
		expect(sub.kind).toBe("subagent");

		// JavaScript skill reference validation
		expect(() =>
			state.createSkill("Bad Skill", "Missing ref", {
				reference: { type: "python", import: "foo", callable: "bar" },
			}),
		).toThrow("skill reference.type must be 'javascript'");

		const skill = state.createSkill("Quick Lint", "Run project linter.", {
			reference: { type: "javascript", import: "quickLint", callable: "quickLint.run" },
			arguments: { fix: "boolean" },
		});
		expect(skill.kind).toBe("skill");
		expect(skill.reference.type).toBe("javascript");

		// Refinement event + plan
		const evt = state.recordRefinement("repeated lint failure", ["added quick_lint skill"], {
			evidence: "2 retries",
			outcome: "passed",
		});
		expect(evt.id).toBe("refine_0001");
		const plan = state.planRefinement("timeout on large diff", {
			failingComponent: "review",
			nextStep: "cap diff size",
		});
		expect(plan.length).toBe(4);

		// Overview & snapshot
		const ov = state.overview();
		expect(ov).toContain("[local:api_pagination]");
		expect(ov).toContain("[refine_0001]");
		const snap = state.snapshot();
		expect(snap.scope).toBe("local");

		// Re-load from disk on fresh instance
		clearHarnessStateCache();
		const reloaded = getHarnessState();
		expect(reloaded.get("memory", "local:api_pagination")?.version).toBe(2);
		expect(reloaded.deleteMemory("api_pagination")).toBe(true);
		expect(reloaded.get("memory", "api_pagination")).toBeNull();
	});

	test("search() supports English tf-idf and CJK bigrams", () => {
		const agentDir = makeTempDir("agent-");
		const localDir = makeTempDir("local-");
		setEnv("PRIME_AGENT_CODING_AGENT_DIR", agentDir);
		setEnv("RLM_HARNESS_STATE_DIR", localDir);

		expect(harnessQueryTerms("修复登录 login?")).toEqual(["修复", "复登", "登录", "login"]);

		const state = getHarnessState();
		state.createMemory("Login Outage", "处理登录故障与重试策略", { id: "cjk_login" });
		state.createMemory("Build Guide", "Run bun test before committing", { id: "build_guide" });
		state.createMemory("Another Note", "Generic note about bun workspace", { id: "generic_note" });

		const cjkHits = state.search("修复登录");
		expect(cjkHits.map((e) => e.id)).toEqual(["cjk_login"]);

		const enHits = state.search("committing bun");
		expect(enHits[0]?.id).toBe("build_guide");
	});

	test("createFactory enforces factory.enabled opt-in gate and validates specs", () => {
		const agentDir = makeTempDir("agent-");
		const localDir = makeTempDir("local-");
		setEnv("PRIME_AGENT_CODING_AGENT_DIR", agentDir);
		setEnv("RLM_HARNESS_STATE_DIR", localDir);

		const state = getHarnessState();
		const validDag = {
			nodes: [{ id: "step1", subagent: { prompt: "Do step 1" } }],
		};

		// Disabled by default
		expect(() => state.createFactory("My Flow", "Test flow", { dag: validDag })).toThrow(
			"the factory is disabled; run /factory on to enable it",
		);

		// Enable in settings.json
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ factory: { enabled: true } }));

		// Invalid spec rejected
		expect(() => state.createFactory("Bad Flow", "Invalid", { dag: { nodes: [] } })).toThrow(
			"factory dag must declare between 1 and 1024 nodes",
		);

		// Valid spec accepted
		const entry = state.createFactory("My Flow", "Test flow", { id: "my-flow", dag: validDag });
		expect(entry.kind).toBe("factory");
		expect(entry.arguments.dag).toEqual(validDag);
	});
});
