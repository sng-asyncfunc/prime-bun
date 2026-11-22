import { type ChildProcess, spawn as spawnProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childEnv, signalGroup } from "./bash.ts";
import { hostRequest, sendProtocolEvent } from "./bridge.ts";
import {
	canonicalizeFactorySpec,
	declaredPortTypes,
	exportFactorySpec,
	exportLibraryMachine,
	isInt,
	isNumber,
	isRecord,
	type MachineFile,
	MachineResolutionError,
	machineNameErrors,
	MAX_TRANSITIONS_CAP,
	NODE_LIFECYCLE_DEFAULT,
	NODE_RETRIES_DEFAULT,
	requireFactoryEnabled,
	resolveMachine,
	RUN_FAILURE_POLICY_DEFAULT,
	RUN_MAX_CHILDREN_DEFAULT,
	RUN_MAX_PARALLEL_DEFAULT,
	STATE_ENTRY_DEFAULT,
	STATE_MAX_ENTRIES_DEFAULT,
	SUBAGENT_NAME_MAX_LENGTH,
	TRANSITION_ON_KINDS,
} from "./factory-spec.ts";
import { resolveBunBinary } from "./runtime-globals.ts";

export * from "./factory-spec.ts";

export const ANSWER_CAPTURE_CAP = 200;
export const ANSWER_BINDING_CAP = 65_536;
export const EVENT_WINDOW = 200;
export const POLL_TIMEOUT_MS = 2000;
export const WATCH_TIMEOUT_CAP_SECONDS = 60.0;
export const LAST_FIRED_WINDOW = 10;
export const GRAPH_RUNS_WINDOW = 20;
export const GRAPH_EVENTS_TAIL = 40;
export const FACTORY_FRAME_CAP = 262_144;
export const ACTIVITY_ACTIONS = ["graph", "status", "watch", "run", "stop", "resume"] as const;
export const ACTIVITY_TIMEOUT_MS_CAP = Math.trunc(WATCH_TIMEOUT_CAP_SECONDS * 1000);
export const BACKOFF_MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_SECONDS = 1.0;
export const BACKOFF_CAP_SECONDS = 60.0;
export const INFRA_VERIFY_QUIET_SECONDS = POLL_TIMEOUT_MS / 1000;
export const JS_STATE_TIMEOUT_MS_DEFAULT = 60_000;
export const JS_STDERR_TAIL_CAP = 2000;

const RATE_LIMIT_MARKERS = [
	"rate limit",
	"rate-limit",
	"ratelimit",
	"429",
	"too many requests",
	"throttled",
	"quota",
	"usage limit",
] as const;

const INFRA_ERROR_MARKERS = ["child worker unreachable", "supervisor link"] as const;
const TERMINAL_ENTRY_STATUSES = new Set(["done", "error", "cancelled"]);
const WIRE_LIVE_RUN_STATES = new Set(["running", "stopping", "paused"]);

const JS_STATE_RUNNER = `
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const [modSpec, callableName, inputPath, outputPath] = process.argv.slice(1);
const inputs = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const resolved = modSpec.startsWith(".") || path.isAbsolute(modSpec)
  ? pathToFileURL(path.resolve(process.cwd(), modSpec)).href
  : modSpec;
const mod = await import(resolved);
const fn = mod[callableName] ?? (mod.default && mod.default[callableName]);
if (typeof fn !== "function") {
  throw new Error(\`Module '\${modSpec}' does not export callable '\${callableName}'\`);
}
const result = await fn(inputs);
fs.writeFileSync(outputPath, JSON.stringify(result), "utf8");
`;

function isRateLimitError(message: string): boolean {
	const lowered = message.toLowerCase();
	return RATE_LIMIT_MARKERS.some((marker) => lowered.includes(marker));
}

function isInfraError(message: string): boolean {
	const lowered = message.toLowerCase();
	return INFRA_ERROR_MARKERS.some((marker) => lowered.includes(marker));
}

function childName(runId: string, stateId: string, instanceIndex: number, attempt: number): string {
	let token: string;
	if (stateId.length <= 20) {
		token = stateId;
	} else {
		const digest = createHash("sha256").update(stateId).digest("hex").slice(0, 16);
		token = `${stateId.slice(0, 20)}-${digest}`;
	}
	const parts = ["sw", token, runId.slice(0, 6)];
	if (instanceIndex >= 0) parts.push(`i${instanceIndex}`);
	if (attempt > 1) parts.push(`a${attempt}`);
	return parts.join("-");
}

function spawnLabel(
	configured: string | null,
	runId: string,
	stateId: string,
	instanceIndex: number,
	attempt: number,
): string {
	if (configured === null) return childName(runId, stateId, instanceIndex, attempt);
	const suffixParts: string[] = [];
	if (instanceIndex > 0) suffixParts.push(`i${instanceIndex}`);
	if (attempt > 1) suffixParts.push(`a${attempt}`);
	const suffix = suffixParts.map((p) => `-${p}`).join("");
	let base = `${runId.slice(0, 6)}-${configured}`;
	if (base.length + suffix.length > SUBAGENT_NAME_MAX_LENGTH) {
		const digest = createHash("sha256").update(base).digest("hex").slice(0, 16);
		const room = Math.max(SUBAGENT_NAME_MAX_LENGTH - suffix.length - digest.length - 1, 0);
		base = `${base.slice(0, room)}-${digest}`;
	}
	return base + suffix;
}

function terminalJsonObject(answer: string): string | null {
	const length = answer.length;
	let last: [number, number] | null = null;
	let index = 0;
	while (index < length) {
		if (answer[index] !== "{") {
			index += 1;
			continue;
		}
		let cursor = index + 1;
		while (cursor < length && /\s/.test(answer[cursor]!)) cursor += 1;
		if (cursor === length || answer[cursor] !== '"') {
			index += 1;
			continue;
		}
		let depth = 1;
		let inString = false;
		let escaped = false;
		while (cursor < length) {
			const ch = answer[cursor]!;
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
			} else if (ch === '"') {
				inString = true;
			} else if (ch === "{") {
				depth += 1;
			} else if (ch === "}") {
				depth -= 1;
				if (depth === 0) {
					last = [index, cursor + 1];
					cursor += 1;
					break;
				}
			}
			cursor += 1;
		}
		if (depth !== 0) return null;
		index = cursor;
	}
	if (!last) return null;
	const trailing = answer.slice(last[1]);
	if (/[A-Za-z0-9"'{}[\]\\]/.test(trailing)) return null;
	return answer.slice(last[0], last[1]);
}

function parseJsonOutput(
	answer: string,
	outputName: string,
	truncatedAt?: number | null,
): [unknown, string | null] {
	const fenced: string[] = [];
	const re = /```json\s*([\s\S]*?)\s*```/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(answer)) !== null) {
		fenced.push(match[1]!);
	}
	const candidates: string[] = [...fenced.reverse()];
	const terminal = terminalJsonObject(answer);
	if (terminal !== null) candidates.push(terminal);
	candidates.push(answer.trim());

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (isRecord(parsed) && outputName in parsed) {
				return [parsed[outputName], null];
			}
		} catch {
			// next candidate
		}
	}
	let error = `no JSON object containing output ${JSON.stringify(outputName)} in the upstream answer`;
	if (truncatedAt !== undefined && truncatedAt !== null) {
		error += `; the captured answer is truncated at ${truncatedAt} characters - keep the fenced JSON block compact`;
	}
	return [null, error];
}

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderPrompt(template: string, values: Record<string, string>): string {
	const keys = Object.keys(values);
	if (keys.length === 0) return template;
	const pattern = new RegExp(keys.map((name) => escapeRegExp(`{${name}}`)).join("|"), "g");
	const used = new Set<string>();
	let rendered = template.replace(pattern, (matched) => {
		const name = matched.slice(1, -1);
		used.add(name);
		return values[name]!;
	});
	const unplaced = keys.filter((k) => !used.has(k));
	if (unplaced.length > 0) {
		rendered += `\n\n## Inputs\n${unplaced.map((k) => `- ${k}: ${values[k]}\n`).join("")}`;
	}
	return rendered;
}

function jsonEqual(actual: unknown, expected: unknown): boolean {
	if (typeof actual === "boolean" || typeof expected === "boolean") {
		return typeof actual === "boolean" && typeof expected === "boolean" && actual === expected;
	}
	if (actual === null || expected === null) {
		return actual === null && expected === null;
	}
	if (typeof actual === "number" && typeof expected === "number") {
		return actual === expected;
	}
	if (typeof actual === "string" && typeof expected === "string") {
		return actual === expected;
	}
	return false;
}

function guardPasses(when: Record<string, unknown>, outputs: Record<string, unknown>): boolean {
	const port = String(when.output ?? "");
	let value: unknown;
	let found = false;
	const guardPath = typeof when.path === "string" && when.path ? when.path : null;
	if (guardPath) {
		let current: unknown = outputs[port];
		if (isRecord(current)) {
			found = true;
			for (const part of guardPath.split(".")) {
				if (isRecord(current) && part in current) {
					current = current[part];
				} else {
					found = false;
					break;
				}
			}
			value = current;
		}
	} else if (port in outputs) {
		found = true;
		value = outputs[port];
	}
	const op = when.op;
	if (op === "exists") return found;
	if (!found) return false;
	if (op === "eq") return jsonEqual(value, when.value);
	if (op === "ne") return !jsonEqual(value, when.value);
	if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
		const bound = when.value;
		if (typeof value !== "number" || typeof bound !== "number") return false;
		if (op === "gt") return value > bound;
		if (op === "gte") return value >= bound;
		if (op === "lt") return value < bound;
		return value <= bound;
	}
	if (op === "contains") {
		const needle = when.value;
		if (!Array.isArray(needle) || needle.length === 0) return false;
		if (Array.isArray(value)) {
			return needle.every((item) => value.some((v) => jsonEqual(v, item)));
		}
		if (typeof value === "string") {
			return needle.every((item) => typeof item === "string" && value.includes(item));
		}
		return false;
	}
	return false;
}

class JsStateProcess {
	proc: ChildProcess;
	exitCode: number | null = null;
	exitPromise: Promise<number>;
	private stderrChunks: string[] = [];

