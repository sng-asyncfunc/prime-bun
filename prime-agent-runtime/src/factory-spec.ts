import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export const FAILURE_POLICIES = ["fail_fast", "continue", "escalate"] as const;
export const PORT_TYPES = ["text", "json"] as const;
export const LIFECYCLES = ["task", "resident"] as const;
export const TRANSITION_ON_KINDS = ["settled"] as const;
export const GUARD_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "exists", "contains"] as const;
export const MAX_NODES = 1024;
export const MAX_STATES = MAX_NODES;
export const MAX_RETRIES = 10;
export const MAX_PARALLEL_MIN = 1;
export const MAX_PARALLEL_MAX = 64;
export const FOREACH_MAX_MIN = 1;
export const FOREACH_MAX_MAX = 256;
export const MAX_TRANSITIONS_CAP = 10_000;
export const MAX_CHILDREN_CAP = 1_000_000;
export const TRANSITIONS_PER_STATE_DEFAULT = 10;
export const RUN_FAILURE_POLICY_DEFAULT = "escalate";
export const RUN_MAX_PARALLEL_DEFAULT = 8;
export const RUN_MAX_CHILDREN_DEFAULT = 10_000;
export const NODE_LIFECYCLE_DEFAULT = "task";
export const NODE_RETRIES_DEFAULT = 0;
export const STATE_ENTRY_DEFAULT = false;
export const STATE_MAX_ENTRIES_DEFAULT = 1;
export const SUBAGENT_NAME_MAX_LENGTH = 64;
export const MAX_GUARD_VALUE_DEPTH = 256;

export const FACTORY_DISABLED_MESSAGE = "the factory is disabled; run /factory on to enable it";
export const MACHINE_FILE_NAME = "MACHINE.md";
export const MACHINE_SPEC_FENCE = "machine-spec";
export const MACHINES_DIR_NAME = "machines";
export const MACHINE_NAME_MAX_LENGTH = 64;
export const MACHINE_DESCRIPTION_MAX_LENGTH = 1024;
export const MACHINE_FRONTMATTER_FIELDS = ["name", "description", "version", "author"] as const;

const NODE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MACHINE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const PLAIN_FRONTMATTER_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/@+~-]*$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

export function isNumber(value: unknown): value is number {
	return typeof value === "number" && !Number.isNaN(value);
}

export function isPositiveInt(value: unknown): value is number {
	return isInt(value) && value > 0;
}

