import { describe, expect, test } from "vitest";
import { buildRlmPrompt } from "../src/core/prompts/index.js";
import type { HarnessState } from "../src/core/refinement/index.js";
import type { Skill } from "../src/core/skills.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import { createJavaScriptToolDefinition } from "../src/core/tools/javascript.js";

function skill(name: string): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: {
			source: "local",
			path: `/skills/${name}/SKILL.md`,
			scope: "project",
			origin: "top-level",
		},
		disableModelInvocation: false,
		kind: "markdown",
	};
}

function javaScriptSkill(
	name: string,
	globalName = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
): Skill {
	const base = skill(name);
	return {
		...base,
		kind: "javascript",
		javascript: {
			entryPath: `/skills/${name}/src/index.ts`,
			globalName,
			packageJsonPath: `/skills/${name}/package.json`,
			packagePath: `/skills/${name}`,
		},
	};
}

describe("buildRlmPrompt", () => {
	test("documents the persistent Bun control environment", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.prime/sessions/session.jsonl",
			installedSkills: ["websearch", "refine"],
			activeTools: ["javascript"],
			allowRecursion: false,
		});

		expect(prompt).toContain("Working directory: /repo");
		expect(prompt).toContain("Conversation log: /repo/.prime/sessions/session.jsonl");
		expect(prompt).toContain("Runtime: Bun 1.3.14 or newer");
		expect(prompt).toContain("Installed JavaScript skill globals (prepared): `websearch`, `refine`.");
		expect(prompt).toContain("Bun is the agent's long-lived JavaScript notebook");
		expect(prompt).toContain("await sh(command)");
		expect(prompt).toContain("await installPackage('pkg')");
		expect(prompt).toContain("process.chdir(dir)");
		expect(prompt).toContain("JavaScript state persists across cells");
		expect(prompt).toContain("Continual harness state is available as `rlm.harness`");
		expect(prompt).toContain("installed JavaScript skills are prepared as globals");
		expect(prompt).not.toMatch(/Python packages|Python REPL|%%bash|uv pip/);
	});

	test("defaults omitted activeTools to JavaScript guidance", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["websearch"],
		});

		expect(prompt).toContain("Installed JavaScript skill globals (prepared): `websearch`.");
		expect(prompt).toContain("A callable `rlm` is already in your global namespace");
		expect(prompt).toContain("Bun is the agent's long-lived JavaScript notebook");
	});

	test("discovers requested models through a bounded authenticated host search", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			activeTools: ["javascript"],
		});

		expect(prompt).toContain("await rlm.findModels(...)");
		expect(prompt).toContain("exact returned selector");
		expect(prompt).toContain("An unavailable requested model fails spawn");
	});

	test("omits notebook doctrine when JavaScript is inactive", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["bash"],
			allowRecursion: false,
		});

		expect(prompt).not.toContain("Installed skills available as shell commands");
		expect(prompt).not.toContain("`<skill> --help`");
		expect(prompt).not.toContain("Bun is the agent's long-lived JavaScript notebook");
		expect(prompt).not.toContain("Installed JavaScript skill globals");
	});

	test("gates messaging and observation doctrine on prepared skills", () => {
		const withoutCapabilities = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			activeTools: ["javascript"],
			allowRecursion: true,
			depth: 1,
		});
		expect(withoutCapabilities).not.toContain("agentMessage.send");
		expect(withoutCapabilities).not.toContain("agentObserve");

		const withCapabilities = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["agentMessage", "agentObserve"],
			activeTools: ["javascript"],
			allowRecursion: true,
			depth: 1,
		});
		expect(withCapabilities).toContain("agentMessage.send");
		expect(withCapabilities).toContain("agentMessage.listAgents");
		expect(withCapabilities).toContain("agentObserve");
		expect(withCapabilities).toContain("restricted to your parent, siblings, and direct children");
	});

	test("documents the automatic child registry independently of observation", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			activeTools: ["javascript"],
		});

		expect(prompt).toContain("await rlm.listSubagents()");
		expect(prompt).toContain("await rlm.deleteSubagent(child)");
		expect(prompt).toContain("recover direct child handles");
	});

	test("includes JavaScript edit guidance only when edit is installed", () => {
		const withEdit = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["edit"],
			activeTools: ["javascript"],
			allowRecursion: false,
		});
		expect(withEdit).toContain("await edit({ path: 'pkg/file.ts', oldStr, newStr })");

		const withoutEdit = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["javascript"],
			allowRecursion: false,
		});
		expect(withoutEdit).not.toContain("await edit({ path:");
	});
});