	private constructor(
		proc: ChildProcess,
		private readonly tmpDir: string,
		private readonly outputPath: string,
	) {
		this.proc = proc;
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrChunks.push(chunk.toString("utf8"));
		});
		proc.stdout?.on("data", (chunk: Buffer) => {
			// User logs in the JS state go to stderr
			this.stderrChunks.push(chunk.toString("utf8"));
		});
		this.exitPromise = new Promise<number>((resolve) => {
			proc.once("close", (code) => {
				this.exitCode = code ?? -1;
				resolve(this.exitCode);
			});
			proc.once("error", () => {
				this.exitCode = -1;
				resolve(-1);
			});
		});
	}

	static start(target: { import: string; callable: string }, inputs: Record<string, unknown>): JsStateProcess {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-factory-js-"));
		const inputPath = path.join(tmpDir, "in.json");
		const outputPath = path.join(tmpDir, "out.json");
		fs.writeFileSync(inputPath, JSON.stringify(inputs), "utf8");
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(childEnv())) {
			if (!k.startsWith("RLM_")) env[k] = v;
		}
		const bunBin = resolveBunBinary();
		const proc = spawnProcess(
			bunBin,
			["-e", JS_STATE_RUNNER, target.import, target.callable, inputPath, outputPath],
			{
				cwd: process.cwd(),
				env,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		return new JsStateProcess(proc, tmpDir, outputPath);
	}

	private killGroup(): void {
		if (this.proc.pid) {
			if (process.platform !== "win32") {
				signalGroup(this.proc.pid, "SIGKILL");
			} else {
				try {
					this.proc.kill("SIGKILL");
				} catch {
					// ignore
				}
			}
		}
	}

	async stop(): Promise<void> {
		this.killGroup();
		await this.exitPromise;
		this.finish();
	}

	finish(): { stdout: string; stderr: string } {
		this.killGroup();
		let stdout = "";
		try {
			stdout = fs.readFileSync(this.outputPath, "utf8");
		} catch {
			stdout = "";
		}
		const stderrFull = this.stderrChunks.join("");
		const stderr = stderrFull.slice(-JS_STDERR_TAIL_CAP).trim();
		try {
			fs.rmSync(this.tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		return { stdout, stderr };
	}
}

function validateJsOutputs(
	stateSpec: Record<string, unknown>,
	stdout: string,
): Record<string, unknown> | string {
	let outputs: unknown;
	try {
		outputs = JSON.parse(stdout);
	} catch {
		return "javascript state did not write one JSON object to stdout";
	}
	if (!isRecord(outputs)) {
		return `javascript state returned ${Array.isArray(outputs) ? "array" : typeof outputs}, not an object`;
	}
	const declared = declaredPortTypes(stateSpec, "outputs");
	const gotKeys = Object.keys(outputs).sort();
	const expectedKeys = Object.keys(declared).sort();
	if (gotKeys.length !== expectedKeys.length || gotKeys.some((k, i) => k !== expectedKeys[i])) {
		return `javascript state returned keys ${JSON.stringify(gotKeys)} but declares outputs ${JSON.stringify(expectedKeys)}`;
	}
	for (const [name, portType] of Object.entries(declared)) {
		if (portType === "text" && typeof outputs[name] !== "string") {
			return `javascript state output ${JSON.stringify(name)} is text but the call returned ${typeof outputs[name]}`;
		}
	}
	return outputs;
}

function validateSpawnSettings(model: unknown, thinking: unknown): string | null {
	for (const [key, value] of [
		["model", model],
		["thinking", thinking],
	] as const) {
		if (value !== undefined && value !== null && (typeof value !== "string" || !value.trim())) {
			return `subagent ${key} must be a non-empty string when provided`;
		}
	}
	return null;
}

interface NodeInstance {
	index: number;
	prompt: string;
	status: "pending" | "running" | "done" | "error" | "cancelled";
	attempt: number;
	retryBase: number;
	infraRespawned: boolean;
	captureFailed: boolean;
	rateLimitStreak: number;
	childId: string | null;
	spawnedAt: number | null;
	durationMs: number | null;
	answer: string | null;
	provisional: boolean;
	error: string | null;
	toolUses: number;
	inputs: Record<string, unknown> | null;
	process: JsStateProcess | null;
	deadline: number | null;
}

interface StateEntry {
	index: number;
	status: "pending" | "running" | "done" | "error" | "cancelled";
	instances: NodeInstance[];
	error: string | null;
	answer: string | null;
	outputs: Record<string, unknown> | null;
	outputErrors: Record<string, string> | null;
	isSettle: boolean;
	consumed: boolean;
	needsVerify: boolean;
}

class StateRun {
	entriesUsed = 0;
	entries: StateEntry[] = [];
	instanceCounter = 0;
	error: string | null = null;
	cancelled = false;

	constructor(
		readonly stateId: string,
		readonly spec: Record<string, unknown>,
		readonly position: number,
		readonly promptTemplate: string | null,
		readonly name: string | null,
		readonly model: string | null,
		readonly thinking: string | null,
		readonly maxEntries: number,
	) {}

	get lifecycle(): string {
		return (this.spec.lifecycle as string | undefined) ?? NODE_LIFECYCLE_DEFAULT;
	}

	get status(): string {
		if (this.entries.length > 0) return this.entries[this.entries.length - 1]!.status;
		return this.cancelled ? "cancelled" : "pending";
	}

	latestSettle(): StateEntry | null {
		for (let i = this.entries.length - 1; i >= 0; i -= 1) {
			if (this.entries[i]!.isSettle) return this.entries[i]!;
		}
		return null;
	}
}

export interface FactoryRun {
	runId: string;
	specId: string;
	name: string | null;
	machine: Record<string, unknown>;
	state: "running" | "stopping" | "paused" | "done" | "failed" | "stopped";
	startedAt: number;
	maxParallel: number;
	maxTransitions: number;
	maxChildren: number;
	maxTransitionsReported: boolean;
	maxChildrenReported: boolean;
	runBudgetMs: number | null;
	budgetReported: boolean;
	pauseReason: string | null;
	lastError: string | null;
	states: Map<string, StateRun>;
	order: string[];
	transitionsFrom: Map<string, Array<{ id: number; transition: Record<string, unknown> }>>;
	pendingEvaluations: Array<[string, number, number]>;
	events: Array<Record<string, unknown>>;
	milestones: Set<string>;
	spawnCount: number;
	settleCount: number;
	transitionsFired: number;
	toolUseTotal: number;
	task: Promise<void> | null;
	loopGeneration: number;
	admissionBackoffUntil: number | null;
	joinFired: Map<string, string>;
	revision: number;
	watchers: Array<(rev: number) => void>;
}

export interface FactorySpawnHandle {
	rlmChildId: string;
	name?: string;
}

export interface FactoryCollectRow {
	rlmChildId: string;
	status: string;
	settled: boolean;
	answerPreview?: string | null;
	answerText?: string | null;
	error?: string | null;
	durationMs?: number | null;
	toolUseCount?: number | null;
}

export interface FactoryExecutorDeps {
	now?: () => number;
	sleep?: (seconds: number) => Promise<void>;
	harness?: {
		get(kind: string, id: string): { id: string; title: string; content: string; arguments: Record<string, unknown>; metadata: Record<string, unknown> } | null;
		list(kind: string): Array<{ id: string; title: string; content: string; arguments: Record<string, unknown>; metadata: Record<string, unknown> }>;
	};
	spawn?: (
		prompt: string,
		opts: { name: string; model?: string; thinking?: string; factory?: { runId: string; specId: string; stateId: string } },
	) => Promise<FactorySpawnHandle>;
	collect?: (targets: string[], opts: { timeoutMs: number }) => Promise<FactoryCollectRow[]>;
	deleteSubagent?: (childId: string) => Promise<unknown>;
	progress?: (payload: Record<string, unknown>) => Promise<unknown>;
}

function defaultNow(): number {
	return performance.now() / 1000;
}

function defaultSleep(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)));
}

function machineStructure(
	machine: Record<string, unknown>,
	resolved?: Map<string, [string | null, string | null]>,
): Record<string, unknown> {
	const runBlock = isRecord(machine.run) ? machine.run : {};
	const runOut: Record<string, unknown> = {
		max_parallel: runBlock.max_parallel ?? RUN_MAX_PARALLEL_DEFAULT,
		max_transitions: runBlock.max_transitions ?? MAX_TRANSITIONS_CAP,
		failure_policy: runBlock.failure_policy ?? RUN_FAILURE_POLICY_DEFAULT,
		max_children: runBlock.max_children ?? RUN_MAX_CHILDREN_DEFAULT,
	};
	if ("budget_ms" in runBlock) runOut.budget_ms = runBlock.budget_ms;

	const statesIn = Array.isArray(machine.states) ? (machine.states as Record<string, unknown>[]) : [];
	const statesOut = statesIn.map((state) => {
		const stateId = String(state.id);
		const row: Record<string, unknown> = {
			id: stateId,
			entry: Boolean(state.entry ?? STATE_ENTRY_DEFAULT),
			lifecycle: state.lifecycle ?? NODE_LIFECYCLE_DEFAULT,
			max_entries: state.max_entries ?? STATE_MAX_ENTRIES_DEFAULT,
			retries: state.retries ?? NODE_RETRIES_DEFAULT,
		};
		let [model, thinking] = resolved?.get(stateId) ?? [null, null];
		const sub = state.subagent;
		if ("javascript" in state && isRecord(state.javascript)) {
			row.javascript = `${state.javascript.import}.${state.javascript.callable}`;
		} else if (isRecord(sub)) {
			if (model === null && typeof sub.model === "string") model = sub.model;
			if (thinking === null && typeof sub.thinking === "string") thinking = sub.thinking;
			if (typeof sub.name === "string" && sub.name) row.subagent = sub.name;
		} else if (typeof sub === "string") {
			row.subagent = sub;
		}
		if (model !== null) row.model = model;
		if (thinking !== null) row.thinking = thinking;
		return row;
	});

	const transitionsIn = Array.isArray(machine.transitions) ? (machine.transitions as Record<string, unknown>[]) : [];
	const transitionsOut = transitionsIn.map((t) => {
		const row: Record<string, unknown> = {
			from: structuredClone(t.from),
			to: t.to,
			on: t.on ?? TRANSITION_ON_KINDS[0],
		};
		if ("when" in t && t.when !== undefined) row.when = structuredClone(t.when);
		return row;
	});

	return {
		run: runOut,
		states: statesOut,
		transitions: transitionsOut,
		order: statesIn.map((s) => String(s.id)),
	};
}

function wireKey(key: string): string {
	const parts = key.split("_");
	return parts[0] + parts.slice(1).map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : "")).join("");
}

export function wirePayload(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(wirePayload);
	if (isRecord(value)) {
		if ("output" in value && "op" in value) return structuredClone(value);
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[wireKey(k)] = wirePayload(v);
		}
		return out;
	}
	return value;
}

export class FactoryExecutor {
	private readonly nowFn: () => number;
	private readonly sleepFn: (seconds: number) => Promise<void>;
	private readonly deps: FactoryExecutorDeps;
	readonly runs = new Map<string, FactoryRun>();

	constructor(deps: FactoryExecutorDeps = {}) {
		this.deps = deps;
		this.nowFn = deps.now ?? defaultNow;
		this.sleepFn = deps.sleep ?? defaultSleep;
	}

	private async resolveHarness(): Promise<NonNullable<FactoryExecutorDeps["harness"]>> {
		if (this.deps.harness) return this.deps.harness;
		const { harnessProxy } = await import("./harness.ts");
		return harnessProxy as unknown as NonNullable<FactoryExecutorDeps["harness"]>;
	}

	private async spawnChild(
		prompt: string,
		opts: { name: string; model?: string; thinking?: string; factory?: { runId: string; specId: string; stateId: string } },
	): Promise<FactorySpawnHandle> {
		if (this.deps.spawn) return this.deps.spawn(prompt, opts);
		const { _spawnWithFactory } = await import("./rlm.ts");
		return _spawnWithFactory(prompt, opts);
	}

	private async collectChildren(targets: string[], timeoutMs: number): Promise<FactoryCollectRow[]> {
		if (this.deps.collect) return this.deps.collect(targets, { timeoutMs });
		const { collect } = await import("./rlm.ts");
		return collect(targets, { timeoutMs });
	}

	private async deleteChild(childId: string): Promise<void> {
		if (this.deps.deleteSubagent) {
			await this.deps.deleteSubagent(childId);
			return;
		}
		const { deleteSubagent } = await import("./rlm.ts");
		await deleteSubagent(childId);
	}