export function isNonEmptyStr(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isScalar(value: unknown): boolean {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function validNodeId(value: unknown): value is string {
	return isNonEmptyStr(value) && NODE_ID_RE.test(value);
}

function valueIsFinite(value: unknown, seen: Set<object> = new Set(), depth = 0): boolean {
	if (depth > MAX_GUARD_VALUE_DEPTH) return false;
	if (typeof value === "number") return Number.isFinite(value);
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (Array.isArray(value)) {
		if (seen.has(value)) return false;
		seen.add(value);
		const ok = value.every((item) => valueIsFinite(item, seen, depth + 1));
		seen.delete(value);
		return ok;
	}
	if (isRecord(value)) {
		if (seen.has(value)) return false;
		seen.add(value);
		const ok = Object.entries(value).every(([, item]) => valueIsFinite(item, seen, depth + 1));
		seen.delete(value);
		return ok;
	}
	return false;
}

function portList(node: Record<string, unknown>, key: string): unknown[] {
	const raw = node[key];
	return Array.isArray(raw) ? raw : [];
}

export function declaredPortTypes(node: Record<string, unknown>, key: string): Record<string, string> {
	const ports: Record<string, string> = {};
	for (const entry of portList(node, key)) {
		if (!isRecord(entry)) continue;
		const name = entry.name;
		const portType = entry.type;
		if (isNonEmptyStr(name) && (portType === "text" || portType === "json")) {
			ports[name] = portType;
		}
	}
	return ports;
}

function inputSources(node: Record<string, unknown>): string[] {
	const sources: string[] = [];
	for (const inp of portList(node, "inputs")) {
		if (!isRecord(inp)) continue;
		const source = inp.from;
		if (typeof source === "string" && source.includes(".")) {
			sources.push(source.slice(0, source.indexOf(".")));
		}
	}
	return sources;
}

function isMachineForm(spec: unknown): spec is Record<string, unknown> {
	return isRecord(spec) && ("states" in spec || "transitions" in spec);
}

export function suffixedSpawnForm(base: string, candidate: string): boolean {
	if (!candidate.startsWith(`${base}-`)) return false;
	const remainder = candidate.slice(base.length + 1);
	for (const part of remainder.split("-")) {
		if (part.length < 2 || (part[0] !== "i" && part[0] !== "a") || !/^\d+$/.test(part.slice(1))) {
			return false;
		}
		const n = Number.parseInt(part.slice(1), 10);
		if (part[0] === "i" && n < 1) return false;
		if (part[0] === "a" && n < 2) return false;
	}
	return true;
}

function validateRunFields(run: unknown, errors: string[]): number | null {
	if (!isRecord(run)) return null;
	if ("budget_ms" in run && !isPositiveInt(run.budget_ms)) {
		errors.push("run budget_ms must be a positive integer");
	}
	const runBudget = isPositiveInt(run.budget_ms) ? run.budget_ms : null;
	if ("failure_policy" in run && !FAILURE_POLICIES.includes(run.failure_policy as (typeof FAILURE_POLICIES)[number])) {
		errors.push(`run failure_policy must be one of ${JSON.stringify(FAILURE_POLICIES)}, got ${JSON.stringify(run.failure_policy)}`);
	}
	if (
		"max_parallel" in run &&
		!(isInt(run.max_parallel) && run.max_parallel >= MAX_PARALLEL_MIN && run.max_parallel <= MAX_PARALLEL_MAX)
	) {
		errors.push(`run max_parallel must be an integer between ${MAX_PARALLEL_MIN} and ${MAX_PARALLEL_MAX}`);
	}
	if ("max_transitions" in run && !(isPositiveInt(run.max_transitions) && run.max_transitions <= MAX_TRANSITIONS_CAP)) {
		errors.push(`run max_transitions must be a positive integer no greater than ${MAX_TRANSITIONS_CAP}`);
	}
	if ("max_children" in run && !(isPositiveInt(run.max_children) && run.max_children <= MAX_CHILDREN_CAP)) {
		errors.push(`run max_children must be a positive integer no greater than ${MAX_CHILDREN_CAP}`);
	}
	return runBudget;
}

function validateStateFields(
	state: Record<string, unknown>,
	runBudget: number | null,
	statesById: Map<string, Record<string, unknown>>,
	noun: "node" | "state",
	errors: string[],
): void {
	const ref = String(state.id);
	const lifecycle = "lifecycle" in state ? state.lifecycle : NODE_LIFECYCLE_DEFAULT;
	if ("lifecycle" in state && !LIFECYCLES.includes(lifecycle as (typeof LIFECYCLES)[number])) {
		errors.push(`${noun} ${ref} lifecycle must be 'task' or 'resident', got ${JSON.stringify(lifecycle)}`);
	}
	const isResident = lifecycle === "resident";

	if (state.wait !== undefined && state.wait !== null) {
		errors.push(
			`${noun} ${ref}: wait states require the watch host handlers (rlm.watch.*); ` +
				"they arrive with the communication series - remove the wait block until then",
		);
	}

	const hasJs = "javascript" in state;
	const hasSubagent = "subagent" in state;
	if (hasJs) {
		const jsSpec = state.javascript;
		if (hasSubagent) {
			errors.push(`${noun} ${ref} declares both subagent and javascript; use exactly one`);
		}
		if (!isRecord(jsSpec) || !isNonEmptyStr(jsSpec.import) || !isNonEmptyStr(jsSpec.callable)) {
			errors.push(`${noun} ${ref} javascript requires non-empty 'import' and 'callable' strings`);
		}
		if (isResident) errors.push(`javascript ${noun} ${ref} cannot be resident`);
		if ("foreach" in state) errors.push(`javascript ${noun} ${ref} cannot use foreach`);
	} else if (isNonEmptyStr(state.subagent)) {
		// harness subagent entry id/title
	} else if (isRecord(state.subagent)) {
		const sub = state.subagent;
		if (typeof sub.prompt !== "string" || !sub.prompt.trim()) {
			errors.push(`${noun} ${ref} inline subagent requires a non-empty prompt`);
		}
		for (const key of ["name", "model", "thinking"] as const) {
			const val = sub[key];
			if (val !== undefined && val !== null && (typeof val !== "string" || !val.trim())) {
				errors.push(`${noun} ${ref} inline subagent ${key} must be a non-empty string when provided`);
			}
		}
		if (typeof sub.name === "string" && sub.name.trim().length > SUBAGENT_NAME_MAX_LENGTH) {
			errors.push(
				`${noun} ${ref} inline subagent name must be at most ${SUBAGENT_NAME_MAX_LENGTH} characters, got ${sub.name.trim().length}`,
			);
		}
	} else {
		errors.push(
			`${noun} ${ref} requires a subagent: a harness subagent id/title string or an inline object with a prompt ` +
				'(or a javascript state: {"javascript": {"import": "<module>", "callable": "<function>"}})',
		);
	}

	if ("budget_ms" in state) {
		if (!isPositiveInt(state.budget_ms)) {
			errors.push(`${noun} ${ref} budget_ms must be a positive integer`);
		} else if (runBudget !== null && state.budget_ms > runBudget) {
			errors.push(`${noun} ${ref} budget_ms ${state.budget_ms} exceeds the run budget_ms ${runBudget}`);
		}
	}

	if ("retries" in state && !(isInt(state.retries) && state.retries >= 0 && state.retries <= MAX_RETRIES)) {
		errors.push(`${noun} ${ref} retries must be an integer between 0 and ${MAX_RETRIES}`);
	} else if (isResident && typeof state.retries === "number" && state.retries > 0) {
		errors.push(`resident ${noun} ${ref} cannot declare retries`);
	}

	if ("failure_policy" in state && !FAILURE_POLICIES.includes(state.failure_policy as (typeof FAILURE_POLICIES)[number])) {
		errors.push(
			`${noun} ${ref} failure_policy must be one of ${JSON.stringify(FAILURE_POLICIES)}, got ${JSON.stringify(state.failure_policy)}`,
		);
	}

	const outputs = state.outputs;
	if (outputs !== undefined && outputs !== null && !Array.isArray(outputs)) {
		errors.push(`${noun} ${ref} outputs must be a list`);
	} else if (isResident && Array.isArray(outputs) && outputs.length > 0) {
		errors.push(`resident ${noun} ${ref} cannot declare outputs`);
	}
	const seenOut = new Set<string>();
	const dupOut = new Set<string>();
	for (const [index, out] of portList(state, "outputs").entries()) {
		if (!isRecord(out)) {
			errors.push(`${noun} ${ref} outputs[${index}] must be an object`);
			continue;
		}
		const name = out.name;
		const portType = out.type;
		if (!isNonEmptyStr(name)) {
			errors.push(`${noun} ${ref} outputs[${index}] requires a non-empty name`);
		} else if (seenOut.has(name)) {
			if (!dupOut.has(name)) {
				dupOut.add(name);
				errors.push(`${noun} ${ref} declares duplicate output name ${JSON.stringify(name)}`);
			}
		} else {
			seenOut.add(name);
		}
		if (portType !== "text" && portType !== "json") {
			errors.push(`${noun} ${ref} output ${JSON.stringify(name)} type must be 'text' or 'json'`);
		}
	}

	const inputs = state.inputs;
	if (inputs !== undefined && inputs !== null && !Array.isArray(inputs)) {
		errors.push(`${noun} ${ref} inputs must be a list`);
	}
	const seenIn = new Set<string>();
	const dupIn = new Set<string>();
	const outputCache = new Map<string, Record<string, string>>();
	for (const [index, inp] of portList(state, "inputs").entries()) {
		if (!isRecord(inp)) {
			errors.push(`${noun} ${ref} inputs[${index}] must be an object`);
			continue;
		}
		const name = inp.name;
		const portType = inp.type;
		const source = inp.from;
		if (inp.optional !== undefined && inp.optional !== null && typeof inp.optional !== "boolean") {
			errors.push(`${noun} ${ref} input ${JSON.stringify(name)} optional must be a boolean when provided`);
		}
		if (!isNonEmptyStr(name)) {
			errors.push(`${noun} ${ref} inputs[${index}] requires a non-empty name`);
		} else if (seenIn.has(name)) {
			if (!dupIn.has(name)) {
				dupIn.add(name);
				errors.push(`${noun} ${ref} declares duplicate input name ${JSON.stringify(name)}`);
			}
		} else {
			seenIn.add(name);
		}
		if (portType !== "text" && portType !== "json") {
			errors.push(`${noun} ${ref} input ${JSON.stringify(name)} type must be 'text' or 'json'`);
		}
		if (typeof source !== "string" || !source.includes(".")) {
			errors.push(
				`${noun} ${ref} input ${JSON.stringify(name)} requires a 'from' reference of the form '<node_id>.<output_name>'`,
			);
			continue;
		}
		const dot = source.indexOf(".");
		const srcId = source.slice(0, dot);
		const srcOutput = source.slice(dot + 1);
		const src = statesById.get(srcId);
		if (!src) {
			errors.push(`${noun} ${ref} input ${JSON.stringify(name)} references unknown ${noun} ${JSON.stringify(srcId)}`);
			continue;
		}
		if ((src.lifecycle ?? NODE_LIFECYCLE_DEFAULT) === "resident") {
			errors.push(`${noun} ${ref} input ${JSON.stringify(name)} cannot read from resident ${noun} ${JSON.stringify(srcId)}`);
			continue;
		}
		let srcOutTypes = outputCache.get(srcId);
		if (!srcOutTypes) {
			srcOutTypes = declaredPortTypes(src, "outputs");
			outputCache.set(srcId, srcOutTypes);
		}
		if (!(srcOutput in srcOutTypes)) {
			errors.push(
				`${noun} ${ref} input ${JSON.stringify(name)} references output ${JSON.stringify(srcOutput)} ` +
					`that ${noun} ${JSON.stringify(srcId)} does not declare`,
			);
		} else if ((portType === "text" || portType === "json") && srcOutTypes[srcOutput] !== portType) {
			errors.push(
				`${noun} ${ref} input ${JSON.stringify(name)} of type ${JSON.stringify(portType)} cannot read from ` +
					`output ${JSON.stringify(srcOutput)} of type ${JSON.stringify(srcOutTypes[srcOutput])}`,
			);
		}
	}

	const foreach = state.foreach;
	if (foreach !== undefined && foreach !== null) {
		if (isResident) errors.push(`resident ${noun} ${ref} cannot use foreach`);
		if (!isRecord(foreach)) {
			errors.push(`${noun} ${ref} foreach must be an object`);
		} else {
			const over = foreach.over;
			if (!isNonEmptyStr(over)) {
				errors.push(`${noun} ${ref} foreach.over must be a non-empty input name`);
			} else {
				const declaredInputs = declaredPortTypes(state, "inputs");
				if (!(over in declaredInputs)) {
					errors.push(`${noun} ${ref} foreach.over must name one of this ${noun}'s inputs, got ${JSON.stringify(over)}`);
				} else if (declaredInputs[over] !== "json") {
					errors.push(`${noun} ${ref} foreach.over input ${JSON.stringify(over)} must have type 'json'`);
				}
			}
			const fmax = foreach.max;
			if (!(isInt(fmax) && fmax >= FOREACH_MAX_MIN && fmax <= FOREACH_MAX_MAX)) {
				errors.push(`${noun} ${ref} foreach.max must be an integer between ${FOREACH_MAX_MIN} and ${FOREACH_MAX_MAX}`);
			}
		}
	}
}

function validateGuard(
	when: unknown,
	index: number,
	srcState: Record<string, unknown>,
	errors: string[],
): void {
	if (!isRecord(when)) {
		errors.push(`transitions[${index}] when must be an object`);
		return;
	}
	const output = when.output;
	const srcTypes = declaredPortTypes(srcState, "outputs");
	if (!isNonEmptyStr(output)) {
		errors.push(`transitions[${index}] when requires a non-empty output`);
	} else if (!(output in srcTypes)) {
		errors.push(
			`transitions[${index}] when.output ${JSON.stringify(output)} is not a declared output of state ${JSON.stringify(srcState.id)}`,
		);
	} else if (when.path !== undefined && when.path !== null) {
		if (!isNonEmptyStr(when.path)) {
			errors.push(`transitions[${index}] when.path must be a non-empty dotted path`);
		} else if (srcTypes[output] !== "json") {
			errors.push(`transitions[${index}] when.path requires a json output, got text output ${JSON.stringify(output)}`);
		}
	}
	const op = when.op;
	if (!GUARD_OPS.includes(op as (typeof GUARD_OPS)[number])) {
		errors.push(`transitions[${index}] when.op must be one of ${JSON.stringify(GUARD_OPS)}, got ${JSON.stringify(op)}`);
		return;
	}
	if (op === "exists") return;
	const value = when.value;
	if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
		if (typeof value !== "number") {
			errors.push(`transitions[${index}] when.op ${JSON.stringify(op)} requires a numeric value`);
		}
	} else if (op === "contains") {
		if (!Array.isArray(value) || value.length === 0) {
			errors.push(`transitions[${index}] when.op 'contains' requires a non-empty list value`);
		}
	} else if ((op === "eq" || op === "ne") && !isScalar(value)) {
		errors.push(`transitions[${index}] when.op ${JSON.stringify(op)} requires a scalar value`);
	}
	if (!valueIsFinite(value)) {
		errors.push(
			`transitions[${index}] when.value must be finite JSON data ` +
				"(JSON carries no NaN or Infinity, and only JSON shapes serialize: lists, objects, strings, numbers, booleans, null, " +
				`and no container nests deeper than ${MAX_GUARD_VALUE_DEPTH} levels)`,
		);
	}
}

export function validateFactoryMachine(machine: unknown): string[] {
	if (!isRecord(machine)) return ["factory machine must be a JSON object"];
	const errors: string[] = [];
	let run: unknown = machine.run;
	if (run !== undefined && run !== null && !isRecord(run)) {
		errors.push("run must be an object");
		run = null;
	}
	const runBudget = validateRunFields(run, errors);

	const states = machine.states;
	if (!Array.isArray(states)) {
		errors.push("factory machine requires a states list");
		return errors;
	}
	if (states.length < 1 || states.length > MAX_STATES) {
		errors.push(`factory machine must declare between 1 and ${MAX_STATES} states, got ${states.length}`);
		return errors;
	}

	const statesById = new Map<string, Record<string, unknown>>();
	for (const [index, state] of states.entries()) {
		if (!isRecord(state)) {
			errors.push(`states[${index}] must be an object`);
			continue;
		}
		const stateId = state.id;
		if (!isNonEmptyStr(stateId)) {
			errors.push(`states[${index}] requires a non-empty id`);
		} else if (!validNodeId(stateId)) {
			errors.push(`states[${index}] id must match ^[a-z0-9][a-z0-9-]{0,63}$, got ${JSON.stringify(stateId)}`);
		} else if (statesById.has(stateId)) {
			errors.push(`states[${index}] duplicates state id ${JSON.stringify(stateId)}`);
		} else {
			statesById.set(stateId, state);
		}
	}

	const seenSubagentNames = new Map<string, string>();
	for (const [stateId, state] of statesById) {
		validateStateFields(state, runBudget, statesById, "state", errors);
		const sub = state.subagent;
		if (isRecord(sub) && isNonEmptyStr(sub.name)) {
			const configuredName = sub.name.trim();
			let baseSeen: string | undefined;
			let baseCurrent: string | undefined;
			for (const seen of seenSubagentNames.keys()) {
				if (suffixedSpawnForm(seen, configuredName)) {
					baseSeen = seen;
					break;
				}
			}
			if (!baseSeen) {
				for (const seen of seenSubagentNames.keys()) {
					if (suffixedSpawnForm(configuredName, seen)) {
						baseCurrent = seen;
						break;
					}
				}
			}
			if (seenSubagentNames.has(configuredName)) {
				errors.push(
					`state ${stateId} subagent name ${JSON.stringify(configuredName)} is already configured by state ${JSON.stringify(seenSubagentNames.get(configuredName))}`,
				);
			} else if (baseSeen) {
				errors.push(
					`state ${stateId} subagent name ${JSON.stringify(configuredName)} collides with the suffixed spawn labels of state ${JSON.stringify(seenSubagentNames.get(baseSeen))} ` +
						`(configured ${JSON.stringify(baseSeen)}): re-entry, foreach, and retries name children ${JSON.stringify(baseSeen)}-i<n> and ${JSON.stringify(baseSeen)}-a<n>`,
				);
			} else if (baseCurrent) {
				errors.push(
					`state ${stateId} subagent name ${JSON.stringify(configuredName)} suffixed by re-entry, foreach, and retries (${JSON.stringify(configuredName)}-i<n>, ${JSON.stringify(configuredName)}-a<n>) ` +
						`collides with state ${JSON.stringify(seenSubagentNames.get(baseCurrent))} (configured ${JSON.stringify(baseCurrent)})`,
				);
			} else {
				seenSubagentNames.set(configuredName, stateId);
			}
		}

		if ("entry" in state && typeof state.entry !== "boolean") {
			errors.push(`state ${stateId} entry must be a boolean`);
		}
		if ("max_entries" in state && !(isInt(state.max_entries) && state.max_entries >= STATE_MAX_ENTRIES_DEFAULT)) {
			errors.push(`state ${stateId} max_entries must be an integer >= ${STATE_MAX_ENTRIES_DEFAULT}`);
		}
		for (const inp of portList(state, "inputs")) {
			if (!isRecord(inp) || inp.optional === true) continue;
			if (state.entry === true) {
				errors.push(
					`entry state ${stateId} input ${JSON.stringify(inp.name)} must be optional: an entry state's first entry has no upstream settle to bind`,
				);
				continue;
			}
			const source = inp.from;
			if (typeof source === "string" && source.includes(".") && source.slice(0, source.indexOf(".")) === stateId) {
				errors.push(
					`state ${stateId} input ${JSON.stringify(inp.name)} cannot require itself: mark the self-input optional - a required one can never bind on the state's first entry`,
				);
			}
		}
	}

	if (statesById.size > 0 && ![...statesById.values()].some((s) => s.entry === true)) {
		errors.push("factory machine requires at least one entry state");
	}

	const transitions = machine.transitions ?? [];
	if (!Array.isArray(transitions)) {
		errors.push("factory machine transitions must be a list");
		return errors;
	}
	for (const [index, transition] of transitions.entries()) {
		if (!isRecord(transition)) {
			errors.push(`transitions[${index}] must be an object`);
			continue;
		}
		const rawSrc = transition.from;
		const dst = transition.to;
		let sources: string[] = [];
		if (Array.isArray(rawSrc)) {
			if (rawSrc.length === 0) {
				errors.push(`transitions[${index}] from must name at least one state`);
			} else if (!rawSrc.every(isNonEmptyStr)) {
				errors.push(`transitions[${index}] from entries must be non-empty state id strings`);
			} else if (new Set(rawSrc).size !== rawSrc.length) {
				errors.push(`transitions[${index}] from must not repeat a state`);
			} else {
				sources = rawSrc;
				const missing = sources.find((s) => !statesById.has(s));
				if (missing !== undefined) {
					errors.push(`transitions[${index}] references unknown from-state ${JSON.stringify(missing)}`);
				}
			}
			if (transition.when !== undefined && transition.when !== null) {
				errors.push(
					`transitions[${index}] with multiple from-states cannot carry a when guard; use single-state transitions for guards`,
				);
			}
		} else if (isNonEmptyStr(rawSrc)) {
			sources = [rawSrc];
			if (!statesById.has(rawSrc)) {
				errors.push(`transitions[${index}] references unknown from-state ${JSON.stringify(rawSrc)}`);
			}
		} else {
			errors.push(`transitions[${index}] requires a non-empty from`);
		}

		if (!isNonEmptyStr(dst)) {
			errors.push(`transitions[${index}] requires a non-empty to`);
		} else if (!statesById.has(dst)) {
			errors.push(`transitions[${index}] references unknown to-state ${JSON.stringify(dst)}`);
		}

		const on = transition.on ?? TRANSITION_ON_KINDS[0];
		if (!TRANSITION_ON_KINDS.includes(on as (typeof TRANSITION_ON_KINDS)[number])) {
			errors.push(`transitions[${index}] on must be one of ${JSON.stringify(TRANSITION_ON_KINDS)}, got ${JSON.stringify(on)}`);
		}

		for (const src of sources) {
			const srcState = statesById.get(src);
			if (!srcState) continue;
			if ((srcState.lifecycle ?? NODE_LIFECYCLE_DEFAULT) === "resident") {
				errors.push(`transitions[${index}] cannot leave resident state ${JSON.stringify(src)}`);
			}
			if (sources.length === 1 && transition.when !== undefined && transition.when !== null) {
				validateGuard(transition.when, index, srcState, errors);
			}
		}
	}
	return errors;
}

function effectiveDagEdges(node: Record<string, unknown>): string[] {
	const edges: string[] = [];
	for (const dep of portList(node, "depends_on")) {
		if (isNonEmptyStr(dep) && !edges.includes(dep)) edges.push(dep);
	}
	for (const source of inputSources(node)) {
		if (!edges.includes(source)) edges.push(source);
	}
	return edges;
}

export function compileFactoryDag(dag: unknown): [Record<string, unknown> | null, string[]] {
	if (!isRecord(dag)) return [null, ["factory dag must be a JSON object"]];
	const errors: string[] = [];
	let run: unknown = dag.run;
	if (run !== undefined && run !== null && !isRecord(run)) {
		errors.push("run must be an object");
		run = null;
	}
	const runBudget = validateRunFields(run, errors);

	const nodes = dag.nodes;
	if (!Array.isArray(nodes)) {
		return [null, [...errors, "factory dag requires a nodes list"]];
	}
	if (nodes.length < 1 || nodes.length > MAX_NODES) {
		return [null, [...errors, `factory dag must declare between 1 and ${MAX_NODES} nodes, got ${nodes.length}`]];
	}

	const nodesById = new Map<string, Record<string, unknown>>();
	for (const [index, node] of nodes.entries()) {
		if (!isRecord(node)) {
			errors.push(`nodes[${index}] must be an object`);
			continue;
		}
		const nodeId = node.id;
		if (!isNonEmptyStr(nodeId)) {
			errors.push(`nodes[${index}] requires a non-empty id`);
		} else if (!validNodeId(nodeId)) {
			errors.push(`nodes[${index}] id must match ^[a-z0-9][a-z0-9-]{0,63}$, got ${JSON.stringify(nodeId)}`);
		} else if (nodesById.has(nodeId)) {
			errors.push(`nodes[${index}] duplicates node id ${JSON.stringify(nodeId)}`);
		} else {
			nodesById.set(nodeId, node);
		}
	}

	for (const [nodeId, node] of nodesById) {
		validateStateFields(node, runBudget, nodesById, "node", errors);
		if (inputSources(node).includes(nodeId)) {
			errors.push(`node ${nodeId} cannot depend on itself`);
		}
		const dependsOn = node.depends_on;
		if (dependsOn !== undefined && dependsOn !== null) {
			if (!Array.isArray(dependsOn)) {
				errors.push(`node ${nodeId} depends_on must be a list of node ids`);
			} else {
				for (const dep of dependsOn) {
					if (!isNonEmptyStr(dep)) {
						errors.push(`node ${nodeId} depends_on entries must be non-empty node id strings`);
					} else if (dep === nodeId) {
						errors.push(`node ${nodeId} cannot depend on itself`);
					} else if (!nodesById.has(dep)) {
						errors.push(`node ${nodeId} depends on unknown node ${JSON.stringify(dep)}`);
					} else if ((nodesById.get(dep)!.lifecycle ?? NODE_LIFECYCLE_DEFAULT) === "resident") {
						errors.push(`node ${nodeId} cannot depend on resident node ${JSON.stringify(dep)}`);
					}
				}
			}
		}
	}
	if (errors.length > 0) return [null, errors];

	const machine: Record<string, unknown> = { states: [], transitions: [] };
	if (run !== undefined && run !== null) {
		machine.run = structuredClone(run);
	}
	const statesList = machine.states as Record<string, unknown>[];
	const transitionsList = machine.transitions as Record<string, unknown>[];

	for (const node of nodes as Record<string, unknown>[]) {
		const edges = effectiveDagEdges(node);
		const state: Record<string, unknown> = {
			id: node.id,
			entry: edges.length === 0,
			max_entries: STATE_MAX_ENTRIES_DEFAULT,
		};
		for (const key of [
			"subagent",
			"javascript",
			"lifecycle",
			"budget_ms",
			"retries",
			"failure_policy",
			"inputs",
			"outputs",
			"foreach",
		]) {
			if (key in node) state[key] = structuredClone(node[key]);
		}
		statesList.push(state);
		if (edges.length > 0) {
			transitionsList.push({ from: edges.length === 1 ? edges[0] : edges, to: node.id });
		}
	}
	return [machine, []];
}

export function validateFactorySpec(spec: unknown): string[] {
	if (!isRecord(spec)) return ["factory dag must be a JSON object"];
	if (isMachineForm(spec) && "nodes" in spec) {
		return ["pass either dag or machine form, not both"];
	}
	if (isMachineForm(spec)) {
		return validateFactoryMachine(spec);
	}
	const [machine, errors] = compileFactoryDag(spec);
	if (errors.length > 0 || !machine) return errors;
	return validateFactoryMachine(machine);
}

function canonicalizeMachine(machine: Record<string, unknown>): Record<string, unknown> {
	const runIn = isRecord(machine.run) ? machine.run : {};
	const runPolicy = (runIn.failure_policy as string | undefined) ?? RUN_FAILURE_POLICY_DEFAULT;
	const statesIn = Array.isArray(machine.states) ? (machine.states as Record<string, unknown>[]) : [];
	const run: Record<string, unknown> = {
		failure_policy: runPolicy,
		max_parallel: (runIn.max_parallel as number | undefined) ?? RUN_MAX_PARALLEL_DEFAULT,
		max_transitions:
			(runIn.max_transitions as number | undefined) ??
			Math.min(TRANSITIONS_PER_STATE_DEFAULT * statesIn.length, MAX_TRANSITIONS_CAP),
		max_children: (runIn.max_children as number | undefined) ?? RUN_MAX_CHILDREN_DEFAULT,
	};
	if ("budget_ms" in runIn) run.budget_ms = runIn.budget_ms;

	const statesOut = statesIn.map((state) => {
		const out: Record<string, unknown> = {
			id: state.id,
			entry: Boolean(state.entry ?? STATE_ENTRY_DEFAULT),
			max_entries: (state.max_entries as number | undefined) ?? STATE_MAX_ENTRIES_DEFAULT,
			lifecycle: (state.lifecycle as string | undefined) ?? NODE_LIFECYCLE_DEFAULT,
			retries: (state.retries as number | undefined) ?? NODE_RETRIES_DEFAULT,
			failure_policy: (state.failure_policy as string | undefined) ?? runPolicy,
		};
		for (const key of ["subagent", "javascript", "budget_ms", "inputs", "outputs", "foreach"]) {
			if (key in state) out[key] = structuredClone(state[key]);
		}
		return out;
	});

	const transitionsIn = Array.isArray(machine.transitions) ? (machine.transitions as Record<string, unknown>[]) : [];
	const transitionsOut = transitionsIn.map((transition) => {
		const out: Record<string, unknown> = {
			from: structuredClone(transition.from),
			to: transition.to,
			on: (transition.on as string | undefined) ?? TRANSITION_ON_KINDS[0],
		};
		if ("when" in transition && transition.when !== undefined) {
			out.when = structuredClone(transition.when);
		}
		return out;
	});

	return { run, states: statesOut, transitions: transitionsOut };
}

export function canonicalizeFactorySpec(spec: unknown): Record<string, unknown> {
	const errors = validateFactorySpec(spec);
	if (errors.length > 0) throw new Error(errors.join("; "));
	const rec = spec as Record<string, unknown>;
	if (isMachineForm(rec)) {
		return canonicalizeMachine(rec);
	}
	const [machine] = compileFactoryDag(rec);
	return canonicalizeMachine(machine!);
}

export function topologicalOrder(nodes: unknown): string[] {
	if (!Array.isArray(nodes)) throw new Error("nodes must be a list");
	const indexOf = new Map<string, number>();
	for (const [index, node] of nodes.entries()) {
		if (!isRecord(node)) throw new Error(`nodes[${index}] must be an object`);
		const nodeId = node.id;
		if (!isNonEmptyStr(nodeId)) throw new Error(`nodes[${index}] requires a non-empty id`);
		if (indexOf.has(nodeId)) throw new Error(`duplicate node id ${JSON.stringify(nodeId)}`);
		indexOf.set(nodeId, index);
	}
	const deps = new Map<string, Set<string>>();
	for (const node of nodes as Record<string, unknown>[]) {
		const nodeId = node.id as string;
		const edges = new Set<string>();
		if (node.depends_on !== undefined && node.depends_on !== null) {
			if (!Array.isArray(node.depends_on)) throw new Error(`node ${JSON.stringify(nodeId)} depends_on must be a list of node ids`);
			for (const dep of node.depends_on) {
				if (!isNonEmptyStr(dep)) throw new Error(`node ${JSON.stringify(nodeId)} depends_on entries must be non-empty node id strings`);
				edges.add(dep);
			}
		}
		if (node.inputs !== undefined && node.inputs !== null) {
			if (!Array.isArray(node.inputs)) throw new Error(`node ${JSON.stringify(nodeId)} inputs must be a list`);
			for (const inp of node.inputs) {
				if (!isRecord(inp)) throw new Error(`node ${JSON.stringify(nodeId)} inputs entries must be objects`);
				const source = inp.from;
				if (typeof source !== "string" || !source.includes(".")) {
					throw new Error(`node ${JSON.stringify(nodeId)} inputs require a 'from' reference of the form '<node_id>.<output_name>'`);
				}
				edges.add(source.slice(0, source.indexOf(".")));
			}
		}
		deps.set(nodeId, edges);
	}

	const remaining = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const id of indexOf.keys()) dependents.set(id, []);
	for (const [nodeId, edges] of deps) {
		for (const dep of edges) {
			if (!indexOf.has(dep)) throw new Error(`node ${JSON.stringify(nodeId)} depends on unknown node ${JSON.stringify(dep)}`);
			dependents.get(dep)!.push(nodeId);
		}
		remaining.set(nodeId, edges.size);
	}

	const ready: string[] = [...remaining.entries()]
		.filter(([, count]) => count === 0)
		.map(([id]) => id)
		.sort((a, b) => indexOf.get(a)! - indexOf.get(b)!);

	const order: string[] = [];
	while (ready.length > 0) {
		const current = ready.shift()!;
		order.push(current);
		for (const dep of dependents.get(current)!) {
			const nextCount = remaining.get(dep)! - 1;
			remaining.set(dep, nextCount);
			if (nextCount === 0) {
				ready.push(dep);
				ready.sort((a, b) => indexOf.get(a)! - indexOf.get(b)!);
			}
		}
	}
	if (order.length !== indexOf.size) {
		const stuck = [...remaining.entries()]
			.filter(([, count]) => count > 0)
			.map(([id]) => id)
			.sort();
		throw new Error(`the factory graph contains a cycle involving nodes: ${stuck.join(", ")}`);
	}
	return order;
}

