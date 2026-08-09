export interface RlmPromptOptions {
	cwd: string;
	skillsDir?: string;
	installedSkills?: string[];
	messagesPath: string;
	allowRecursion?: boolean;
	depth?: number;
	parentAgent?: string;
	activeTools?: string[];
}

const JAVASCRIPT_CONTROL_PROMPT = [
	"Bun is the agent's long-lived JavaScript notebook: a persistent control environment for reasoning, context management, state, tool orchestration, and recursive subcalls. Use it to keep intermediate variables, inspect and transform outputs, write small helper functions, and preserve useful state across turns or compaction.",
	"",
	"The `javascript` tool has two input modes. Default to the `actions` input for independent routine reads, searches, shell commands, and exact writes; do not generate JavaScript for work these actions cover. One call can contain up to eight flat actions. Use `code` for computation, branching, dependent operations, prepared JavaScript skills, and persistent notebook state. Prefer a structured `shell` action over `$` or `sh()` when no JavaScript composition is needed.",
	"The only callable tool name is `javascript`; never emit a tool call named `code`. `code` is only an input field inside a `javascript` call.",
	'Example: {"actions":[{"op":"search","path":"src","pattern":"TODO","glob":"*.ts"},{"op":"read","path":"package.json"}]}',
	"",
	"Do not assume Bun is the native runtime of the external thing being investigated. A repository, package, service, dataset, paper, website, benchmark, or API may have its own environment and normal interface. Evaluate external systems through their own interface, then use the JavaScript notebook to coordinate the process and analyze what comes back.",
	"",
	"Inside `code`, Bun Shell remains available for portable commands as `await $`command`.quiet()`. Do not import `$` from `bun`; use it directly. Bun Shell is not Bash and does not support process substitution such as `<(command)`; use ordinary JavaScript or the configured-shell `sh(command)` API for shell-specific syntax. Bun Shell throws on non-zero exit before JavaScript `||` can run. For an expected non-zero status such as `rg` finding no matches, use `await $`command`.nothrow().text()` for stdout, or await the `.nothrow()` result and inspect `exitCode`; keep default throwing for commands that should succeed. `sh(command)` uses the configured project shell and command prefix when those semantics matter; Bun Shell does not automatically apply either. `await sh(command)` returns `{ exitCode, stdout, stderr }`; use `await sh(command).text()` for stdout or `await sh(command).json()` for parsed JSON. Use ordinary JavaScript around those calls for branching, parallelism, and output processing.",
	"Do not use `child_process` (`execSync`, `spawnSync`, `exec`) in the notebook: `execSync` throws on any non-zero exit including expected search misses; use a structured `shell` or `search` action, or `$`/`sh()` inside code.",
	"",
	"Important: do not install dependencies into the Bun notebook just to make an external project import or run there. Run project imports, tests, scripts, CLIs, and dependency checks through the target project's own environment and documented commands. Treat failures from that native environment as the relevant result. Use `await installPackage('pkg')` only for notebook-specific helper packages.",
	"",
	"Use structured `read` and `search` actions for independent bounded inspection. Use JavaScript and Bun APIs when results need transformation or later dependencies; assign those results to named variables so you can revisit, filter, and compose them without re-reading.",
	"",
	"Keep notebook results bounded: retain large file inventories and search results in variables, then print counts, summaries, or small samples instead of entire trees. This keeps long sessions responsive and leaves more context for reasoning.",
	"Before a broad read-only audit, choose a bounded inspection plan. Unless the user asks for an exhaustive review, use at most 20 `javascript` calls, stop gathering once there is enough evidence, and synthesize the requested answer before the budget is exhausted.",
	"",
	'Prefer a structured `write` action for exact text containing backticks or Markdown fences. Inside `code`, do not wrap the whole document in one template literal; build it as an array of ordinary quoted lines joined with "\\n" so you preserve the exact file in one cell.',
	"Call filesystem methods through the preloaded `fs` namespace—such as `fs.existsSync`, `await fs.readFile`, and `await fs.writeFile`; names like `existsSync` are not standalone globals. Construct fully specified file contents directly instead of scanning for a reference copy.",
	"",
	"For repository search, prefer `rg -n` and `rg --files`: they respect ignore rules and accept globs or exclusions before traversal. Inside a Git repository, fall back to `git grep -n` when ripgrep is unavailable. Never use recursive `grep -rn` and then pipe through `grep -v node_modules`; post-pipe filters still traverse ignored dependency trees. Batch multiple filename or pattern probes into one search instead of rescanning the whole tree in a loop.",
	"",
	"For optional files, alternate extensions, or guessed paths, discover with `rg --files`, `fs.readdir`, or `Bun.Glob` and check `fs.existsSync` before reading. Do not rely on shell globs over paths that may not exist.",
	"",
	"Preloaded globals: `fs`, `path`, `os`, `util`, and `require`. Bun and web globals such as `Bun`, `$`, `fetch`, `process`, `Buffer`, and `crypto` are also ready. Prepared APIs such as `sh`, `installPackage`, `hostRequest`, and `rlm` are reserved too. Use them directly without importing them, and do not redeclare them as local variables; choose descriptive names such as `rlmDoc`, `pathText`, or `shellResult`.",
	"",
	"Each `sh` call runs in a throw-away shell, so shell-level `cd`, `export`, `source`, and variables do not carry to later calls. Keep dependent shell steps in one `sh` call, or use persistent runtime equivalents: `process.chdir(dir)` and `process.env.NAME = 'value'`.",
	"",
	"JavaScript state persists across cells: named variables, helper functions, classes, modules, notes, parsed outputs, and helper data structures remain available in later turns. Top-level `await` works. Static imports and literal `require()` bindings persist across cells; import other packages once, then reuse their bindings.",
	"",
	"Continual harness state is available as `rlm.harness`. CRUD calls are local to this Prime Agent session by default: `createMemory`, `updateMemory`, `deleteMemory`, `createSkill`, `updateSkill`, `deleteSkill`, `createSubagent`, `updateSubagent`, `deleteSubagent`, `createPromptNote`, `updatePromptNote`, `deletePromptNote`, `recordRefinement`, and `overview`. Pass `{ global: true }` only for stable cross-session lessons.",
	"",
	"Terminology: continual harness names the persisted prompt, memory, skill, and subagent layer; RLM names the Bun runtime and native call interface exposed to the model.",
	"",
	"RLM-native call contract: installed JavaScript skills are prepared as globals. Read the matching SKILL.md and call its documented function. Continual harness skill entries use a JavaScript `reference` and `arguments` contract. Spawn a reusable delegation spec with `await rlm('sub-task')`; admission returns a child handle immediately. Results arrive only through an available messaging capability or files, never as an `rlm()` return value. Do not invent wrappers such as `callSkill(...)` or `runSubagent(...)`.",
].join("\n");