	private async sendProgress(payload: Record<string, unknown>): Promise<void> {
		if (this.deps.progress) {
			await this.deps.progress(payload);
			return;
		}
		await hostRequest("factory.progress", payload);
	}

	async run(specId: string, opts?: { name?: string }): Promise<Record<string, unknown>> {
		const harness = await this.resolveHarness();
		const entry = harness.get("factory", specId);
		if (!entry) throw new Error(`unknown factory spec ${JSON.stringify(specId)}`);
		const args = isRecord(entry.arguments) ? entry.arguments : {};
		const spec = args.machine !== undefined && args.machine !== null ? args.machine : args.dag;
		const canonical = canonicalizeFactorySpec(spec);
		const [resolved, refErrors] = this.resolveSubagents(harness, canonical);
		if (refErrors.length > 0) throw new Error(refErrors.join("; "));
		const run = this.createRun(entry.id, canonical, resolved, opts?.name ?? null);
		return this.launchRun(run);
	}

	async runMachine(
		machine: MachineFile,
		opts?: { machinePath?: string; name?: string },
	): Promise<Record<string, unknown>> {
		const canonical = canonicalizeFactorySpec(machine.spec);
		const harness = await this.resolveHarness();
		const [resolved, refErrors] = this.resolveSubagents(harness, canonical);
		if (refErrors.length > 0) throw new Error(refErrors.join("; "));
		const run = this.createRun(machine.name, canonical, resolved, opts?.name ?? null);
		const result = await this.launchRun(run);
		result.machine = machine.name;
		if (opts?.machinePath) result.machine_path = opts.machinePath;
		return result;
	}

	private async launchRun(run: FactoryRun): Promise<Record<string, unknown>> {
		this.runs.set(run.runId, run);
		this.event(run, "run_started", { detail: `${run.states.size} states, max_parallel ${run.maxParallel}` });
		for (const stateId of run.order) {
			const state = run.states.get(stateId)!;
			if (state.spec.entry === true) {
				this.enterState(run, state, null);
			}
		}
		const started = await this.spawnReady(run, run.loopGeneration, false);
		if (this.runComplete(run)) {
			await this.finalize(run);
		} else if (run.state === "running") {
			this.startLoop(run);
		}
		return {
			run_id: run.runId,
			spec_id: run.specId,
			name: run.name,
			nodes: run.states.size,
			max_parallel: run.maxParallel,
			started,
			pending: this.pendingStateIds(run),
		};
	}

	async status(runId: string): Promise<Record<string, unknown>> {
		const run = this.requireRun(runId);
		const nodes = run.order.map((id) => this.stateReport(run.states.get(id)!, true));
		for (const evt of run.events) {
			if (evt.stage === "recorded" || evt.stage === "arrived") evt.stage = "delivered";
		}
		const payload: Record<string, unknown> = {
			run_id: run.runId,
			spec_id: run.specId,
			name: run.name,
			state: run.state,
			nodes,
			events: run.events.slice(-EVENT_WINDOW).map((e) => ({ ...e })),
			elapsed_ms: Math.trunc((this.nowFn() - run.startedAt) * 1000),
			usage: this.usageReport(run),
		};
		const needsVerify = run.order.filter((id) => run.states.get(id)!.entries.some((e) => e.needsVerify));
		if (needsVerify.length > 0) payload.needs_verify = needsVerify;
		if (run.state === "paused") {
			payload.pause_reason = run.pauseReason;
			if (run.lastError !== null) {
				payload.last_error = run.lastError;
				payload.remedy =
					`resume with await rlm.factory.resume('${run.runId}') to re-admit the ` +
					"failed state's entry as a fresh attempt (same rendered prompt, no extra " +
					"max_entries); author the state with failure_policy 'continue' to run its dependents past a failure instead";
			}
		}
		return payload;
	}

	async stop(runId: string): Promise<Record<string, unknown>> {
		const run = this.requireRun(runId);
		if (run.state === "stopping" || run.state === "stopped") {
			return { run_id: run.runId, state: run.state, cancelled: [] };
		}
		run.state = "stopping";
		this.touch(run);
		const stopped = await this.haltNonterminal(run, "run stopped");
		run.state = "stopped";
		this.event(run, "run_stopped", { detail: `stopped; ${stopped.length} state(s) cancelled` });
		return { run_id: run.runId, state: "stopped", cancelled: stopped };
	}

	async resume(runId: string): Promise<Record<string, unknown>> {
		const run = this.requireRun(runId);
		if (run.state !== "paused") {
			throw new Error(`factory run ${JSON.stringify(runId)} is ${JSON.stringify(run.state)}, not paused`);
		}
		run.loopGeneration += 1;
		run.state = "running";
		run.pauseReason = null;
		run.milestones.delete("paused");
		this.touch(run);
		this.event(run, "resumed", { detail: "resumed by caller" });
		this.readmitHeldEntries(run);
		await this.evaluateSettles(run);
		const started = await this.spawnReady(run, run.loopGeneration, false);
		if (this.runComplete(run)) {
			await this.finalize(run);
		} else if (run.state === "running") {
			this.startLoop(run);
		}
		return {
			run_id: run.runId,
			state: run.state,
			started,
			pending: this.pendingStateIds(run),
		};
	}

	private readmitHeldEntries(run: FactoryRun): void {
		for (const stateId of run.order) {
			const state = run.states.get(stateId)!;
			for (const entry of state.entries) {
				if (entry.status !== "error" || entry.isSettle) continue;
				entry.status = entry.instances.length > 0 ? "running" : "pending";
				entry.error = null;
				entry.needsVerify = false;
				state.error = null;
				for (const instance of entry.instances) {
					if (instance.status !== "error" && instance.status !== "cancelled") continue;
					instance.status = "pending";
					instance.error = null;
					instance.answer = null;
					instance.provisional = false;
					instance.captureFailed = false;
					instance.rateLimitStreak = 0;
					instance.retryBase = instance.attempt;
					instance.infraRespawned = false;
				}
				this.event(run, "readmitted", {
					node: stateId,
					entry: entry.index,
					detail: "resume re-admits the failed entry (same rendered prompt)",
				});
			}
		}
	}

	async graph(ref?: string, opts?: { compact?: boolean }): Promise<Record<string, unknown>> {
		const compact = Boolean(opts?.compact);
		if (ref === undefined || ref === null) {
			const terminalIds = [...this.runs.values()]
				.filter((r) => !WIRE_LIVE_RUN_STATES.has(r.state) && this.runningInstanceCount(r) === 0)
				.map((r) => r.runId);
			const newestTerminal = new Set(terminalIds.slice(-GRAPH_RUNS_WINDOW));
			return {
				runs: [...this.runs.values()]
					.filter(
						(r) =>
							WIRE_LIVE_RUN_STATES.has(r.state) ||
							this.runningInstanceCount(r) > 0 ||
							newestTerminal.has(r.runId),
					)
					.map((r) => this.graphSnapshot(r, compact)),
			};
		}
		const run = this.runs.get(ref);
		if (run) return this.graphSnapshot(run, compact);
		const harness = await this.resolveHarness();
		const entry = harness.get("factory", ref);
		if (!entry) throw new Error(`unknown factory run or spec ${JSON.stringify(ref)}`);
		const args = isRecord(entry.arguments) ? entry.arguments : {};
		const spec = args.machine !== undefined && args.machine !== null ? args.machine : args.dag;
		let canonical: Record<string, unknown>;
		try {
			canonical = canonicalizeFactorySpec(spec);
		} catch (error) {
			throw new Error(`factory spec ${JSON.stringify(ref)} does not validate: ${error instanceof Error ? error.message : String(error)}`);
		}
		return this.specSnapshot(entry.id, canonical);
	}