// ---------------------------------------------------------------------------
// Opt-in gate: factory.enabled in <agent dir>/settings.json
// ---------------------------------------------------------------------------

function resolveAgentDir(): string {
	const raw =
		(process.env.PRIME_AGENT_CODING_AGENT_DIR ?? "").trim() ||
		(process.env.PI_CODING_AGENT_DIR ?? "").trim() ||
		path.join(homedir(), ".prime", "agent");
	return path.resolve(raw.replace(/^~(?=\/|$)/, homedir()));
}

export function factoryEnabled(): boolean {
	try {
		const raw = fs.readFileSync(path.join(resolveAgentDir(), "settings.json"), "utf8");
		const doc = JSON.parse(raw) as unknown;
		if (!isRecord(doc)) return false;
		const factory = doc.factory;
		return isRecord(factory) && factory.enabled === true;
	} catch {
		return false;
	}
}

export function requireFactoryEnabled(): void {
	if (!factoryEnabled()) {
		throw new Error(FACTORY_DISABLED_MESSAGE);
	}
}

// ---------------------------------------------------------------------------
// Machine Library (MACHINE.md parse / render / resolve / import / export / CLI)
// ---------------------------------------------------------------------------

export interface MachineFile {
	readonly name: string;
	readonly description: string;
	readonly version: string;
	readonly author: string;
	readonly spec: Record<string, unknown>;
}

