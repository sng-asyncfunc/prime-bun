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
			activeTools: ["javascript", "write_file", "edit_file"],
			allowRecursion: false,
		});

		expect(prompt).toContain("Working directory: /repo");
		expect(prompt).toContain("Conversation log: /repo/.prime/sessions/session.jsonl");
		expect(prompt).toContain("Runtime: Bun 1.3.14 or newer");
		expect(prompt).toContain("Installed JavaScript skill globals (prepared): `websearch`, `refine`.");
		expect(prompt).toContain("Bun is the agent's long-lived JavaScript notebook");
		expect(prompt).toContain(
			"Default to the `actions` input for independent routine reads, searches, shell commands, and batched work",
		);
		expect(prompt).toContain("`write_file` creates missing parent directories");
		expect(prompt).toContain("Use `edit_file` for exact unique replacements");
		expect(prompt).toContain("Authored document content must not be embedded in JavaScript string literals");
		expect(prompt).toContain(
			'{"actions":[{"op":"search","path":"src","pattern":"TODO","glob":"*.ts"},{"op":"read","path":"package.json"}]}',
		);
		expect(prompt).toContain("`code` is only an input field inside a `javascript` call");
		expect(prompt).toContain(
			"Use `code` for computation, branching, dependent operations, prepared JavaScript skills, and persistent notebook state",
		);
		expect(prompt).toContain("Top-level named bindings are durable session state and are checkpointed between cells");
		expect(prompt).toContain("serialized text, parsed duplicates, sorted copies, or temporary buffers");
		expect(prompt).toContain("inside an explicit `{ ... }` block");
		expect(prompt).toContain("not retained in later cells or checkpoints");
		expect(prompt).toContain("If a value is not needed in a later cell, it must not be a top-level binding");
		expect(prompt).toContain("Naming a temporary value does not make it reusable");
		expect(prompt).toContain("Verify artifacts by rereading them");
		expect(prompt).toContain("Prefer a direct computed write inside that block");
		expect(prompt).toContain("Prefer a structured `shell` action over `$` or `sh()`");
		const bunShellIndex = prompt.indexOf("await $`command`.quiet()");
		const shIndex = prompt.indexOf("await sh(command)");
		expect(bunShellIndex).toBeGreaterThanOrEqual(0);
		expect(shIndex).toBeGreaterThan(bunShellIndex);
		expect(prompt).toContain("Do not import `$` from `bun`");
		expect(prompt).toContain("`sh(command)` uses the configured project shell and command prefix");
		expect(prompt).toContain(
			"`.text()` returns the stdout string directly, so never destructure `{ stdout }` from it",
		);
		expect(prompt).toContain("Do not use `child_process` (`execSync`, `spawnSync`, `exec`) in the notebook");
		expect(prompt).toContain("including expected search misses");
		expect(prompt).toContain("await sh(command)");
		expect(prompt).toContain("{ exitCode, stdout, stderr }");
		expect(prompt).toContain("await sh(command).text()");
		expect(prompt).toContain("await sh(command).json()");
		expect(prompt).toContain("Bun Shell throws on non-zero exit before JavaScript `||` can run");
		expect(prompt).toContain(".nothrow().text()");
		expect(prompt).toContain("await installPackage('pkg')");
		expect(prompt).toContain("process.chdir(dir)");
		expect(prompt).toContain("prefer `rg -n` and `rg --files`");
		expect(prompt).toContain("Never use recursive `grep -rn`");
		expect(prompt).toContain("Batch multiple filename or pattern probes into one search");
		expect(prompt).toContain("Unless the user asks for an exhaustive review, use at most 12 `javascript` calls");
		expect(prompt).toContain("synthesize the requested answer before the budget is exhausted");
		expect(prompt).not.toContain("array of ordinary quoted lines");
		expect(prompt).toContain("Read-only methods remain available through the preloaded `fs` namespace");
		expect(prompt).toContain("`fs.existsSync`");
		expect(prompt).toContain("filesystem APIs only for values produced by computation");
		expect(prompt).toContain("do not redeclare them as local variables");
		expect(prompt).toContain("`rlmDoc`");
		expect(prompt).toContain("check `fs.existsSync`");
		expect(prompt).toContain("Do not rely on shell globs over paths that may not exist");
		expect(prompt).toContain("JavaScript state persists across cells");
		expect(prompt).toContain("Preloaded globals: `fs`, `path`, `os`, `util`, and `require`");
		expect(prompt).toContain("Static imports and literal `require()` bindings persist across cells");
		expect(prompt).not.toContain("Static `import` declarations are not supported");
		expect(prompt).toContain("Continual harness state is available as `rlm.harness`");
		expect(prompt).toContain("installed JavaScript skills are prepared as globals");
		expect(prompt).not.toMatch(/Python packages|Python REPL|%%bash|uv pip/);
	});

	test("falls back to structured actions when dedicated file tools are inactive", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			activeTools: ["javascript"],
			allowRecursion: false,
		});

		expect(prompt).toContain("Use a structured `write` action for exact authored file content");
		expect(prompt).toContain("Use a structured `edit` action for exact unique replacements");
		expect(prompt).not.toContain("`write_file` creates missing parent directories");
		expect(prompt).not.toContain("Use `edit_file`");
		expect(prompt).not.toContain("array of ordinary quoted lines");
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
		expect(withEdit).toContain("read the exact target first");
		expect(withEdit).toContain("use a structured `edit` action with `path`, `oldStr`, and `newStr`");
		expect(withEdit).toContain("reread the affected window after editing");

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

		expect(prompt).toContain(
			"You are a general purpose agent that uses tools, structured actions, and code to solve tasks.",
		);
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
		expect(prompt).not.toContain(
			"You are a general purpose agent that uses tools, structured actions, and code to solve tasks.",
		);
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
	test("exposes compact code and structured-action modes", () => {
		const tool = createJavaScriptToolDefinition("/repo");

		expect(tool.description).toContain("two input modes");
		expect(tool.description).toContain("The tool name is `javascript`; `code` is only an input field");
		expect(tool.description).toContain(
			"Default to `actions` for independent routine reads, searches, shell commands, and batched work",
		);
		expect(tool.description).toContain("structured writes create missing parent directories");
		expect(tool.description).toContain("filesystem writes of computed values already held in variables");
		expect(tool.description).toContain("Use `code` for computation, branching, dependent operations");
		expect(tool.description).toContain("put large one-shot intermediates in an explicit `{ ... }` block");
		expect(tool.description).toContain("Values not needed in a later cell must be block-scoped, even when named");
		expect(tool.description).toContain("one to eight actions");
		expect(tool.description).toContain("target project's own environment");
		expect(tool.promptSnippet).toContain("persistent Bun notebook");
		expect(tool.promptGuidelines).toContain(
			"For read-only repository exploration and audits, plan first, batch independent actions, and stop after at most 12 JavaScript calls; answer from collected evidence instead of pursuing exhaustive coverage.",
		);
		const parameters = tool.parameters as unknown as {
			properties: Record<string, { description?: unknown; items?: unknown; maxItems?: unknown; minItems?: unknown }>;
			required?: string[];
		};
		expect(parameters.required ?? []).not.toContain("code");
		expect(Object.keys(parameters.properties)[0]).toBe("actions");
		const actionsSchema = parameters.properties.actions;
		expect(actionsSchema).toMatchObject({ minItems: 1, maxItems: 8 });
		expect(actionsSchema?.items).toBeDefined();
		const codeSchema = parameters.properties.code;
		const codeDescription =
			codeSchema && "description" in codeSchema && typeof codeSchema.description === "string"
				? codeSchema.description
				: "";
		expect(codeDescription).toContain("computation, branching, dependent operations");
		expect(codeDescription).toContain("persistent notebook state");
		expect(codeDescription).toContain("put large one-shot intermediates in an explicit `{ ... }` block");
		expect(codeDescription).toContain("Values not needed in a later cell must be block-scoped, even when named");
		expect(codeDescription).toContain("Do not import child_process or call execSync");
		expect(codeDescription.length).toBeLessThan(1_000);
	});
});