	async watch(runId: string, timeout = 0, opts?: { compact?: boolean }): Promise<Record<string, unknown>> {
		const compact = Boolean(opts?.compact);
		const run = this.requireRun(runId);
		if (!isNumber(timeout) || timeout < 0) {
			throw new Error("timeout must be a non-negative number of seconds");
		}
		const bounded = Math.min(timeout, WATCH_TIMEOUT_CAP_SECONDS);
		const deadline = this.nowFn() + bounded;
		const baseline = this.signature(run);
		let changed = false;
		while (true) {
			if (this.signature(run) !== baseline) {
				changed = true;
				break;
			}
			const remaining = deadline - this.nowFn();
			if (remaining <= 0) break;
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					const idx = run.watchers.indexOf(onTouch);
					if (idx >= 0) run.watchers.splice(idx, 1);
					resolve();
				};
				const onTouch = () => finish();
				run.watchers.push(onTouch);
				void this.sleepFn(remaining).then(finish);
			});
		}
		return { changed, ...this.graphSnapshot(run, compact) };
	}

	async activity(request: Record<string, unknown>): Promise<unknown> {
		requireFactoryEnabled();
		const action = request.action;
		if (typeof action !== "string" || !(ACTIVITY_ACTIONS as readonly string[]).includes(action)) {
			throw new Error(`unknown factory activity action ${JSON.stringify(action)}`);
		}
		const runId = request.runId;
		const specId = request.specId;
		for (const [k, v] of [
			["runId", runId],
			["specId", specId],
		] as const) {
			if (v !== undefined && v !== null && typeof v !== "string") {
				throw new Error(`factory activity ${k} must be a string when provided`);
			}
		}
		const timeoutMs = request.timeoutMs === undefined || request.timeoutMs === null ? 0 : request.timeoutMs;
		if (!isInt(timeoutMs) || timeoutMs < 0 || timeoutMs > ACTIVITY_TIMEOUT_MS_CAP) {
			throw new Error(`factory activity timeoutMs must be an integer between 0 and ${ACTIVITY_TIMEOUT_MS_CAP}`);
		}
		if (action === "graph") {
			const ref = (runId as string | undefined) || (specId as string | undefined);
			return wirePayload(await this.graph(ref, { compact: true }));
		}
		if (action === "status") {
			if (!runId) throw new Error("factory activity status requires runId");
			return wirePayload(await this.status(runId as string));
		}
		if (action === "watch") {
			if (!runId) throw new Error("factory activity watch requires runId");
			return wirePayload(await this.watch(runId as string, timeoutMs / 1000, { compact: true }));
		}
		if (action === "run") {
			if (!specId) throw new Error("factory activity run requires specId");
			return wirePayload(await this.run(specId as string));
		}
		if (!runId) throw new Error(`factory activity ${action} requires runId`);
		if (action === "stop") return wirePayload(await this.stop(runId as string));
		return wirePayload(await this.resume(runId as string));
	}

	private requireRun(runId: string): FactoryRun {
		const run = this.runs.get(runId);
		if (!run) throw new Error(`unknown factory run ${JSON.stringify(runId)}`);
		return run;
	}

	private resolveSubagents(
		harness: NonNullable<FactoryExecutorDeps["harness"]>,
		canonical: Record<string, unknown>,
	): [Map<string, [string, string | null, string | null, string | null]>, string[]] {
		const resolved = new Map<string, [string, string | null, string | null, string | null]>();
		const errors: string[] = [];
		for (const stateSpec of canonical.states as Record<string, unknown>[]) {
			const stateId = String(stateSpec.id);
			if ("javascript" in stateSpec) continue;
			const ref = stateSpec.subagent;
			let prompt: unknown;
			let name: string | null = null;
			let model: unknown;
			let thinking: unknown;
			if (isRecord(ref)) {
				prompt = ref.prompt;
				name = typeof ref.name === "string" && ref.name.trim() ? ref.name.trim() : null;
				model = ref.model;
				thinking = ref.thinking;
			} else {
				const refStr = String(ref);
				let entry = harness.get("subagent", refStr);
				if (!entry) {
					entry = harness.list("subagent").find((row) => row.title === refStr) ?? null;
				}
				if (!entry) {
					errors.push(`state ${JSON.stringify(stateId)} references unknown subagent ${JSON.stringify(refStr)}`);
					continue;
				}
				prompt = entry.content;
				const meta = isRecord(entry.metadata) ? entry.metadata : {};
				model = meta.model;
				thinking = meta.thinking;
			}
			if (typeof prompt !== "string" || !prompt.trim()) {
				errors.push(`state ${JSON.stringify(stateId)} has an empty subagent prompt`);
				continue;
			}
			const settingsErr = validateSpawnSettings(model, thinking);
			if (settingsErr) {
				errors.push(`state ${JSON.stringify(stateId)} ${settingsErr}`);
				continue;
			}
			resolved.set(stateId, [
				prompt,
				name,
				typeof model === "string" ? model : null,
				typeof thinking === "string" ? thinking : null,
			]);
		}
		return [resolved, errors];
	}

	private createRun(
		specId: string,
		canonical: Record<string, unknown>,
		resolved: Map<string, [string, string | null, string | null, string | null]>,
		name: string | null,
	): FactoryRun {
		const runSpec = canonical.run as Record<string, unknown>;
		const run: FactoryRun = {
			runId: randomUUID().replace(/-/g, ""),
			specId,
			name,
			machine: canonical,
			state: "running",
			startedAt: this.nowFn(),
			maxParallel: Number(runSpec.max_parallel),
			maxTransitions: Number(runSpec.max_transitions),
			maxChildren: Number(runSpec.max_children),
			maxTransitionsReported: false,
			maxChildrenReported: false,
			runBudgetMs: typeof runSpec.budget_ms === "number" ? runSpec.budget_ms : null,
			budgetReported: false,
			pauseReason: null,
			lastError: null,
			states: new Map(),
			order: [],
			transitionsFrom: new Map(),
			pendingEvaluations: [],
			events: [],
			milestones: new Set(),
			spawnCount: 0,
			settleCount: 0,
			transitionsFired: 0,
			toolUseTotal: 0,
			task: null,
			loopGeneration: 0,
			admissionBackoffUntil: null,
			joinFired: new Map(),
			revision: 0,
			watchers: [],
		};

		const statesIn = canonical.states as Record<string, unknown>[];
		statesIn.forEach((stateSpec, position) => {
			const stateId = String(stateSpec.id);
			const [prompt, stateName, model, thinking] = resolved.get(stateId) ?? [null, null, null, null];
			run.states.set(
				stateId,
				new StateRun(
					stateId,
					stateSpec,
					position,
					prompt,
					stateName,
					model,
					thinking,
					Number(stateSpec.max_entries ?? STATE_MAX_ENTRIES_DEFAULT),
				),
			);
			run.order.push(stateId);
		});

		const transitionsIn = (canonical.transitions as Record<string, unknown>[]) ?? [];
		transitionsIn.forEach((transition, id) => {
			const rawFrom = transition.from;
			const sources = Array.isArray(rawFrom) ? (rawFrom as string[]) : [String(rawFrom)];
			for (const src of sources) {
				let list = run.transitionsFrom.get(src);
				if (!list) {
					list = [];
					run.transitionsFrom.set(src, list);
				}
				list.push({ id, transition });
			}
		});
		return run;
	}

	private event(
		run: FactoryRun,
		kind: string,
		fields: Record<string, unknown> = {},
	): Record<string, unknown> {
		const evt: Record<string, unknown> = {
			seq: run.events.length + 1,
			kind,
			stage: (fields.stage as string | undefined) ?? "recorded",
		};
		for (const [k, v] of Object.entries(fields)) {
			if (v !== undefined && v !== null) evt[k] = v;
		}
		run.events.push(evt);
		this.touch(run);
		return evt;
	}

	private touch(run: FactoryRun): void {
		run.revision += 1;
		for (const waiter of run.watchers.splice(0)) {
			waiter(run.revision);
		}
	}

	private async milestone(run: FactoryRun, kind: string, detail: string, node?: string): Promise<void> {
		const evt = this.event(run, "milestone", { milestone: kind, detail, node });
		if (run.milestones.has(kind)) return;
		run.milestones.add(kind);
		try {
			const payload: Record<string, unknown> = { run_id: run.runId, kind, detail };
			if (node !== undefined) payload.node = node;
			await this.sendProgress(payload);
			evt.stage = "shown";
		} catch {
			// Ledger keeps the milestone even if host bridge is unavailable
		}
	}

	private enterState(run: FactoryRun, state: StateRun, fromState: string | null): StateEntry {
		const entry: StateEntry = {
			index: state.entries.length,
			status: "pending",
			instances: [],
			error: null,
			answer: null,
			outputs: null,
			outputErrors: null,
			isSettle: false,
			consumed: false,
			needsVerify: false,
		};
		state.entries.push(entry);
		state.entriesUsed += 1;
		this.event(run, "state_entry", {
			node: state.stateId,
			entry: entry.index,
			detail: fromState === null ? "entry state" : `entered from ${fromState}`,
		});
		return entry;
	}

	private queueSettle(run: FactoryRun, state: StateRun, entry: StateEntry): void {
		entry.isSettle = true;
		run.pendingEvaluations.push([state.stateId, entry.index, 0]);
	}

	private async evaluateSettles(run: FactoryRun): Promise<void> {
		while (run.pendingEvaluations.length > 0 && run.state === "running") {
			const [stateId, entryIndex, resumeFrom] = run.pendingEvaluations.shift()!;
			const state = run.states.get(stateId)!;
			const entry = state.entries[entryIndex]!;
			if (entry.consumed || !entry.isSettle) continue;
			entry.consumed = true;
			const outputs = entry.outputs ?? {};
			const transitions = run.transitionsFrom.get(stateId) ?? [];

			for (let tIndex = 0; tIndex < transitions.length; tIndex += 1) {
				if (tIndex < resumeFrom) continue;
				const { id: tid, transition } = transitions[tIndex]!;
				const rawFrom = transition.from;
				let joinClaim: [string, string] | null = null;

				if (Array.isArray(rawFrom)) {
					const sources = rawFrom as string[];
					const parts: string[] = [];
					let allSettled = true;
					for (const srcId of sources) {
						const srcState = run.states.get(srcId);
						const latest = srcState?.latestSettle() ?? null;
						if (!latest) {
							allSettled = false;
							break;
						}
						parts.push(`${srcId}:${latest.index}`);
					}
					if (!allSettled) continue;
					parts.sort();
					const signature = parts.join(",");
					const key = `${tid}:${transition.to}`;
					if (run.joinFired.get(key) === signature) continue;
					joinClaim = [key, signature];
				} else {
					const when = transition.when;
					if (isRecord(when) && !guardPasses(when, outputs)) continue;
				}

				const target = run.states.get(String(transition.to))!;
				if (target.entriesUsed >= target.maxEntries) {
					if (joinClaim) run.joinFired.set(joinClaim[0], joinClaim[1]);
					this.event(run, "transition_blocked", {
						detail: `state ${JSON.stringify(target.stateId)} is at max_entries ${target.maxEntries}; transition ${JSON.stringify(rawFrom)} -> ${JSON.stringify(target.stateId)} blocked`,
						from: rawFrom,
						to: target.stateId,
					});
					continue;
				}
				if (run.transitionsFired >= run.maxTransitions && !run.maxTransitionsReported) {
					run.maxTransitionsReported = true;
					entry.consumed = false;
					run.pendingEvaluations.unshift([stateId, entryIndex, tIndex]);
					run.state = "paused";
					run.pauseReason = "max_transitions exceeded";
					await this.milestone(
						run,
						"max_transitions_exceeded",
						`max_transitions ${run.maxTransitions} exceeded; no new entries; resume with await rlm.factory.resume('${run.runId}')`,
					);
					return;
				}
				if (joinClaim) run.joinFired.set(joinClaim[0], joinClaim[1]);
				run.transitionsFired += 1;
				const firedFields: Record<string, unknown> = {
					detail: `${JSON.stringify(rawFrom)} -> ${JSON.stringify(target.stateId)}`,
					from: rawFrom,
					to: target.stateId,
				};
				if (isRecord(transition.when)) firedFields.when = structuredClone(transition.when);
				this.event(run, "transition_fired", firedFields);
				this.enterState(run, target, stateId);
			}
		}
	}

	private loopAlive(run: FactoryRun, generation: number): boolean {
		return run.state === "running" && run.loopGeneration === generation;
	}

	private runBudgetExceeded(run: FactoryRun): boolean {
		if (run.runBudgetMs === null || run.budgetReported) return false;
		return (this.nowFn() - run.startedAt) * 1000 > run.runBudgetMs;
	}

	private async pauseForBudget(run: FactoryRun): Promise<void> {
		const elapsedMs = (this.nowFn() - run.startedAt) * 1000;
		run.state = "paused";
		run.pauseReason = "run budget exceeded";
		run.budgetReported = true;
		await this.milestone(
			run,
			"budget_exceeded",
			`run budget_ms ${run.runBudgetMs} exceeded after ${Math.trunc(elapsedMs)}ms; no new spawns; resume with await rlm.factory.resume('${run.runId}')`,
		);
	}

	private childrenBudgetExceeded(run: FactoryRun): boolean {
		return !run.maxChildrenReported && run.spawnCount >= run.maxChildren;
	}

	private async pauseForChildren(run: FactoryRun): Promise<void> {
		run.state = "paused";
		run.pauseReason = "max_children exceeded";
		run.maxChildrenReported = true;
		await this.milestone(
			run,
			"max_children_exceeded",
			`run max_children ${run.maxChildren} exceeded after ${run.spawnCount} children; no new spawns; resume with await rlm.factory.resume('${run.runId}')`,
		);
	}

	private async spawnReady(run: FactoryRun, generation: number, allowBackoff: boolean): Promise<string[]> {
		const started: string[] = [];
		while (this.loopAlive(run, generation)) {
			await this.prepareReadyEntries(run);
			if (!this.loopAlive(run, generation)) break;
			if (this.runBudgetExceeded(run)) {
				await this.pauseForBudget(run);
				break;
			}
			if (run.admissionBackoffUntil !== null && this.nowFn() < run.admissionBackoffUntil) break;
			if (this.runningInstanceCount(run) >= run.maxParallel) break;
			const next = this.nextPendingInstance(run);
			if (!next) break;
			const [state, entry, instance] = next;
			const isJs = "javascript" in state.spec;
			if (!isJs && this.childrenBudgetExceeded(run)) {
				await this.pauseForChildren(run);
				break;
			}
			const outcome = isJs
				? await this.startJavaScript(run, state, entry, instance)
				: await this.admit(run, state, entry, instance, allowBackoff);
			if (outcome === "admitted" && !started.includes(state.stateId)) {
				started.push(state.stateId);
			}
			if (outcome === "stopped" || outcome === "deferred") break;
		}
		return started;
	}

	private async prepareReadyEntries(run: FactoryRun): Promise<void> {
		for (const stateId of run.order) {
			const state = run.states.get(stateId)!;
			for (const entry of state.entries) {
				if (entry.status !== "pending") continue;
				const [instances, reason] = this.prepareEntry(run, state, entry);
				if (reason !== null) {
					await this.applyEntryFailurePolicy(run, state, entry, reason);
					if (run.state !== "running") return;
					continue;
				}
				if (instances === null) continue;
				entry.instances = instances;
				if (instances.length > 0) {
					entry.status = "running";
					this.event(run, "node_ready", {
						node: stateId,
						entry: entry.index,
						detail: `${instances.length} instance(s) prepared`,
					});
				} else {
					entry.status = "done";
					this.event(run, "node_ready", {
						node: stateId,
						entry: entry.index,
						detail: "foreach expanded to zero items; nothing to run",
					});
					this.queueSettle(run, state, entry);
				}
			}
		}
	}

	private makeInstance(index: number, prompt: string, inputs: Record<string, unknown> | null = null): NodeInstance {
		return {
			index,
			prompt,
			status: "pending",
			attempt: 0,
			retryBase: 0,
			infraRespawned: false,
			captureFailed: false,
			rateLimitStreak: 0,
			childId: null,
			spawnedAt: null,
			durationMs: null,
			answer: null,
			provisional: false,
			error: null,
			toolUses: 0,
			inputs,
			process: null,
			deadline: null,
		};
	}

	private prepareEntry(
		run: FactoryRun,
		state: StateRun,
		_entry: StateEntry,
	): [NodeInstance[] | null, string | null] {
		const bound: Record<string, unknown> = {};
		const foreach = isRecord(state.spec.foreach) ? state.spec.foreach : null;
		let items: unknown[] | null = null;
		const inputsList = Array.isArray(state.spec.inputs) ? (state.spec.inputs as Record<string, unknown>[]) : [];

		for (const inp of inputsList) {
			const name = String(inp.name);
			const portType = String(inp.type);
			const source = String(inp.from);
			const dot = source.indexOf(".");
			const srcId = source.slice(0, dot);
			const srcOutput = source.slice(dot + 1);
			const sourceState = run.states.get(srcId);
			const latest = sourceState?.latestSettle() ?? null;
			let value: unknown = null;
			let failure: string | null = null;

			if (latest !== null) {
				if (latest.status === "error") {
					failure = `input ${JSON.stringify(name)} from state ${JSON.stringify(srcId)} is unavailable (latest settle status 'error')`;
				} else {
					const outputs = latest.outputs ?? {};
					const outputErrors = latest.outputErrors ?? {};
					if (srcOutput in outputErrors) {
						failure = `input ${JSON.stringify(name)}: ${outputErrors[srcOutput]}`;
					} else if (!(srcOutput in outputs)) {
						failure = `input ${JSON.stringify(name)} from state ${JSON.stringify(srcId)} has no captured output ${JSON.stringify(srcOutput)}`;
					} else {
						value = outputs[srcOutput];
					}
				}
			}

			if (latest === null || failure !== null) {
				if (inp.optional === true) {
					if (latest === null && srcId !== state.stateId) {
						const live = sourceState?.entries.some((o) => o.status === "pending" || o.status === "running") ?? false;
						if (live) return [null, null];
					}
					if (foreach && foreach.over === name) {
						items = [];
						continue;
					}
					bound[name] = null;
					continue;
				}
				if (latest === null) return [null, null];
				return [null, failure];
			}

			if (portType === "text") {
				bound[name] = typeof value === "string" ? value : JSON.stringify(value);
				continue;
			}
			if (foreach && foreach.over === name) {
				if (!Array.isArray(value)) {
					return [null, `foreach.over input ${JSON.stringify(name)} is not a JSON list`];
				}
				items = value;
				continue;
			}
			bound[name] = value;
		}

		if ("javascript" in state.spec) {
			const instance = this.makeInstance(state.instanceCounter, "", bound);
			state.instanceCounter += 1;
			return [[instance], null];
		}

		const portTypes = Object.fromEntries(inputsList.map((i) => [String(i.name), String(i.type)]));
		const values: Record<string, string> = {};
		for (const [k, v] of Object.entries(bound)) {
			values[k] = portTypes[k] === "json" ? JSON.stringify(v) : v === null ? "null" : String(v);
		}
		if (!foreach) {
			const instance = this.makeInstance(state.instanceCounter, renderPrompt(state.promptTemplate!, values));
			state.instanceCounter += 1;
			return [[instance], null];
		}
		if (items === null) return [null, "foreach entry did not resolve its over input"];
		const maxItems = Number(foreach.max);
		const overKey = String(foreach.over);
		const instances: NodeInstance[] = [];
		for (const item of items.slice(0, maxItems)) {
			const itemVal = typeof item === "string" ? item : JSON.stringify(item);
			instances.push(
				this.makeInstance(
					state.instanceCounter + instances.length,
					renderPrompt(state.promptTemplate!, { ...values, [overKey]: itemVal }),
				),
			);
		}
		state.instanceCounter += instances.length;
		return [instances, null];
	}

	private nextPendingInstance(run: FactoryRun): [StateRun, StateEntry, NodeInstance] | null {
		for (const stateId of run.order) {
			const state = run.states.get(stateId)!;
			for (const entry of state.entries) {
				if (entry.status !== "running") continue;
				for (const instance of entry.instances) {
					if (instance.status === "pending") return [state, entry, instance];
				}
			}
		}
		return null;
	}

	private async admit(
		run: FactoryRun,
		state: StateRun,
		entry: StateEntry,
		instance: NodeInstance,
		allowBackoff: boolean,
	): Promise<"admitted" | "deferred" | "failed" | "stopped"> {
		instance.attempt += 1;
		const name = spawnLabel(state.name, run.runId, state.stateId, instance.index, instance.attempt);
		let handle: FactorySpawnHandle;
		try {
			handle = await this.spawnChild(instance.prompt, {
				name,
				model: state.model ?? undefined,
				thinking: state.thinking ?? undefined,
				factory: { runId: run.runId, specId: run.specId, stateId: state.stateId },
			});
		} catch (error) {
			const lastError = error instanceof Error ? error.message : String(error);
			if (isRateLimitError(lastError)) {
				if (allowBackoff) {
					instance.rateLimitStreak += 1;
					if (instance.rateLimitStreak >= BACKOFF_MAX_ATTEMPTS) {
						await this.applyInstanceFailure(run, state, entry, instance, `spawn admission failed: ${lastError}`, false);
						return "failed";
					}
					const delay = Math.min(BACKOFF_BASE_SECONDS * 2 ** (instance.rateLimitStreak - 1), BACKOFF_CAP_SECONDS);
					const deadline = this.nowFn() + delay;
					if (run.admissionBackoffUntil === null || deadline > run.admissionBackoffUntil) {
						run.admissionBackoffUntil = deadline;
					}
					this.event(run, "spawn_backoff", {
						node: state.stateId,
						entry: entry.index,
						instance: instance.index,
						detail: `rate limited; retrying in ${delay}s`,
					});
				} else {
					this.event(run, "spawn_deferred", {
						node: state.stateId,
						entry: entry.index,
						instance: instance.index,
						detail: `rate limited at admission: ${lastError}`,
					});
				}
				return "deferred";
			}
			await this.applyInstanceFailure(run, state, entry, instance, `spawn admission failed: ${lastError}`, false);
			return "failed";
		}

		if (run.state !== "running") {
			instance.childId = handle.rlmChildId;
			await this.retractAdmission(run, state, entry, instance);
			return "stopped";
		}
		instance.childId = handle.rlmChildId;
		instance.spawnedAt = this.nowFn();
		instance.status = "running";
		instance.rateLimitStreak = 0;
		run.spawnCount += 1;
		this.event(run, "spawned", {
			node: state.stateId,
			entry: entry.index,
			instance: instance.index,
			attempt: instance.attempt,
			child: handle.rlmChildId,
			name,
		});
		return "admitted";
	}

	private jsLimitMs(run: FactoryRun, state: StateRun): number {
		return (
			(typeof state.spec.budget_ms === "number" ? state.spec.budget_ms : null) ??
			run.runBudgetMs ??
			JS_STATE_TIMEOUT_MS_DEFAULT
		);
	}

	private async startJavaScript(
		run: FactoryRun,
		state: StateRun,
		entry: StateEntry,
		instance: NodeInstance,
	): Promise<"admitted" | "failed" | "stopped"> {
		instance.attempt += 1;
		let proc: JsStateProcess;
		try {
			proc = JsStateProcess.start(
				state.spec.javascript as { import: string; callable: string },
				instance.inputs ?? {},
			);
		} catch (error) {
			await this.applyInstanceFailure(
				run,
				state,
				entry,
				instance,
				`javascript state could not start: ${error instanceof Error ? error.message : String(error)}`,
				false,
			);
			return "failed";
		}
		if (run.state !== "running") {
			await proc.stop();
			instance.status = "cancelled";
			this.event(run, "cancelled", { node: state.stateId, entry: entry.index, instance: instance.index });
			return "stopped";
		}
		instance.process = proc;
		instance.spawnedAt = this.nowFn();
		instance.deadline = instance.spawnedAt + this.jsLimitMs(run, state) / 1000;
		instance.status = "running";
		this.event(run, "started", {
			node: state.stateId,
			entry: entry.index,
			instance: instance.index,
			attempt: instance.attempt,
		});
		return "admitted";
	}

	private async waitJs(calls: NodeInstance[]): Promise<void> {
		const nearest = Math.min(...calls.map((c) => c.deadline ?? Number.POSITIVE_INFINITY));
		const timeoutSec = Math.min(Math.max(nearest - this.nowFn(), 0), POLL_TIMEOUT_MS / 1000);
		await Promise.race([
			...calls.map((c) => c.process!.exitPromise),
			this.sleepFn(timeoutSec),
		]);
	}

	private async applyJsExit(
		run: FactoryRun,
		state: StateRun,
		entry: StateEntry,
		instance: NodeInstance,
	): Promise<void> {
		const proc = instance.process;
		if (!proc) return;
		instance.process = null;
		instance.durationMs = Math.trunc((this.nowFn() - (instance.spawnedAt ?? this.nowFn())) * 1000);
		if (proc.exitCode === null) {
			await proc.stop();
			await this.applyInstanceFailure(
				run,
				state,
				entry,
				instance,
				`javascript state time limit ${this.jsLimitMs(run, state)}ms exceeded`,
				false,
			);
			return;
		}
		const { stdout, stderr } = proc.finish();
		run.settleCount += 1;
		if (proc.exitCode !== 0) {
			const detail = stderr ? `: ${stderr}` : "";
			await this.applyInstanceFailure(
				run,
				state,
				entry,
				instance,
				`javascript state exited with code ${proc.exitCode}${detail}`,
				true,
			);
			return;
		}
		const outputs = validateJsOutputs(state.spec, stdout);
		if (typeof outputs === "string") {
			await this.applyInstanceFailure(run, state, entry, instance, outputs, true);
			return;
		}
		instance.status = "done";
		instance.answer = JSON.stringify(outputs).slice(0, ANSWER_BINDING_CAP);
		this.event(run, "settled", {
			node: state.stateId,
			entry: entry.index,
			instance: instance.index,
			status: "done",
			duration_ms: instance.durationMs,
		});
		this.event(run, "answer_captured", {
			node: state.stateId,
			entry: entry.index,
			instance: instance.index,
			answer: instance.answer.slice(0, ANSWER_CAPTURE_CAP),
			stage: "arrived",
		});
		entry.answer = instance.answer;
		entry.outputs = outputs;
		entry.outputErrors = {};
		entry.status = "done";
		this.queueSettle(run, state, entry);
	}

	private async applySettlement(
		run: FactoryRun,
		state: StateRun,
		entry: StateEntry,
		instance: NodeInstance,
		result: FactoryCollectRow,
	): Promise<void> {
		if (instance.status !== "running") return;
		if (result.status === "error" && isInfraError(result.error ?? "")) {
			const fresh = await this.recheckInfraDeath(instance, result);
			if (!fresh) return;
			result = fresh;
			if (
				entry.status === "running" &&
				!instance.infraRespawned &&
				result.status === "error" &&
				isInfraError(result.error ?? "")
			) {
				await this.respawnInfraDead(run, state, entry, instance, result);
				return;
			}
		}

		instance.durationMs = result.durationMs ?? null;
		instance.toolUses = result.toolUseCount ?? 0;
		run.settleCount += 1;
		run.toolUseTotal += instance.toolUses;

		let childReason: string | null = null;
		if (result.status === "error") childReason = result.error || "child settled with status 'error'";
		else if (result.status === "cancelled") childReason = "child was cancelled";
		else if (result.status !== "done") childReason = `child settled with unexpected status ${JSON.stringify(result.status)}`;

		if (childReason !== null) {
			const exitAnswer = (result.answerText || result.answerPreview || "").slice(0, ANSWER_BINDING_CAP) || null;
			if (exitAnswer) {
				instance.answer = exitAnswer;
				instance.provisional = true;
				instance.captureFailed = false;
			}
			await this.applyInstanceFailure(run, state, entry, instance, childReason, true);
			return;
		}

		const budgetMs = typeof state.spec.budget_ms === "number" ? state.spec.budget_ms : null;
		if (budgetMs !== null && instance.spawnedAt !== null) {
			const elapsedMs = (this.nowFn() - instance.spawnedAt) * 1000;
			if (elapsedMs > budgetMs) {
				await this.applyInstanceFailure(
					run,
					state,
					entry,
					instance,
					`state budget_ms ${budgetMs} exceeded (${Math.trunc(elapsedMs)}ms from admission to settlement)`,
					false,
				);
				return;
			}
		}

		instance.status = "done";
		instance.answer = (result.answerText || result.answerPreview || "").slice(0, ANSWER_BINDING_CAP) || null;
		instance.provisional = false;
		instance.captureFailed = false;
		this.event(run, "settled", {
			node: state.stateId,
			entry: entry.index,
			instance: instance.index,
			status: "done",
			duration_ms: instance.durationMs,
		});
		if (instance.answer) {
			this.event(run, "answer_captured", {
				node: state.stateId,
				entry: entry.index,
				instance: instance.index,
				answer: instance.answer.slice(0, ANSWER_CAPTURE_CAP),
				stage: "arrived",
			});
		}

		if (entry.status === "running" && entry.instances.length > 0 && entry.instances.every((i) => i.status === "done")) {
			entry.answer = this.entryAnswer(entry);
			const captureFailure = await this.captureOutputs(run, state, entry);
			if (entry.status !== "running") return;
			if (captureFailure !== null) {
				instance.provisional = true;
				instance.captureFailed = true;
				await this.applyInstanceFailure(run, state, entry, instance, captureFailure, true);
				return;
			}
			entry.status = "done";
			this.queueSettle(run, state, entry);
		}
	}

	private async recheckInfraDeath(
		instance: NodeInstance,
		result: FactoryCollectRow,
	): Promise<FactoryCollectRow | null> {
		const childId = instance.childId;
		await this.sleepFn(INFRA_VERIFY_QUIET_SECONDS);
		if (instance.status !== "running" || instance.childId !== childId || !childId) return null;
		const rows = await this.collectChildren([childId], 0);
		if (instance.status !== "running" || instance.childId !== childId) return null;
		const row = rows.find((r) => r.rlmChildId === childId);
		if (row && !row.settled) return null;
		return row ?? result;
	}

	private async respawnInfraDead(
		run: FactoryRun,
		state: StateRun,
		entry: StateEntry,
		instance: NodeInstance,
		result: FactoryCollectRow,
	): Promise<void> {
		const oldChild = instance.childId ?? "";
		try {
			if (oldChild) await this.deleteChild(oldChild);
		} catch {
			// ignore
		}
		if (instance.status !== "running" || (run.state !== "running" && run.state !== "paused")) return;
		instance.durationMs = result.durationMs ?? null;
		instance.toolUses = result.toolUseCount ?? 0;
		run.settleCount += 1;
		run.toolUseTotal += instance.toolUses;
		instance.infraRespawned = true;
		instance.retryBase += 1;
		instance.status = "pending";
		instance.error = null;
		instance.answer = null;
		instance.provisional = false;
		instance.captureFailed = false;
		const reason = result.error || "child worker unreachable";
		this.event(run, "settled", {
			node: state.stateId,
			entry: entry.index,
			instance: instance.index,
			status: "error",
			error: reason,
			duration_ms: instance.durationMs,
		});
		this.event(run, "infra_respawn", {
			node: state.stateId,
			entry: entry.index,
			instance: instance.index,
			detail: `worker verified dead (${reason}); re-spawning the same rendered prompt once (no retry, no max_entries)`,
		});
	}

	private entryAnswer(entry: StateEntry): string | null {
		const answers = entry.instances.filter((i) => i.status === "done" && i.answer).map((i) => i.answer!);
		return answers.length > 0 ? answers.join("\n\n") : null;
	}

	private capturePorts(state: StateRun, entry: StateEntry): void {
		const outputs: Record<string, unknown> = {};
		const errors: Record<string, string> = {};
		const truncatedAt = entry.answer !== null && entry.answer.length >= ANSWER_BINDING_CAP ? entry.answer.length : null;
		const declared = Array.isArray(state.spec.outputs) ? (state.spec.outputs as Record<string, unknown>[]) : [];
		for (const out of declared) {
			const name = String(out.name);
			const portType = String(out.type);
			if (portType === "text") {
				if (entry.answer !== null) outputs[name] = entry.answer;
				continue;
			}
			if (entry.answer === null) continue;
			const [parsed, err] = parseJsonOutput(entry.answer, name, truncatedAt);
			if (err === null) outputs[name] = parsed;
			else errors[name] = err;
		}
		entry.outputs = outputs;
		entry.outputErrors = errors;
	}

	private async captureOutputs(run: FactoryRun, state: StateRun, entry: StateEntry): Promise<string | null> {
		this.capturePorts(state, entry);
		const declared = Array.isArray(state.spec.outputs) ? (state.spec.outputs as Record<string, unknown>[]) : [];
		if (declared.length === 0 || declared.every((out) => String(out.name) in (entry.outputs ?? {}))) {
			return null;
		}
		const refreshed = await this.refreshEntryAnswers(run, state, entry);
		if (refreshed) this.capturePorts(state, entry);
		const failures: string[] = [];
		for (const out of declared) {
			const name = String(out.name);
			let err = entry.outputErrors?.[name];
			if (!err && !(name in (entry.outputs ?? {}))) {
				err = `output ${JSON.stringify(name)} captured no value from the upstream answer`;
			}
			if (err) {
				this.event(run, "output_capture_failed", {
					node: state.stateId,
					entry: entry.index,
					port: name,
					error: err,
					detail: `output ${JSON.stringify(name)} did not bind after one capture retry`,
				});
				failures.push(err);
			}
		}
		return failures.join("; ") || null;
	}

	private async refreshEntryAnswers(run: FactoryRun, state: StateRun, entry: StateEntry): Promise<boolean> {
		const childIds = entry.instances
			.filter((i) => i.childId !== null && i.status === "done")
			.map((i) => i.childId!);
		if (childIds.length === 0) return false;
		const deadline = this.nowFn() + POLL_TIMEOUT_MS / 1000;
		let changed = false;
		while (entry.status === "running") {
			let rows: FactoryCollectRow[];
			try {
				rows = await this.collectChildren(childIds, 0);
			} catch (error) {
				this.event(run, "output_capture_failed", {
					node: state.stateId,
					entry: entry.index,
					error: `capture retry could not re-collect the settled children: ${error instanceof Error ? error.message : String(error)}`,
					detail: "the first capture stands",
				});
				return changed;
			}
			if (entry.status !== "running") return changed;
			const byChild = new Map(rows.map((r) => [r.rlmChildId, r]));
			for (const instance of entry.instances) {
				const row = instance.childId ? byChild.get(instance.childId) : undefined;
				if (!row) continue;
				const answer = (row.answerText || row.answerPreview || "").slice(0, ANSWER_BINDING_CAP) || null;
				if (answer && (instance.answer === null || answer.length > instance.answer.length)) {
					instance.answer = answer;
					changed = true;
				}
			}
			if (changed) entry.answer = this.entryAnswer(entry);
			const missing = entry.instances.some((i) => i.status === "done" && i.childId !== null && !i.answer);
			const remaining = deadline - this.nowFn();
			if (!missing || remaining <= 0) return changed;
			await this.sleepFn(Math.min(0.05, remaining));
		}
		return changed;
	}

	private async applyInstanceFailure(
		run: FactoryRun,
		state: StateRun,
		entry: StateEntry,
		instance: NodeInstance,
		reason: string,
		retry: boolean,
	): Promise<void> {
		instance.status = "error";
		instance.error = reason;
		this.event(run, "settled", {
			node: state.stateId,
			entry: entry.index,
			instance: instance.index,
			status: "error",
			error: reason,
			duration_ms: instance.durationMs,
		});
		const retries = Number(state.spec.retries ?? NODE_RETRIES_DEFAULT);
		if (retry && instance.attempt - instance.retryBase <= retries && entry.status === "running") {
			instance.status = "pending";
			instance.error = null;
			this.event(run, "retry", {
				node: state.stateId,
				entry: entry.index,
				instance: instance.index,
				detail: `attempt ${instance.attempt} failed; re-spawning (retries ${retries})`,
			});
			return;
		}
		await this.applyEntryFailurePolicy(run, state, entry, reason);
	}

	private async applyEntryFailurePolicy(
		run: FactoryRun,
		state: StateRun,
		entry: StateEntry,
		reason: string,
	): Promise<void> {
		if (!entry.needsVerify && entry.instances.some((i) => i.provisional && i.answer)) {
			entry.needsVerify = true;
			const respawned = entry.instances.some((i) => i.infraRespawned);
			const captureFailed = entry.instances.some((i) => i.captureFailed);
			const detail = captureFailed
				? "output capture failed; the settled answer is preserved as a provisional answer - fix the declared output or verify by hand"
				: respawned
					? "worker verified dead by the executor after its automatic respawn; last assistant text preserved as a provisional answer"
					: "child exit captured a provisional answer - verify the remote state";
			this.event(run, "needs_verify", { node: state.stateId, entry: entry.index, detail });
		}
		if (TERMINAL_ENTRY_STATUSES.has(entry.status)) return;
		const policy = String(state.spec.failure_policy ?? RUN_FAILURE_POLICY_DEFAULT);
		entry.status = "error";
		entry.error = reason;
		state.error = reason;
		run.lastError = `state ${JSON.stringify(state.stateId)} failed: ${reason}`;
		this.event(run, "node_error", {
			node: state.stateId,
			entry: entry.index,
			error: reason,
			detail: `failure_policy ${policy}`,
		});
		for (const instance of entry.instances) {
			if (instance.status === "pending") {
				instance.status = "cancelled";
				this.event(run, "cancelled", {
					node: state.stateId,
					entry: entry.index,
					instance: instance.index,
					detail: "entry failed before admission",
				});
			}
		}
		if (policy !== "escalate") {
			this.queueSettle(run, state, entry);
		}
		if (run.state !== "running") return;

		if (policy === "fail_fast") {
			await this.haltNonterminal(run, "run failed (fail_fast)");
			if (run.state !== "running") return;
			let cancelled = 0;
			for (const other of run.states.values()) {
				for (const otherEntry of other.entries) {
					for (const i of otherEntry.instances) {
						if (i.status === "cancelled") cancelled += 1;
					}
				}
			}
			run.state = "failed";
			await this.milestone(
				run,
				"failed",
				`state ${state.stateId} failed: ${reason}; cancelled ${cancelled} in-flight child(ren)`,
				state.stateId,
			);
		} else if (policy !== "continue") {
			run.state = "paused";
			run.pauseReason = reason;
			await this.milestone(
				run,
				"paused",
				`state ${state.stateId} failed: ${reason}; resume with await rlm.factory.resume('${run.runId}') to re-admit the failed entry as a fresh attempt`,
				state.stateId,
			);
		}
	}

	private async haltNonterminal(run: FactoryRun, reason: string): Promise<string[]> {
		const stopped = run.order.filter((id) => {
			const s = run.states.get(id)!;
			return (
				s.entries.some((e) => e.status === "pending" || e.status === "running") ||
				(s.entries.length === 0 && s.status === "pending")
			);
		});
		await this.cancelRunning(run);
		for (const stateId of stopped) {
			const state = run.states.get(stateId)!;
			if (state.entries.length === 0 || state.entries.some((e) => e.status === "pending" || e.status === "running")) {
				state.cancelled = true;
				for (const entry of state.entries) {
					if (entry.status === "pending" || entry.status === "running") {
						entry.status = "cancelled";
						this.event(run, "node_cancelled", { node: stateId, entry: entry.index, detail: reason });
						for (const instance of entry.instances) {
							if (instance.status === "pending") {
								instance.status = "cancelled";
								this.event(run, "cancelled", {
									node: stateId,
									entry: entry.index,
									instance: instance.index,
									detail: "cancelled before admission",
								});
							}
						}
					}
				}
			}
		}
		return stopped;
	}

	private async retractAdmission(
		run: FactoryRun,
		state: StateRun,
		entry: StateEntry,
		instance: NodeInstance,
	): Promise<void> {
		const childId = instance.childId ?? "";
		try {
			if (childId) await this.deleteChild(childId);
			this.event(run, "cancelled", { node: state.stateId, entry: entry.index, instance: instance.index, child: childId });
		} catch (error) {
			this.event(run, "cancel_failed", {
				node: state.stateId,
				entry: entry.index,
				instance: instance.index,
				child: childId,
				error: error instanceof Error ? error.message : String(error),
			});
			this.event(run, "cancelled", {
				node: state.stateId,
				entry: entry.index,
				instance: instance.index,
				child: childId,
				detail: "slot released despite the failed delete",
			});
		}
		instance.status = "cancelled";
	}

	private async cancelJs(run: FactoryRun): Promise<void> {
		for (const stateId of run.order) {
			const state = run.states.get(stateId)!;
			for (const entry of state.entries) {
				for (const instance of entry.instances) {
					if (instance.status === "running" && instance.process !== null) {
						const proc = instance.process;
						instance.process = null;
						instance.status = "cancelled";
						if (entry.status === "running") entry.status = "cancelled";
						await proc.stop();
						this.event(run, "cancelled", { node: stateId, entry: entry.index, instance: instance.index });
					}
				}
			}
		}
	}

	private async cancelRunning(run: FactoryRun): Promise<void> {
		await this.cancelJs(run);
		for (const stateId of run.order) {
			const state = run.states.get(stateId)!;
			for (const entry of state.entries) {
				for (const instance of entry.instances) {
					if (instance.status !== "running" || !instance.childId) continue;
					const childId = instance.childId;
					instance.status = "cancelled";
					try {
						await this.deleteChild(childId);
						this.event(run, "cancelled", { node: stateId, entry: entry.index, instance: instance.index, child: childId });
					} catch (error) {
						this.event(run, "cancel_failed", {
							node: stateId,
							entry: entry.index,
							instance: instance.index,
							child: childId,
							error: error instanceof Error ? error.message : String(error),
						});
						this.event(run, "cancelled", {
							node: stateId,
							entry: entry.index,
							instance: instance.index,
							child: childId,
							detail: "slot released despite the failed delete",
						});
					}
				}
			}
		}
	}

	private runComplete(run: FactoryRun): boolean {
		if (run.pendingEvaluations.length > 0) return false;
		for (const state of run.states.values()) {
			const resident = state.lifecycle === "resident";
			for (const entry of state.entries) {
				if (entry.status === "pending" || entry.status === "running") {
					if (!(resident && entry.status === "running")) return false;
				}
				for (const instance of entry.instances) {
					if (instance.status === "pending") return false;
					if (instance.status === "running" && !(resident && entry.status === "running")) return false;
				}
			}
		}
		return true;
	}

	private async finalize(run: FactoryRun): Promise<void> {
		if (run.state !== "running") return;
		const errored = [...run.states.values()].filter((s) => s.entries.some((e) => e.status === "error"));
		if (errored.length > 0) {
			run.state = "failed";
			await this.milestone(run, "failed", `completed with state error(s): ${errored.map((s) => s.stateId).join(", ")}`);
			return;
		}
		run.state = "done";
		const residents = [...run.states.values()].filter(
			(s) => s.lifecycle === "resident" && s.entries.some((e) => e.status === "running"),
		);
		let detail = `run complete: ${run.states.size} state(s), ${run.transitionsFired} transition(s) fired`;
		if (residents.length > 0) {
			detail += `; ${residents.length} resident state(s) still running (stop with await rlm.factory.stop('${run.runId}'))`;
		}
		await this.milestone(run, "finished", detail);
	}

	private startLoop(run: FactoryRun): void {
		const gen = run.loopGeneration;
		run.task = this.controlLoop(run, gen);
	}

	private async controlLoop(run: FactoryRun, generation: number): Promise<void> {
		try {
			await this.loopBody(run, generation);
		} catch (error) {
			const name = error instanceof Error ? error.name : "Error";
			const msg = error instanceof Error ? error.message : String(error);
			this.event(run, "executor_error", { error: `${name}: ${msg}` });
			if (run.state === "running") {
				run.state = "failed";
				await this.cancelJs(run);
				await this.milestone(run, "failed", `executor error: ${msg}`).catch(() => undefined);
			}
		}
	}

	private async loopBody(run: FactoryRun, generation: number): Promise<void> {
		while (this.loopAlive(run, generation)) {
			const inFlight: Array<[StateRun, StateEntry, NodeInstance]> = [];
			for (const stateId of run.order) {
				const state = run.states.get(stateId)!;
				for (const entry of state.entries) {
					for (const instance of entry.instances) {
						if (instance.status === "running") inFlight.push([state, entry, instance]);
					}
				}
			}
			const children = inFlight.filter(([, , i]) => i.childId !== null);
			const jsCalls = inFlight.filter(([, , i]) => i.process !== null);

			if (children.length > 0) {
				let timeoutMs = POLL_TIMEOUT_MS;
				if (jsCalls.length > 0) {
					const nearest = Math.min(...jsCalls.map(([, , i]) => i.deadline ?? Number.POSITIVE_INFINITY));
					timeoutMs = Math.min(timeoutMs, Math.max(0, Math.ceil((nearest - this.nowFn()) * 1000)));
				}
				const results = await this.collectChildren(
					children.map(([, , i]) => i.childId!),
					timeoutMs,
				);
				const settled = new Map(results.filter((r) => r.settled).map((r) => [r.rlmChildId, r]));
				for (const [state, entry, instance] of children) {
					if (run.loopGeneration !== generation) return;
					const row = instance.childId ? settled.get(instance.childId) : undefined;
					if (row) await this.applySettlement(run, state, entry, instance, row);
				}
			} else if (jsCalls.length > 0) {
				await this.waitJs(jsCalls.map(([, , i]) => i));
			}

			for (const [state, entry, instance] of jsCalls) {
				if (run.loopGeneration !== generation) return;
				const proc = instance.process;
				if (instance.status !== "running" || !proc) continue;
				if (proc.exitCode !== null || (instance.deadline !== null && this.nowFn() >= instance.deadline)) {
					await this.applyJsExit(run, state, entry, instance);
				}
			}

			if (!this.loopAlive(run, generation)) return;
			await this.evaluateSettles(run);
			if (!this.loopAlive(run, generation)) return;
			if (this.runComplete(run)) {
				await this.finalize(run);
				return;
			}
			if (this.runBudgetExceeded(run)) {
				await this.pauseForBudget(run);
				return;
			}
			const started = await this.spawnReady(run, generation, true);
			if (!this.loopAlive(run, generation)) return;
			if (run.admissionBackoffUntil !== null && this.nowFn() < run.admissionBackoffUntil) {
				await this.sleepFn(Math.min(run.admissionBackoffUntil - this.nowFn(), POLL_TIMEOUT_MS / 1000));
				continue;
			}
			if (run.pendingEvaluations.length === 0 && this.residentCapStarved(run)) {
				const reason = `control loop stalled: resident instances hold every max_parallel ${run.maxParallel} slot; queued instances can never be admitted`;
				this.event(run, "executor_error", { error: reason });
				run.state = "failed";
				await this.milestone(run, "failed", reason).catch(() => undefined);
				return;
			}
			const residentOnly = inFlight.every(([state]) => state.lifecycle === "resident");
			if (
				(inFlight.length === 0 || residentOnly) &&
				started.length === 0 &&
				!this.hasPendingInstance(run) &&
				run.pendingEvaluations.length === 0
			) {
				const stuck = run.order.filter((id) =>
					run.states.get(id)!.entries.some((e) => e.status === "pending" && e.instances.length === 0),
				);
				const reason =
					stuck.length > 0
						? `control loop stalled: pending entry of state ${stuck.map((s) => JSON.stringify(s)).join(", ")} is waiting for an input source that never settled`
						: "control loop stalled: no in-flight or pending work";
				this.event(run, "executor_error", { error: reason });
				run.state = "failed";
				await this.milestone(run, "failed", reason).catch(() => undefined);
				return;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	}

	private stateReport(state: StateRun, includeAnswer: boolean): Record<string, unknown> {
		let attempts = 0;
		let running = 0;
		let queued = 0;
		const instances: Record<string, unknown>[] = [];
		for (const entry of state.entries) {
			for (const instance of entry.instances) {
				attempts += instance.attempt;
				if (instance.status === "running") running += 1;
				if (instance.status === "pending") queued += 1;
				instances.push({
					index: instance.index,
					entry: entry.index,
					status: instance.status,
					attempt: instance.attempt,
					child: instance.childId,
					duration_ms: instance.durationMs,
					error: instance.error,
				});
			}
		}
		const report: Record<string, unknown> = {
			id: state.stateId,
			status: state.status,
			lifecycle: state.lifecycle,
			attempts,
			entries_used: state.entriesUsed,
			max_entries: state.maxEntries,
			entries: state.entries.map((e) => this.entryReport(e)),
			instances,
			running,
			queued,
		};
		if (includeAnswer) {
			const latest = state.latestSettle();
			if (latest?.answer) report.answer_preview = latest.answer.slice(0, ANSWER_CAPTURE_CAP);
		}
		if (state.error !== null) report.error = state.error;
		if (state.entries.some((e) => e.needsVerify)) report.needs_verify = true;
		return report;
	}

	private entryReport(entry: StateEntry): Record<string, unknown> {
		const row: Record<string, unknown> = { index: entry.index, status: entry.status, error: entry.error };
		if (entry.needsVerify) {
			row.needs_verify = true;
			const prov = [...entry.instances].reverse().find((i) => i.provisional && i.answer)?.answer;
			if (prov) row.provisional_answer = prov.slice(0, ANSWER_CAPTURE_CAP);
		}
		return row;
	}

	private usageReport(run: FactoryRun): Record<string, unknown> {
		return {
			spawns: run.spawnCount,
			settled: run.settleCount,
			tool_uses: run.toolUseTotal,
			max_parallel: run.maxParallel,
			max_children: run.maxChildren,
			running: this.runningInstanceCount(run),
			transitions_fired: run.transitionsFired,
		};
	}

	private lastFired(run: FactoryRun): Record<string, unknown>[] {
		const latest = new Map<string, Record<string, unknown>>();
		for (const evt of run.events) {
			if (evt.kind !== "transition_fired") continue;
			const edge = { from: evt.from, to: evt.to, seq: evt.seq, when: evt.when ?? null };
			const key = `${JSON.stringify(evt.from)}->${evt.to}@${JSON.stringify(evt.when ?? null)}`;
			latest.set(key, edge);
		}
		return [...latest.values()]
			.sort((a, b) => Number(b.seq) - Number(a.seq))
			.slice(0, LAST_FIRED_WINDOW);
	}

	private graphSnapshot(run: FactoryRun, compact: boolean): Record<string, unknown> {
		const elapsedMs = Math.trunc((this.nowFn() - run.startedAt) * 1000);
		const resolved = new Map<string, [string | null, string | null]>();
		for (const id of run.order) {
			const s = run.states.get(id)!;
			resolved.set(id, [s.model, s.thinking]);
		}
		const windowEvents = run.events.slice(-(compact ? GRAPH_EVENTS_TAIL : EVENT_WINDOW)).map((e) => ({ ...e }));
		const events = compact ? windowEvents.filter((e) => e.kind !== "answer_captured") : windowEvents;
		return {
			run_id: run.runId,
			spec_id: run.specId,
			name: run.name,
			state: run.state,
			pause_reason: run.pauseReason,
			elapsed_ms: elapsedMs,
			machine: machineStructure(run.machine, resolved),
			nodes: run.order.map((id) => this.stateReport(run.states.get(id)!, !compact)),
			active_nodes: run.order.filter((id) =>
				run.states
					.get(id)!
					.entries.some(
						(e) =>
							e.status === "pending" ||
							e.status === "running" ||
							e.instances.some((i) => i.status === "pending" || i.status === "running"),
					),
			),
			last_fired: this.lastFired(run),
			events,
			usage: this.usageReport(run),
			budget: { limit_ms: run.runBudgetMs, consumed_ms: elapsedMs },
		};
	}

	private specSnapshot(specId: string, canonical: Record<string, unknown>): Record<string, unknown> {
		const runBlock = canonical.run as Record<string, unknown>;
		return {
			run_id: null,
			spec_id: specId,
			name: null,
			state: null,
			pause_reason: null,
			elapsed_ms: 0,
			machine: machineStructure(canonical),
			nodes: [],
			active_nodes: [],
			last_fired: [],
			events: [],
			usage: null,
			budget: { limit_ms: runBlock.budget_ms ?? null, consumed_ms: 0 },
		};
	}

	private signature(run: FactoryRun): string {
		const parts = run.order.map((id) => {
			const s = run.states.get(id)!;
			return `${id}:${s.status}:${s.entriesUsed}:${s.entries
				.map((e) => `${e.index}=${e.status}[${e.instances.map((i) => i.status).join(",")}]`)
				.join(";")}`;
		});
		return `${run.state}|${run.pauseReason ?? ""}|${run.transitionsFired}|${parts.join("/")}`;
	}

	private runningInstanceCount(run: FactoryRun): number {
		let count = 0;
		for (const s of run.states.values()) {
			for (const e of s.entries) {
				for (const i of e.instances) {
					if (i.status === "running") count += 1;
				}
			}
		}
		return count;
	}

	private residentCapStarved(run: FactoryRun): boolean {
		const runningFlags: boolean[] = [];
		for (const s of run.states.values()) {
			for (const e of s.entries) {
				for (const i of e.instances) {
					if (i.status === "running") runningFlags.push(s.lifecycle === "resident");
				}
			}
		}
		return runningFlags.length >= run.maxParallel && this.hasPendingInstance(run) && runningFlags.every(Boolean);
	}

	private hasPendingInstance(run: FactoryRun): boolean {
		for (const s of run.states.values()) {
			for (const e of s.entries) {
				for (const i of e.instances) {
					if (i.status === "pending") return true;
				}
			}
		}
		return false;
	}

	private pendingStateIds(run: FactoryRun): string[] {
		return run.order.filter((id) => run.states.get(id)!.status === "pending");
	}
}

let defaultExecutor: FactoryExecutor | null = null;

export function defaultFactoryExecutor(): FactoryExecutor {
	if (!defaultExecutor) defaultExecutor = new FactoryExecutor();
	return defaultExecutor;
}

export function setDefaultFactoryExecutorForTest(executor: FactoryExecutor | null): void {
	defaultExecutor = executor;
}

export async function runFactory(specId: string, opts?: { name?: string }): Promise<Record<string, unknown>> {
	requireFactoryEnabled();
	const executor = defaultFactoryExecutor();
	const { harnessProxy } = await import("./harness.ts");
	if (harnessProxy.get("factory", specId) === null) {
		let machine: MachineFile;
		let filePath: string;
		try {
			[machine, filePath] = resolveMachine(specId);
		} catch (error) {
			if (error instanceof MachineResolutionError) {
				if (error.broken) {
					throw new Error(`the library machine ${JSON.stringify(specId)} exists but is broken (${error.message})`);
				}
				throw new Error(
					`unknown factory spec ${JSON.stringify(specId)}: no stored factory entry and no library machine with that name (${error.message})`,
				);
			}
			throw new Error(
				`unknown factory spec ${JSON.stringify(specId)}: no stored factory entry, and the id is not a valid machine name either (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		return executor.runMachine(machine, { machinePath: filePath, name: opts?.name });
	}
	return executor.run(specId, opts);
}

export async function statusFactory(runId: string): Promise<Record<string, unknown>> {
	requireFactoryEnabled();
	return defaultFactoryExecutor().status(runId);
}

export async function stopFactory(runId: string): Promise<Record<string, unknown>> {
	requireFactoryEnabled();
	return defaultFactoryExecutor().stop(runId);
}

export async function resumeFactory(runId: string): Promise<Record<string, unknown>> {
	requireFactoryEnabled();
	return defaultFactoryExecutor().resume(runId);
}

export async function graphFactory(ref?: string, opts?: { compact?: boolean }): Promise<Record<string, unknown>> {
	requireFactoryEnabled();
	return defaultFactoryExecutor().graph(ref, opts);
}

export async function watchFactory(
	runId: string,
	timeout = 0,
	opts?: { compact?: boolean },
): Promise<Record<string, unknown>> {
	requireFactoryEnabled();
	return defaultFactoryExecutor().watch(runId, timeout, opts);
}

export async function exportMachine(
	target: string,
	outPath: string,
	opts?: { repoDir?: string; userDir?: string; overwrite?: boolean },
): Promise<{ name: string; path: string; source: string }> {
	const executor = defaultFactoryExecutor();
	const { harnessProxy } = await import("./harness.ts");
	const entry = harnessProxy.get("factory", target);
	if (entry) {
		const args = isRecord(entry.arguments) ? entry.arguments : {};
		const spec = args.machine !== undefined && args.machine !== null ? args.machine : args.dag;
		if (!spec) throw new Error(`factory entry ${JSON.stringify(target)} carries no machine or dag spec`);
		const errs = machineNameErrors(target);
		if (errs.length > 0) {
			throw new Error([...errs, `the stored entry id ${JSON.stringify(target)} cannot become a machine name`].join("; "));
		}
		const description = entry.content.replace(/\s+/g, " ").trim() || entry.title.replace(/\s+/g, " ").trim();
		return exportFactorySpec(spec, outPath, { name: target, description, overwrite: opts?.overwrite });
	}
	const run = executor.runs.get(target);
	if (run && Object.keys(run.machine).length > 0) {
		const errs = machineNameErrors(run.specId);
		if (errs.length > 0) {
			throw new Error([...errs, `the run's spec id ${JSON.stringify(run.specId)} cannot become a machine name`].join("; "));
		}
		const description = (run.name ?? "").replace(/\s+/g, " ").trim() || `factory run ${run.runId}`;
		return exportFactorySpec(run.machine, outPath, { name: run.specId, description, overwrite: opts?.overwrite });
	}
	return exportLibraryMachine(target, outPath, opts);
}

function wireRunRowIsLive(row: unknown): boolean {
	if (!isRecord(row)) return false;
	if (typeof row.state === "string" && WIRE_LIVE_RUN_STATES.has(row.state)) return true;
	const usage = row.usage;
	return isRecord(usage) && typeof usage.running === "number" && usage.running > 0;
}

function shedRunsFrame(runs: unknown[]): boolean {
	for (const row of runs) {
		if (!isRecord(row)) continue;
		const tail = row.events;
		if (Array.isArray(tail) && tail.length > 1) {
			tail.shift();
			return true;
		}
	}
	if (runs.length > 1) {
		const idx = runs.findIndex((row) => !wireRunRowIsLive(row));
		if (idx >= 0) {
			runs.splice(idx, 1);
			return true;
		}
	}
	return false;
}

export function capFactoryFrame(frame: Record<string, unknown>): void {
	while (JSON.stringify(frame).length > FACTORY_FRAME_CAP) {
		const result = frame.result;
		if (isRecord(result) && Array.isArray(result.events) && result.events.length > 1) {
			result.events.shift();
			continue;
		}
		if (isRecord(result) && Array.isArray(result.runs) && shedRunsFrame(result.runs)) {
			continue;
		}
		delete frame.result;
		frame.status = "error";
		frame.reason = "factory activity reply exceeds the wire cap";
		return;
	}
}

export function scheduleFactoryActivity(request: Record<string, unknown>): void {
	void (async () => {
		const rid = String(request.id);
		try {
			const result = await defaultFactoryExecutor().activity(request);
			const frame: Record<string, unknown> = { event: "done", id: rid, status: "ok", result };
			capFactoryFrame(frame);
			sendProtocolEvent(frame);
		} catch (error) {
			const frame: Record<string, unknown> = {
				event: "done",
				id: rid,
				status: "error",
				reason: error instanceof Error ? error.message : String(error),
			};
			capFactoryFrame(frame);
			sendProtocolEvent(frame);
		}
	})();
}