export class MachineResolutionError extends Error {
	readonly broken: boolean;
	constructor(message: string, opts: { broken: boolean }) {
		super(message);
		this.name = "MachineResolutionError";
		this.broken = opts.broken;
	}
}

export function machineNameErrors(name: unknown): string[] {
	if (typeof name !== "string" || !name) return ["machine name must be a non-empty string"];
	const errors: string[] = [];
	if (name.length > MACHINE_NAME_MAX_LENGTH) {
		errors.push(`machine name exceeds ${MACHINE_NAME_MAX_LENGTH} characters (${name.length})`);
	}
	if (!MACHINE_NAME_RE.test(name)) {
		errors.push("machine name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	}
	if (name.endsWith("-")) {
		errors.push("machine name must not end with a hyphen");
	}
	return errors;
}

export function machineDescriptionErrors(description: unknown): string[] {
	if (typeof description !== "string" || !description.trim()) {
		return ["frontmatter description is required"];
	}
	if (description.length > MACHINE_DESCRIPTION_MAX_LENGTH) {
		return [`frontmatter description exceeds ${MACHINE_DESCRIPTION_MAX_LENGTH} characters (${description.length})`];
	}
	if (description.includes("\n") || description.includes("\r")) {
		return ["frontmatter description must be a single line"];
	}
	return [];
}

function unquoteFrontmatterValue(raw: string, field: string): [string | null, string | null] {
	const value = raw.trim();
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		try {
			const unquoted = JSON.parse(value) as unknown;
			if (typeof unquoted !== "string") {
				return [null, `frontmatter ${field} must be a string scalar`];
			}
			return [unquoted, null];
		} catch (error) {
			return [null, `frontmatter ${field} has an invalid double-quoted value (${error instanceof Error ? error.message : String(error)})`];
		}
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return [value.slice(1, -1).replaceAll("''", "'"), null];
	}
	if (value.includes(":")) {
		return [null, `frontmatter ${field} is not a plain scalar (quote the value to include ':' characters)`];
	}
	return [value, null];
}

function parseMachineFrontmatter(text: string, source: string): [Record<string, string> | null, string, string[]] {
	const normalized = text.replace(/^\ufeff/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	if (lines.length === 0 || lines[0]!.trimEnd() !== "---") {
		return [null, "", [`${source}: MACHINE.md must start with a \`---\` frontmatter block`]];
	}
	const fields: Record<string, string> = {};
	const errors: string[] = [];
	let closeIndex: number | null = null;
	for (let i = 1; i < lines.length; i += 1) {
		const line = lines[i]!.trimEnd();
		if (line === "---") {
			closeIndex = i;
			break;
		}
		if (!line.trim()) {
			errors.push(`${source}: frontmatter line ${i + 1} is empty (one \`key: value\` line per field)`);
			continue;
		}
		const colon = line.indexOf(":");
		if (colon < 0) {
			errors.push(`${source}: frontmatter line ${i + 1} must be \`key: value\``);
			continue;
		}
		const key = line.slice(0, colon).trim();
		const rawValue = line.slice(colon + 1);
		if (!MACHINE_FRONTMATTER_FIELDS.includes(key as (typeof MACHINE_FRONTMATTER_FIELDS)[number])) {
			errors.push(`${source}: unknown frontmatter key ${JSON.stringify(key)} (allowed: ${MACHINE_FRONTMATTER_FIELDS.join(", ")})`);
			continue;
		}
		if (key in fields) {
			errors.push(`${source}: frontmatter field ${JSON.stringify(key)} is declared more than once`);
			continue;
		}
		if (!rawValue.trim()) {
			errors.push(`${source}: frontmatter field ${JSON.stringify(key)} requires a value`);
			continue;
		}
		const [unquoted, err] = unquoteFrontmatterValue(rawValue, key);
		if (err !== null) {
			errors.push(`${source}: ${err}`);
			continue;
		}
		fields[key] = unquoted!;
	}
	if (closeIndex === null) {
		return [null, "", [`${source}: frontmatter is not closed (end it with a \`---\` line)`]];
	}
	const body = lines.slice(closeIndex + 1).join("\n");
	if (errors.length > 0) return [null, "", errors];
	return [fields, body, []];
}

function extractMachineSpecBlocks(body: string, source: string): [string | null, string[]] {
	const lines = body.split("\n");
	const contents: string[] = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index]!.trimEnd();
		if (!line.trimStart().startsWith("```")) {
			index += 1;
			continue;
		}
		const openIndex = index;
		const info = line.trim().slice(3).trim();
		index += 1;
		const contentLines: string[] = [];
		let closed = false;
		while (index < lines.length) {
			const fenceLine = lines[index]!.trimEnd();
			if (fenceLine === "```") {
				closed = true;
				index += 1;
				break;
			}
			contentLines.push(lines[index]!);
			index += 1;
		}
		if (info !== MACHINE_SPEC_FENCE) {
			if (!closed) {
				return [null, [`${source}: the \`\`\`${info} fence opened at line ${openIndex + 1} is never closed`]];
			}
			continue;
		}
		if (!closed) {
			return [null, [`${source}: the \`\`\`${MACHINE_SPEC_FENCE} fence is never closed`]];
		}
		contents.push(contentLines.join("\n"));
	}
	if (contents.length === 0) {
		return [null, [`${source}: MACHINE.md requires exactly one fenced \`\`\`${MACHINE_SPEC_FENCE} block; found none`]];
	}
	if (contents.length > 1) {
		return [
			null,
			[`${source}: MACHINE.md requires exactly one fenced \`\`\`${MACHINE_SPEC_FENCE} block; found ${contents.length}`],
		];
	}
	return [contents[0]!, []];
}

