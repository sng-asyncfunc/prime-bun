import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	canonicalizeFactorySpec,
	cliDispatch,
	exportLibraryMachine,
	FactoryExecutor,
	importMachine,
	listMachines,
	resolveMachine,
	topologicalOrder,
	validateFactorySpec,
} from "../src/factory.ts";
import { clearHarnessStateCache, getHarnessState } from "../src/harness.ts";

const RUNTIME_DIR = path.resolve(import.meta.dir, "..");
const FACTORY_CLI = path.join(RUNTIME_DIR, "src", "factory-cli.ts");
const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeTempDir(prefix = "prime-factory-test-"): string {
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

describe("Factory spec validation & machine library", () => {
	test("validates machine, compiles DAG sugar, and computes topologicalOrder", () => {
		const dag = {
			run: { max_parallel: 4 },
			nodes: [
				{ id: "a", subagent: { prompt: "Produce items" }, outputs: [{ name: "items", type: "json" }] },
				{
					id: "b",
					subagent: { prompt: "Process {items}" },
					inputs: [{ name: "items", type: "json", from: "a.items" }],
					foreach: { over: "items", max: 4 },
					outputs: [{ name: "out", type: "text" }],
				},
				{
					id: "c",
					subagent: { prompt: "Merge {out}" },
					inputs: [{ name: "out", type: "text", from: "b.out" }],
				},
			],
		};
		expect(validateFactorySpec(dag)).toEqual([]);
		expect(topologicalOrder(dag.nodes)).toEqual(["a", "b", "c"]);
		const canonical = canonicalizeFactorySpec(dag);
		expect((canonical.states as unknown[]).length).toBe(3);
		expect((canonical.transitions as unknown[]).length).toBe(2);

		// Reject wait states & invalid guards
		const badMachine = {
			states: [
				{ id: "s1", entry: true, wait: { event: "x" }, subagent: { prompt: "hi" } },
			],
		};
		const errs = validateFactorySpec(badMachine);
		expect(errs.some((e) => e.includes("wait states require"))).toBe(true);
	});

	test("lists, resolves, exports, and imports bundled MACHINE.md seeds via cliDispatch and factory-cli.ts", () => {
		const agentDir = makeTempDir("agent-");
		const exportDir = makeTempDir("export-");
		setEnv("PRIME_AGENT_CODING_AGENT_DIR", agentDir);

		const machines = listMachines();
		expect(machines.map((m) => m.name)).toEqual(["builder", "pr-manager", "review-sweep"]);

		const [seed] = resolveMachine("review-sweep");
		expect(seed.name).toBe("review-sweep");
		expect(validateFactorySpec(seed.spec)).toEqual([]);

		// Export + import round trip
		const outPath = path.join(exportDir, "review-sweep.MACHINE.md");
		const exported = exportLibraryMachine("review-sweep", outPath);
		expect(exported.source).toBe("library");
		expect(fs.existsSync(outPath)).toBe(true);

		const imported = importMachine(outPath);
		expect(imported.name).toBe("review-sweep");
		expect(imported.created).toBe(true);

		// cliDispatch direct
		const listRes = cliDispatch({ op: "list" });
		expect(listRes.ok).toBe(true);
		expect((listRes.machines as Array<{ name: string }>).map((m) => m.name)).toEqual([
			"builder",
			"pr-manager",
			"review-sweep",
		]);

		// CLI runner via bun run src/factory-cli.ts
		const stdout = execFileSync(process.execPath, ["run", FACTORY_CLI], {
			cwd: RUNTIME_DIR,
			input: JSON.stringify({ op: "list" }),
			encoding: "utf8",
			env: { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: agentDir },
		});
		const cliJson = JSON.parse(stdout) as { ok: boolean; machines: Array<{ name: string }> };
		expect(cliJson.ok).toBe(true);
		expect(cliJson.machines.map((m) => m.name)).toEqual(["builder", "pr-manager", "review-sweep"]);
	});
});

describe("FactoryExecutor", () => {
	test("runs guarded review/fix loop to completion with mocked spawn/collect and emits factory.progress", async () => {
		const agentDir = makeTempDir("agent-");
		const localDir = makeTempDir("local-");
		setEnv("PRIME_AGENT_CODING_AGENT_DIR", agentDir);
		setEnv("RLM_HARNESS_STATE_DIR", localDir);
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ factory: { enabled: true } }));

		const harness = getHarnessState();
		harness.createFactory("review-loop", "Review and fix once", {
			id: "review-loop",
			machine: {
				run: { max_parallel: 4, max_transitions: 10 },
				states: [
					{
						id: "review",
						entry: true,
						subagent: { prompt: "Review code (fix={fix})" },
						inputs: [{ name: "fix", type: "text", from: "fix.report", optional: true }],
						outputs: [{ name: "verdict", type: "json" }],
						max_entries: 3,
					},
					{
						id: "fix",
						subagent: { prompt: "Fix issues from {verdict}" },
						inputs: [{ name: "verdict", type: "json", from: "review.verdict" }],
						outputs: [{ name: "report", type: "text" }],
						max_entries: 2,
					},
				],
				transitions: [
					{ from: "review", to: "fix", when: { output: "verdict", path: "approved", op: "eq", value: false } },
					{ from: "fix", to: "review" },
				],
			},
		});

		let nextId = 1;
		let reviewCalls = 0;
		const spawned = new Map<string, { stateId: string; prompt: string }>();
		const milestones: Array<Record<string, unknown>> = [];

		const executor = new FactoryExecutor({
			harness,
			sleep: async () => undefined,
			spawn: async (prompt, opts) => {
				const childId = `child-${nextId++}`;
				spawned.set(childId, { stateId: opts.factory!.stateId, prompt });
				return { rlmChildId: childId, name: opts.name };
			},
			collect: async (targets) =>
				targets.map((cid) => {
					const info = spawned.get(cid)!;
					if (info.stateId === "review") {
						reviewCalls += 1;
						const approved = reviewCalls >= 2;
						return {
							rlmChildId: cid,
							status: "done",
							settled: true,
							answerText: `\`\`\`json\n{"verdict": {"approved": ${approved}}}\n\`\`\``,
							durationMs: 10,
							toolUseCount: 1,
						};
					}
					return {
						rlmChildId: cid,
						status: "done",
						settled: true,
						answerText: "fixed the bug",
						durationMs: 15,
						toolUseCount: 2,
					};
				}),
			deleteSubagent: async () => undefined,
			progress: async (payload) => {
				milestones.push(payload);
			},
		});

		const launched = await executor.run("review-loop");
		const runId = String(launched.run_id);
		const runObj = executor.runs.get(runId)!;
		if (runObj.task) await runObj.task;

		const st = await executor.status(runId);
		expect(st.state).toBe("done");
		expect((st.usage as Record<string, unknown>).transitions_fired).toBe(2);
		expect((st.usage as Record<string, unknown>).spawns).toBe(3);
		expect(milestones.some((m) => m.kind === "finished")).toBe(true);

		// Activity wire payload is camelCase
		const wireGraph = (await executor.activity({ action: "graph", runId })) as Record<string, unknown>;
		expect(wireGraph.runId).toBe(runId);
		expect(wireGraph.state).toBe("done");
	});

	test("executes isolated javascript callable state and fans out over its output", async () => {
		const agentDir = makeTempDir("agent-");
		const localDir = makeTempDir("local-");
		const modDir = makeTempDir("js-state-");
		setEnv("PRIME_AGENT_CODING_AGENT_DIR", agentDir);
		setEnv("RLM_HARNESS_STATE_DIR", localDir);
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ factory: { enabled: true } }));

		const modPath = path.join(modDir, "items.ts");
		fs.writeFileSync(
			modPath,
			`export async function listItems() {
  return { items: ["alpha.ts", "beta.ts"] };
}\n`,
		);

		const harness = getHarnessState();
		harness.createFactory("js-fanout", "List items in JS then fan out", {
			id: "js-fanout",
			machine: {
				states: [
					{
						id: "list",
						entry: true,
						javascript: { import: modPath, callable: "listItems" },
						outputs: [{ name: "items", type: "json" }],
					},
					{
						id: "check",
						subagent: { prompt: "Check {items}" },
						inputs: [{ name: "items", type: "json", from: "list.items" }],
						foreach: { over: "items", max: 4 },
					},
				],
				transitions: [{ from: "list", to: "check" }],
			},
		});

		const prompts: string[] = [];
		let childSeq = 1;
		const executor = new FactoryExecutor({
			harness,
			sleep: async (s) => new Promise((r) => setTimeout(r, Math.min(s * 1000, 20))),
			spawn: async (prompt) => {
				prompts.push(prompt);
				return { rlmChildId: `c-${childSeq++}` };
			},
			collect: async (targets) =>
				targets.map((cid) => ({
					rlmChildId: cid,
					status: "done",
					settled: true,
					answerText: "ok",
				})),
			deleteSubagent: async () => undefined,
			progress: async () => undefined,
		});

		const launched = await executor.run("js-fanout");
		const runId = String(launched.run_id);
		const runObj = executor.runs.get(runId)!;
		if (runObj.task) await runObj.task;

		const st = await executor.status(runId);
		expect(st.state).toBe("done");
		expect(prompts).toEqual(["Check alpha.ts", "Check beta.ts"]);
	});

	test("pauses on escalate failure and re-admits on resume", async () => {
		const agentDir = makeTempDir("agent-");
		const localDir = makeTempDir("local-");
		setEnv("PRIME_AGENT_CODING_AGENT_DIR", agentDir);
		setEnv("RLM_HARNESS_STATE_DIR", localDir);
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ factory: { enabled: true } }));

		const harness = getHarnessState();
		harness.createFactory("esc-test", "Escalate and resume", {
			id: "esc-test",
			dag: {
				run: { failure_policy: "escalate" },
				nodes: [{ id: "worker", subagent: { prompt: "Do work" } }],
			},
		});

		let attempt = 0;
		const executor = new FactoryExecutor({
			harness,
			sleep: async () => undefined,
			spawn: async () => {
				attempt += 1;
				return { rlmChildId: `w-${attempt}` };
			},
			collect: async (targets) =>
				targets.map((cid) => ({
					rlmChildId: cid,
					status: cid === "w-1" ? "error" : "done",
					settled: true,
					error: cid === "w-1" ? "transient boom" : null,
					answerText: cid === "w-1" ? null : "succeeded",
				})),
			deleteSubagent: async () => undefined,
			progress: async () => undefined,
		});

		const launched = await executor.run("esc-test");
		const runId = String(launched.run_id);
		const runObj = executor.runs.get(runId)!;
		if (runObj.task) await runObj.task;

		const paused = await executor.status(runId);
		expect(paused.state).toBe("paused");
		expect(paused.pause_reason).toBe("transient boom");

		await executor.resume(runId);
		if (runObj.task) await runObj.task;

		const done = await executor.status(runId);
		expect(done.state).toBe("done");
	});
});