function harnessState(): HarnessState {
	return {
		schema: 1,
		entries: {
			prompt: {
				focused_edits: {
					id: "focused_edits",
					kind: "prompt",
					title: "Focused edits",
					content: "Prefer small prompt, memory, skill, or subagent updates over broad rewrites.",
					path: "policy",
					reference: {},
					arguments: {},
					metadata: {},
					source: "refine",
					created_at: "2026-06-08T00:00:00.000Z",
					updated_at: "2026-06-08T00:00:00.000Z",
					version: 1,
				},
			},
			memory: {
				validation: {
					id: "validation",
					kind: "memory",
					title: "Validation",
					content: "Run `npm run check` after Prime Agent code changes.",
					path: "repo/prime-agent",
					reference: {},
					arguments: {},
					metadata: {},
					source: "refine",
					created_at: "2026-06-08T00:00:00.000Z",
					updated_at: "2026-06-08T00:00:00.000Z",
					version: 2,
				},
			},
			skill: {
				review_refinement: {
					id: "review_refinement",
					kind: "skill",
					title: "Review refinement",
					content: "Check edit coverage, rollback safety, and validation commands.",
					path: "quality",
					reference: {
						type: "javascript",
						global: "reviewRefinement",
						callPattern: "await reviewRefinement(task)",
					},
					arguments: { task: { type: "string", required: true, description: "Review task." } },
					metadata: {},
					source: "refine",
					created_at: "2026-06-08T00:00:00.000Z",
					updated_at: "2026-06-08T00:00:00.000Z",
					version: 1,
				},
			},
			subagent: {
				refinement_reviewer: {
					id: "refinement_reviewer",
					kind: "subagent",
					title: "Refinement reviewer",
					content: "Review proposed harness edits for scope and evidence.",
					path: "review",
					reference: {},
					arguments: {},
					metadata: {},
					source: "refine",
					created_at: "2026-06-08T00:00:00.000Z",
					updated_at: "2026-06-08T00:00:00.000Z",
					version: 1,
				},
			},
		},
		refinements: [
			{
				id: "refine_1",
				trigger: "Observed validation miss",
				changes: ["create memory:validation"],
				evidence: "manual test",
				outcome: "Future runs should name npm run check.",
				created_at: "2026-06-08T00:00:00.000Z",
			},
		],
	};
}