export function parseMachineFile(text: string, source = "machine file"): [MachineFile | null, string[]] {
	const [fields, body, fmErrors] = parseMachineFrontmatter(text, source);
	if (!fields) return [null, fmErrors];
	const [payload, blockErrors] = extractMachineSpecBlocks(body, source);
	if (blockErrors.length > 0 || payload === null) return [null, blockErrors];
	let spec: unknown;
	try {
		spec = JSON.parse(payload);
	} catch (error) {
		return [
			null,
			[`${source}: the \`\`\`${MACHINE_SPEC_FENCE} block must contain a JSON object (${error instanceof Error ? error.message : String(error)})`],
		];
	}
	if (!isRecord(spec)) {
		return [null, [`${source}: the \`\`\`${MACHINE_SPEC_FENCE} block must contain a JSON object, got ${Array.isArray(spec) ? "an array" : typeof spec}`]];
	}
	const name = fields.name ?? "";
	const errors = [...machineNameErrors(name), ...machineDescriptionErrors(fields.description)];
	if (errors.length > 0) return [null, errors];
	return [
		Object.freeze({
			name,
			description: fields.description!,
			version: fields.version ?? "",
			author: fields.author ?? "",
			spec,
		}),
		[],
	];
}

function renderFrontmatterValue(value: string): string {
	return PLAIN_FRONTMATTER_VALUE_RE.test(value) ? value : JSON.stringify(value);
}