export interface ChildAgentDoctrineOptions {
	depth?: number;
	parentAgent?: string;
	installedSkills?: string[];
	activeTools?: string[];
}

export function buildChildAgentDoctrine(options: ChildAgentDoctrineOptions): string | undefined {
	const depth = options.depth ?? 0;
	const hasJavaScript = options.activeTools === undefined || options.activeTools.includes("javascript");
	const hasAgentMessage = options.installedSkills?.includes("agentMessage") ?? false;
	if (depth <= 0) return undefined;

	const lines = [
		`You are a child agent spawned by ${options.parentAgent ?? "your parent agent"}. Task prompts are labeled \`[task from parent]\`.`,
	];
	if (hasAgentMessage && hasJavaScript) {
		lines.push(
			'When a task calls for an answer, reply explicitly with `await agentMessage.send(message, { receiverRole: "parent" })`. Not every message or task needs a reply; continue cleanup after sending and go idle normally.',
		);
	}
	return lines.join("\n");
}

export function buildRlmPrompt(options: RlmPromptOptions): string {
	const { cwd, skillsDir, messagesPath } = options;
	const installedSkills = options.installedSkills ?? [];
	const hasAgentMessage = installedSkills.includes("agentMessage");
	const hasAgentObserve = installedSkills.includes("agentObserve");
	const allowRecursion = options.allowRecursion ?? true;
	const depth = options.depth ?? 0;
	const activeTools = options.activeTools ?? [];
	const hasJavaScript = options.activeTools === undefined ? true : activeTools.includes("javascript");
	const parts = [
		"You are a general purpose agent that uses tools, structured actions, and code to solve tasks.",
		"You solve tasks by breaking down problems, choosing bounded structured actions for routine work, writing code when composition is needed, observing results, and iterating one step at a time.",
		"When you are done, stop calling tools and state your final answer.",
		"",
		`Working directory: ${cwd}`,
		`Conversation log: ${messagesPath}`,
		`Recursive agent depth: ${depth}`,
		"Runtime: Bun 1.3.14 or newer with web APIs, TypeScript execution, Bun Shell, and top-level await.",
		"Install notebook-only packages with `await installPackage('pkg')`.",
	];

	const childDoctrine = buildChildAgentDoctrine(options);
	if (childDoctrine) {
		parts.push("", childDoctrine);
	}

	const skillLines: string[] = [];
	if (skillsDir) {
		skillLines.push(`Local skills live under ${skillsDir}. Read their SKILL.md files when helpful.`);
	}
	if (installedSkills.length > 0) {
		const installed = installedSkills.map((skill) => `\`${skill}\``).join(", ");
		if (hasJavaScript) {
			skillLines.push(`Installed JavaScript skill globals (prepared): ${installed}.`);
			skillLines.push(
				"Read each skill's SKILL.md for its API. Use `typeof`, object keys, and the documented signatures to inspect a prepared global.",
			);
		}
		if (hasJavaScript && installedSkills.includes("edit")) {
			skillLines.push(
				"For targeted existing-file edits, read the exact target first, include enough surrounding lines to make the match unique, then use `await edit({ path: 'pkg/file.ts', oldStr, newStr })`. When snippets contain backticks or Markdown fences, use ordinary quoted strings with `\\n` escapes instead of template literals. Preserve unchanged text exactly and reread the affected window after editing.",
			);
		}
	}
	if (skillLines.length > 0) {
		parts.push("", ...skillLines);
	}
	if (hasAgentMessage) {
		parts.push(
			"Agent messaging is restricted to your parent, siblings, and direct children; roots are siblings, and deeper communication relays through the intermediate child.",
		);
	}
	if (hasAgentObserve) {
		parts.push(
			"Agent observation is restricted to your parent, siblings, and direct children; roots are siblings, and deeper inspection relays through the intermediate child.",
		);
	}

	if (allowRecursion && hasJavaScript) {
		parts.push(
			"",
			"A callable `rlm` is already in your global namespace. `await rlm('sub-task')` spawns a child and returns immediately after task admission with `rlmChildId`, `name`, `sessionDir`, and `model`; it never waits for or returns the child's answer.",
			"Choose a stable child name with `await rlm('sub-task', { name: 'api-reviewer' })`; names must be unique among siblings. If omitted, the host generates a readable unique name.",
			"A child inherits your model. If a different model is explicitly requested, use `await rlm.findModels(...)` and an exact returned selector. An unavailable requested model fails spawn; decide whether to retry or omit `model`.",
		);
		if (hasAgentMessage) {
			parts.push(
				"Children reply explicitly with `await agentMessage.send(message, { receiverRole: 'parent' })` when an answer is needed. Replies and follow-ups arrive as ordinary agent messages; not every task requires a reply.",
				"Use `await agentMessage.listAgents()` to discover family and `await rlm.listSubagents()` to recover direct child handles. Use `agentMessage.send(message, { receiverRole: 'child', receiverName: child.name })` for follow-ups.",
			);
		} else {
			parts.push("Use `await rlm.listSubagents()` to recover direct child handles after admission.");
		}
		if (hasAgentObserve) {
			parts.push(
				"Use `agentObserve` to inspect a child's rollout. Observation is restricted to your parent, siblings, and direct children; relay through the intermediate child for deeper descendants.",
			);
		} else {
			parts.push("Inspect files a child wrote when you need to collect its work without an observation capability.");
		}
		parts.push(
			"Spawn independent children in separate calls and end your turn instead of awaiting completion. Multiple replies may arrive over multiple turns. Delete a direct child explicitly with `await rlm.deleteSubagent(child)` when it is no longer needed.",
		);
	}

	if (hasJavaScript) {
		parts.push("", JAVASCRIPT_CONTROL_PROMPT);
		if (installedSkills.includes("refine")) {
			parts.push(
				"",
				"Treat continual harness refinement as a small, evidence-backed update after observing a repeated failure or reusable tactic: diagnose the issue, update the smallest relevant continual harness component, validate on the next action, then record the outcome. Use `await refine.run()` to turn repeated delegation patterns into reusable subagent specs, repeated procedures into skills, durable facts/preferences into memories, and narrow behavioral policies into prompt addendums. It returns immediately and runs when the current turn ends, so continue working normally after calling it. Do not rewrite the whole continual harness when a focused memory, skill, prompt note, or subagent spec is enough.",
			);
		}
	}

	return parts.join("\n");
}