describe("buildSystemPrompt", () => {
	test("injects compact harness context and JavaScript refinement guidance", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["javascript"],
			contextFiles: [],
			skills: [
				javaScriptSkill("refine", "refine"),
				javaScriptSkill("agent-message", "agentMessage"),
				javaScriptSkill("agent-observe", "agentObserve"),
			],
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			harnessState: harnessState(),
		});

		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("When to call `await refine.run()`");
		expect(prompt).toContain("Call contract: read each installed JavaScript skill's SKILL.md");
		expect(prompt).toContain("Continual harness skill entries use an explicit JavaScript `reference`");
		expect(prompt).toContain("const handle = await rlm('sub-task')");
		expect(prompt).toContain("receiverRole: 'parent'");
		expect(prompt).toContain("await rlm.listSubagents()");
		expect(prompt).toContain("receiverRole: 'child'");
		expect(prompt).toContain("[global:focused_edits] Focused edits (policy, v1)");
		expect(prompt).toContain("[global:validation] Validation (repo/prime-agent, v2)");
		expect(prompt).toContain("[global:review_refinement] Review refinement (quality, v1)");
		expect(prompt).toContain("[global:refinement_reviewer] Refinement reviewer (review, v1)");
		expect(prompt).toContain("[refine_1] Observed validation miss: create memory:validation");
		expect(prompt).not.toMatch(/Python REPL|asyncio/);
	});

	test("uses the model-agnostic Bun RLM harness prompt", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["javascript"],
			contextFiles: [],
			skills: [javaScriptSkill("agent-message", "agentMessage")],
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
		});

		expect(prompt).toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt).toContain("await rlm('sub-task')");
		expect(prompt).toContain("returns at admission, not completion");
		expect(prompt).toContain("recover direct child handles");
		expect(prompt).toContain("rlm.listSubagents");
		expect(prompt).toContain("rlm.deleteSubagent");
		expect(prompt).toContain("rlmChildId");
		expect(prompt).toContain("name: 'api-reviewer'");
		expect(prompt).toContain("sessionDir");
	});

	test("omits notebook-only harness examples when JavaScript is inactive", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["bash"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			harnessState: harnessState(),
		});

		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("installed JavaScript skill globals are unavailable");
		expect(prompt).not.toContain("Bun is the agent's long-lived JavaScript notebook");
		expect(prompt).not.toContain("await refine.run()");
	});

	test("custom prompts retain harness ordering and child messaging doctrine", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "custom body",
			selectedTools: ["javascript"],
			appendSystemPrompt: "custom append",
			contextFiles: [],
			skills: [javaScriptSkill("agent-message", "agentMessage")],
			cwd: "/repo",
			rlmDepth: 1,
			rlmParentAgent: "orchestrator",
			harnessState: harnessState(),
		});

		expect(prompt).toContain("custom body");
		expect(prompt).toContain("You are a child agent spawned by orchestrator");
		expect(prompt).toContain('await agentMessage.send(message, { receiverRole: "parent" })');
		expect(prompt.indexOf("Current working directory: /repo")).toBeLessThan(
			prompt.indexOf("# Continual Harness State"),
		);
		expect(prompt.indexOf("# Continual Harness State")).toBeLessThan(prompt.indexOf("custom append"));
		expect(prompt).not.toContain("You are a general purpose agent that uses code to solve tasks.");
	});

	test("appends project context and deduplicated guidelines", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["javascript", "dynamic_tool"],
			promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", ""],
			contextFiles: [{ path: "AGENTS.md", content: "project rules" }],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).toContain("# Additional Guidance");
		expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		expect(prompt).toContain("# Project Context");
		expect(prompt).toContain("## AGENTS.md\n\nproject rules");
	});

	test("includes markdown and JavaScript skill metadata", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["javascript"],
			contextFiles: [],
			skills: [skill("notes"), javaScriptSkill("web-search", "webSearch")],
			cwd: "/repo",
		});

		expect(prompt).toContain("<name>notes</name>");
		expect(prompt).toContain("<type>markdown</type>");
		expect(prompt).toContain("<name>web-search</name>");
		expect(prompt).toContain("<type>javascript</type>");
		expect(prompt).toContain("<javascript_global>webSearch</javascript_global>");
		expect(prompt).toContain("Installed JavaScript skill globals (prepared): `webSearch`.");
	});
});

describe("createJavaScriptToolDefinition", () => {
	test("describes target-project checks as target-environment work", () => {
		const tool = createJavaScriptToolDefinition("/repo");

		expect(tool.description).toContain("JavaScript or TypeScript");
		expect(tool.description).toContain("target project's own environment");
		expect(tool.promptSnippet).toContain("persistent Bun notebook");
		const codeSchema = tool.parameters.properties.code;
		const codeDescription =
			"description" in codeSchema && typeof codeSchema.description === "string" ? codeSchema.description : "";
		expect(codeDescription).toContain("target-project commands through that project's own environment");
	});
});