function machineContractLines(spec: Record<string, unknown>): string[] {
	const lines: string[] = [];
	if (isRecord(spec.run)) {
		const parts = [`failure_policy=${spec.run.failure_policy}`, `max_parallel=${spec.run.max_parallel}`];
		if ("budget_ms" in spec.run) parts.push(`budget_ms=${spec.run.budget_ms}`);
		if ("max_transitions" in spec.run) parts.push(`max_transitions=${spec.run.max_transitions}`);
		lines.push(`Run: ${parts.join(", ")}`);
	}
	const states = Array.isArray(spec.states) ? spec.states : Array.isArray(spec.nodes) ? spec.nodes : null;
	if (!states) return lines;
	lines.push("", "States:");
	for (const state of states) {
		if (!isRecord(state)) continue;
		const flags: string[] = [];
		if (state.entry) flags.push("entry");
		for (const key of ["lifecycle", "max_entries", "retries", "failure_policy", "budget_ms"]) {
			if (key in state) flags.push(`${key}=${state[key]}`);
		}
		lines.push(`- ${state.id}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`);
		if (isRecord(state.javascript)) {
			lines.push(`  javascript: ${state.javascript.import}.${state.javascript.callable}`);
		} else if (isRecord(state.subagent)) {
			const settings =
				(typeof state.subagent.name === "string" && state.subagent.name) ||
				(typeof state.subagent.prompt === "string" ? state.subagent.prompt.slice(0, 60) : "");
			lines.push(`  subagent: inline (${settings})`);
		} else if (typeof state.subagent === "string") {
			lines.push(`  subagent: ${state.subagent}`);
		}
		for (const inp of portList(state, "inputs")) {
			if (!isRecord(inp)) continue;
			lines.push(`  input: ${inp.name} (${inp.type}) <- ${inp.from}${inp.optional ? " [optional]" : ""}`);
		}
		for (const out of portList(state, "outputs")) {
			if (!isRecord(out)) continue;
			lines.push(`  output: ${out.name} (${out.type})`);
		}
		if (isRecord(state.foreach)) {
			lines.push(`  foreach: over ${state.foreach.over}, max ${state.foreach.max}`);
		}
	}
	if (Array.isArray(spec.transitions)) {
		lines.push("", "Transitions:");
		for (const t of spec.transitions) {
			if (!isRecord(t)) continue;
			const src = Array.isArray(t.from) ? `[${t.from.join(", ")}]` : String(t.from);
			let guardText = "";
			if (isRecord(t.when)) {
				const target = t.when.path ? `${t.when.output}.${t.when.path}` : String(t.when.output);
				guardText = ` when ${target} ${t.when.op} ${JSON.stringify(t.when.value)}`;
			}
			lines.push(`- ${src} -> ${t.to}${guardText}`);
		}
	}
	return lines;
}