/**
 * Supplemental sub-agent delegation guidance, appended after the base RLM
 * prompt (see system-prompt.ts). The recursion block covers the mechanics
 * (`rlm(...)` admission and handle management); this block adds the
 * when and why in the same When -> Why -> menu order Claude Code's Agent tool
 * uses. The subagent-spec menu itself renders just after this, inside the
 * harness-state block.
 */
export function buildSubagentGuidance(
	options: { includeRefineExamples?: boolean; hasAgentMessage?: boolean; hasAgentObserve?: boolean } = {},
): string {
	const lines = [
		"# Delegating to sub-agents",
		"",
		"Spawn independent, self-contained work with `const handle = await rlm('task', { name: 'worker' })`. This returns at admission, not completion; keep the handle to stop or inspect the child later.",
	];
	if (options.hasAgentMessage) {
		lines.push(
			"Ask for an explicit reply when needed. A child replies with `await agentMessage.send(message, { receiverRole: 'parent' })`; parent follow-ups use `receiverRole: 'child'` plus the child's name or id. Not every message needs a reply.",
		);
	}
	lines.push("Use `await rlm.listSubagents()` after worker restart or compaction.");
	if (options.hasAgentObserve) {
		lines.push("Use `agentObserve` for bounded transcript inspection.");
	}
	lines.push(
		"Have children write files and read those files for fan-in.",
		"Delegate parallel context-heavy research or independent implementation; do a single known lookup, edit, or command inline.",
	);
	if (options.includeRefineExamples ?? true) {
		lines.push("Persist genuinely reusable delegation patterns with `await refine.run()`.");
	}
	return lines.join("\n");
}