export function renderMachineFile(machine: MachineFile): string {
	const sections = [
		[
			"---",
			`name: ${renderFrontmatterValue(machine.name)}`,
			`description: ${renderFrontmatterValue(machine.description)}`,
			`version: ${renderFrontmatterValue(machine.version)}`,
			`author: ${renderFrontmatterValue(machine.author)}`,
			"---",
		].join("\n"),
		"",
		`# ${machine.name}`,
		"",
		"## Machine contract",
		"",
		...machineContractLines(machine.spec),
		"",
		`\`\`\`${MACHINE_SPEC_FENCE}`,
		JSON.stringify(machine.spec, null, 2),
		"```",
	];
	return `${sections.join("\n")}\n`;
}

export function repoMachinesDir(): string {
	const override = (process.env.PRIME_AGENT_MACHINES_DIR ?? "").trim();
	if (override) return path.resolve(override.replace(/^~(?=\/|$)/, homedir()));
	return path.resolve(path.dirname(new URL(import.meta.url).pathname), MACHINES_DIR_NAME);
}

export function userMachinesDir(): string {
	return path.join(resolveAgentDir(), MACHINES_DIR_NAME);
}

export function machineLibraryDirs(opts?: { repoDir?: string; userDir?: string }): Array<[string, string]> {
	const repo = opts?.repoDir ? path.resolve(opts.repoDir.replace(/^~(?=\/|$)/, homedir())) : repoMachinesDir();
	const user = opts?.userDir ? path.resolve(opts.userDir.replace(/^~(?=\/|$)/, homedir())) : userMachinesDir();
	return [
		["repo", repo],
		["user", user],
	];
}

function readLibraryMachine(filePath: string): [MachineFile | null, string] {
	let text: string;
	try {
		const raw = fs.readFileSync(filePath);
		text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
	} catch (error) {
		return [null, `${filePath}: unreadable (${error instanceof Error ? error.message : String(error)})`];
	}
	const [machine, errors] = parseMachineFile(text, filePath);
	if (!machine || errors.length > 0) {
		return [null, `${filePath}: ${errors.join("; ")}`];
	}
	const specErrors = validateFactorySpec(machine.spec);
	if (specErrors.length > 0) {
		return [machine, `${filePath}: ${specErrors.join("; ")}`];
	}
	return [machine, ""];
}

export function scanMachineLibrary(opts?: {
	repoDir?: string;
	userDir?: string;
}): [Array<Record<string, string>>, string[]] {
	const machines = new Map<string, Record<string, string>>();
	const warnings: string[] = [];
	for (const [source, dir] of machineLibraryDirs(opts)) {
		let subdirs: string[];
		try {
			subdirs = fs.readdirSync(dir).sort();
		} catch {
			continue;
		}
		for (const sub of subdirs) {
			const filePath = path.join(dir, sub, MACHINE_FILE_NAME);
			try {
				if (!fs.statSync(filePath).isFile()) continue;
			} catch {
				continue;
			}
			const [machine, error] = readLibraryMachine(filePath);
			if (error || !machine) {
				warnings.push(error);
				continue;
			}
			if (machines.has(machine.name)) continue;
			machines.set(machine.name, {
				name: machine.name,
				description: machine.description,
				version: machine.version,
				author: machine.author,
				source,
				path: filePath,
			});
		}
	}
	const sorted = [...machines.keys()].sort().map((name) => machines.get(name)!);
	return [sorted, warnings];
}

export function listMachines(opts?: { repoDir?: string; userDir?: string }): Array<Record<string, string>> {
	return scanMachineLibrary(opts)[0];
}

export function resolveMachine(
	name: string,
	opts?: { repoDir?: string; userDir?: string },
): [MachineFile, string] {
	const nameErrs = machineNameErrors(name);
	if (nameErrs.length > 0) throw new Error(nameErrs.join("; "));
	let broken: string | null = null;
	for (const [, dir] of machineLibraryDirs(opts)) {
		const filePath = path.join(dir, name, MACHINE_FILE_NAME);
		try {
			if (!fs.statSync(filePath).isFile()) continue;
		} catch {
			continue;
		}
		const [machine, fileError] = readLibraryMachine(filePath);
		if (fileError || !machine) {
			if (broken === null && (!machine || machine.name === name)) broken = fileError;
			continue;
		}
		if (machine.name === name) return [machine, filePath];
	}
	const listed = listMachines(opts);
	for (const entry of listed) {
		if (entry.name === name) {
			const [machine, parseErrors] = parseMachineFile(fs.readFileSync(entry.path!, "utf8"), entry.path!);
			if (!machine || parseErrors.length > 0) {
				throw new MachineResolutionError(parseErrors.join("; "), { broken: true });
			}
			return [machine, entry.path!];
		}
	}
	if (broken !== null) throw new MachineResolutionError(broken, { broken: true });
	const listing = listed.map((e) => e.name).join(", ") || "none";
	throw new MachineResolutionError(
		`unknown machine ${JSON.stringify(name)}: no MACHINE.md for it in the machine library (machines: ${listing})`,
		{ broken: false },
	);
}

export function importMachine(
	sourcePathInput: string,
	opts?: { targetDir?: string },
): { name: string; path: string; created: boolean } {
	const sourcePath = path.resolve(sourcePathInput.replace(/^~(?=\/|$)/, homedir()));
	let isFile = false;
	try {
		isFile = fs.statSync(sourcePath).isFile();
	} catch {
		isFile = false;
	}
	if (!isFile) throw new Error(`machine file not found: ${sourcePath}`);
	const raw = fs.readFileSync(sourcePath);
	const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
	const [machine, errors] = parseMachineFile(text, sourcePath);
	if (!machine || errors.length > 0) throw new Error(errors.join("; "));
	const specErrors = validateFactorySpec(machine.spec);
	if (specErrors.length > 0) throw new Error(specErrors.join("; "));
	const destRoot = opts?.targetDir
		? path.resolve(opts.targetDir.replace(/^~(?=\/|$)/, homedir()))
		: userMachinesDir();
	const destination = path.join(destRoot, machine.name, MACHINE_FILE_NAME);
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	const created = !fs.existsSync(destination);
	fs.writeFileSync(destination, raw);
	return { name: machine.name, path: destination, created };
}

function writeExportTarget(destination: string, text: string, overwrite: boolean): void {
	if (overwrite) {
		fs.writeFileSync(destination, text, "utf8");
		return;
	}
	try {
		fs.writeFileSync(destination, text, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
			throw new Error(`export path ${destination} already exists (pass overwrite: true to replace it)`);
		}
		throw error;
	}
}

export function exportFactorySpec(
	spec: unknown,
	outPath: string,
	opts: { name: string; description: string; version?: string; author?: string; overwrite?: boolean },
): { name: string; path: string; source: string } {
	const errors = [
		...validateFactorySpec(spec),
		...machineNameErrors(opts.name),
		...machineDescriptionErrors(opts.description),
	];
	if (errors.length > 0) throw new Error(errors.join("; "));
	const machine: MachineFile = {
		name: opts.name,
		description: opts.description,
		version: opts.version ?? "1",
		author: opts.author ?? "",
		spec: structuredClone(spec as Record<string, unknown>),
	};
	const destination = path.resolve(outPath.replace(/^~(?=\/|$)/, homedir()));
	try {
		if (fs.statSync(destination).isDirectory()) {
			throw new Error(`export path ${destination} is a directory (pass a file path)`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
	}
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	writeExportTarget(destination, renderMachineFile(machine), Boolean(opts.overwrite));
	return { name: opts.name, path: destination, source: "spec" };
}

export function exportLibraryMachine(
	name: string,
	outPath: string,
	opts?: { repoDir?: string; userDir?: string; overwrite?: boolean },
): { name: string; path: string; source: string } {
	const [machine, filePath] = resolveMachine(name, opts);
	const destination = path.resolve(outPath.replace(/^~(?=\/|$)/, homedir()));
	try {
		if (fs.statSync(destination).isDirectory()) {
			throw new Error(`export path ${destination} is a directory (pass a file path)`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
	}
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	writeExportTarget(destination, fs.readFileSync(filePath, "utf8"), Boolean(opts?.overwrite));
	return { name: machine.name, path: destination, source: "library" };
}

export function cliDispatch(payload: unknown): Record<string, unknown> {
	if (!isRecord(payload)) {
		return { ok: false, errors: ["factory cli payload must be a JSON object"] };
	}
	const op = payload.op;
	if (op === "list") {
		const [machines, warnings] = scanMachineLibrary();
		return { ok: true, machines, warnings };
	}
	if (op === "import") {
		if (typeof payload.path !== "string" || !payload.path) {
			return { ok: false, errors: ["factory import requires a `path` string"] };
		}
		try {
			const result = importMachine(payload.path);
			return { ok: true, ...result };
		} catch (error) {
			return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
		}
	}
	if (op === "export") {
		if (typeof payload.name !== "string" || !payload.name) {
			return { ok: false, errors: ["factory export requires a `name` string"] };
		}
		if (typeof payload.out !== "string" || !payload.out) {
			return { ok: false, errors: ["factory export requires an `out` string"] };
		}
		try {
			const result = exportLibraryMachine(payload.name, payload.out);
			return { ok: true, ...result };
		} catch (error) {
			return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
		}
	}
	return {
		ok: false,
		errors: [`unknown factory cli op ${JSON.stringify(op)} (expected 'list', 'import' or 'export')`],
	};
}

export const FACTORY_HELP = `# Factory

The factory runs state-machine workflows of spawned child agents. A stored
factory entry declares the machine — states, each backed by a subagent
spec or a JavaScript callable, plus guarded transitions between them.
\`await rlm.factory.run('<spec_id>')\` spawns each state's subagent as an
ordinary child, feeds captured outputs into the successors' prompts, and
drives the run to quiescence in the background; the call returns immediately.

The factory is opt-in: turn it on with \`/factory on\` (\`factory.enabled\` in
settings.json). While disabled, every \`rlm.factory\` call except \`help()\` and
every factory harness write refuses with:
"${FACTORY_DISABLED_MESSAGE}".

## Store the spec

\`\`\`js
rlm.harness.createFactory("pr-manager", "Drive a PR through review/fix cycles.", {
  id: "pr-manager",
  machine: {
    run: { budget_ms: 1_800_000, max_parallel: 8, max_transitions: 24 },
    states: [
      {
        id: "entry",
        entry: true,
        subagent: { prompt: "Identify the PR URL and return a fenced json block {\\"pr_url\\": \\"...\\"}." },
        outputs: [{ name: "pr_url", type: "json" }],
      },
      {
        id: "reviewing",
        subagent: { prompt: "Review {pr_url}. Return {\\"verdict\\": {\\"approved\\": true|false}}." },
        inputs: [
          { name: "pr_url", type: "json", from: "entry.pr_url" },
          { name: "fix_report", type: "json", from: "fixing.fix_report", optional: true },
        ],
        outputs: [{ name: "verdict", type: "json" }],
        max_entries: 4,
      },
      {
        id: "fixing",
        subagent: { prompt: "Fix findings in {verdict}. Return {\\"fix_report\\": {...}}." },
        inputs: [{ name: "verdict", type: "json", from: "reviewing.verdict" }],
        outputs: [{ name: "fix_report", type: "json" }],
        max_entries: 3,
      },
      {
        id: "monitoring",
        subagent: { prompt: "Watch {pr_url} checks." },
        inputs: [{ name: "pr_url", type: "json", from: "entry.pr_url" }],
        lifecycle: "resident",
      },
    ],
    transitions: [
      { from: "entry", to: "reviewing" },
      { from: "reviewing", to: "fixing", when: { output: "verdict", path: "approved", op: "eq", value: false } },
      { from: "reviewing", to: "monitoring", when: { output: "verdict", path: "approved", op: "eq", value: true } },
      { from: "fixing", to: "reviewing" },
    ],
  },
});
\`\`\`

## JavaScript states

A state can run a JavaScript/TypeScript function in an isolated Bun subprocess:
\`"javascript": { "import": "./my-tools.ts", "callable": "changedFiles" }\`.
The function receives the bound inputs object and returns an object whose keys
match the state's declared outputs.

## Run and steer

\`\`\`js
const result = await rlm.factory.run("review-sweep");
const status = await rlm.factory.status(result.run_id);
const graph  = await rlm.factory.graph(result.run_id);
const watch  = await rlm.factory.watch(result.run_id, 30);
await rlm.factory.resume(result.run_id);
await rlm.factory.stop(result.run_id);
\`\`\`

## Machine library

Bundled seeds: \`builder\`, \`pr-manager\`, and \`review-sweep\`.
Manage the library with \`prime-agent factory list | import | export\`.
`;
