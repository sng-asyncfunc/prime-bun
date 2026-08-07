import {
	getHarnessStatePath,
	type HarnessEntry,
	type HarnessRefinementEvent,
	type HarnessScope,
	type HarnessState,
	loadHarnessState,
	normalizeJavaScriptSkillReference,
	type RefinementKind,
	saveHarnessState,
} from "../refinement/index.js";
import type { HostRequestHandlers } from "./index.js";

const HARNESS_KINDS: readonly RefinementKind[] = ["prompt", "memory", "skill", "subagent"];

export interface HarnessHostDirectories {
	localDirectory?: string;
	globalDirectory: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(payload: Record<string, unknown>, name: string): string {
	const value = payload[name];
	if (typeof value !== "string" || !value.trim()) throw new TypeError(`harness ${name} must be a non-empty string`);
	return value;
}

function optionalString(payload: Record<string, unknown>, name: string): string | undefined {
	const value = payload[name];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new TypeError(`harness ${name} must be a string`);
	return value;
}

function optionalRecord(payload: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
	const value = payload[name];
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new TypeError(`harness ${name} must be an object`);
	return value;
}

function requireKind(payload: Record<string, unknown>): RefinementKind {
	const kind = payload.kind;
	if (kind !== "prompt" && kind !== "memory" && kind !== "skill" && kind !== "subagent") {
		throw new TypeError(`unknown harness kind ${String(kind)}`);
	}
	return kind;
}

function requestedGlobal(payload: Record<string, unknown>): boolean {
	const value = payload.global;
	if (value === undefined) return false;
	if (typeof value !== "boolean") throw new TypeError("harness global must be a boolean");
	return value;
}

function resolveIdAndScope(payload: Record<string, unknown>): { id?: string; global: boolean } {
	const rawId = optionalString(payload, "id");
	let global = requestedGlobal(payload);
	if (!rawId) return { global };
	const match = /^(local|global):(.+)$/.exec(rawId);
	if (!match) return { global, id: rawId };
	if (match[1] === "global") global = true;
	return { global, id: match[2] };
}

function directoryForScope(directories: HarnessHostDirectories, global: boolean, mutating: boolean): string {
	if (global) return directories.globalDirectory;
	if (directories.localDirectory) return directories.localDirectory;
	if (mutating) {
		throw new Error(
			"Local harness state requires a persistent session. Pass { global: true } for stable cross-session state.",
		);
	}
	return "";
}

function loadState(
	directories: HarnessHostDirectories,
	global: boolean,
	mutating: boolean,
): { directory?: string; scope: HarnessScope; state: HarnessState } {
	const scope: HarnessScope = global ? "global" : "local";
	const directory = directoryForScope(directories, global, mutating);
	if (!directory) {
		return {
			scope,
			state: {
				schema: 1,
				entries: { memory: {}, prompt: {}, skill: {}, subagent: {} },
				refinements: [],
			},
		};
	}
	return { directory, scope, state: loadHarnessState(directory, scope) };
}

function slug(raw: string, fallback: string): string {
	const normalized = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return normalized || fallback;
}

function validateJavaScriptSkillReference(reference: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!reference) throw new Error("skill entries require a JavaScript reference");
	if (reference.type !== "javascript") throw new Error('skill reference.type must be "javascript"');
	if (typeof reference.global !== "string" || !reference.global) {
		throw new Error("skill reference requires a JavaScript global");
	}
	const normalized = normalizeJavaScriptSkillReference(reference);
	if (typeof normalized.callPattern !== "string" || !normalized.callPattern) {
		throw new Error("skill reference requires a callPattern");
	}
	return normalized;
}

function mutateEntry(
	directories: HarnessHostDirectories,
	payload: Record<string, unknown>,
	operation: "create" | "update" | "upsert",
): HarnessEntry {
	const kind = requireKind(payload);
	const title = requireString(payload, "title");
	const content = requireString(payload, "content");
	const target = resolveIdAndScope(payload);
	const { directory, scope, state } = loadState(directories, target.global, true);
	const id = target.id ?? slug(title, kind);
	const existing = state.entries[kind][id];
	if (operation === "create" && existing) throw new Error(`${kind} entry "${id}" already exists`);
	if (operation === "update" && !existing) throw new Error(`${kind} entry "${id}" does not exist`);
	let reference = optionalRecord(payload, "reference");
	const argumentsValue = optionalRecord(payload, "arguments");
	const metadata = optionalRecord(payload, "metadata");
	if (kind === "skill") {
		reference = validateJavaScriptSkillReference(reference ?? existing?.reference);
	}
	const now = new Date().toISOString();
	const entry: HarnessEntry = {
		arguments: argumentsValue ?? existing?.arguments ?? {},
		content,
		created_at: existing?.created_at ?? now,
		id,
		kind,
		metadata: metadata ?? existing?.metadata ?? {},
		path: optionalString(payload, "path") ?? existing?.path ?? (kind === "prompt" ? "policy" : "general"),
		reference: reference ?? existing?.reference ?? {},
		scope,
		source: optionalString(payload, "source") ?? "agent",
		title,
		updated_at: now,
		version: existing ? existing.version + 1 : 1,
	};
	state.entries[kind][id] = entry;
	saveHarnessState(directory!, state);
	return entry;
}

function readEntry(directories: HarnessHostDirectories, payload: Record<string, unknown>): HarnessEntry | undefined {
	const kind = requireKind(payload);
	const target = resolveIdAndScope(payload);
	const id = target.id;
	if (!id) throw new TypeError("harness id must be a non-empty string");
	return loadState(directories, target.global, false).state.entries[kind][id];
}

function deleteEntry(directories: HarnessHostDirectories, payload: Record<string, unknown>): boolean {
	const kind = requireKind(payload);
	const target = resolveIdAndScope(payload);
	const id = target.id;
	if (!id) throw new TypeError("harness id must be a non-empty string");
	const { directory, state } = loadState(directories, target.global, true);
	if (!state.entries[kind][id]) return false;
	delete state.entries[kind][id];
	saveHarnessState(directory!, state);
	return true;
}

function listEntries(directories: HarnessHostDirectories, payload: Record<string, unknown>): HarnessEntry[] {
	const kind = payload.kind === undefined ? undefined : requireKind(payload);
	const state = loadState(directories, requestedGlobal(payload), false).state;
	const kinds = kind ? [kind] : HARNESS_KINDS;
	return kinds
		.flatMap((currentKind) => Object.values(state.entries[currentKind]))
		.sort((left, right) =>
			[left.kind, left.path, left.title, left.id]
				.join("\0")
				.localeCompare([right.kind, right.path, right.title, right.id].join("\0")),
		);
}

function overview(directories: HarnessHostDirectories, payload: Record<string, unknown>): string {
	const max = payload.maxEntriesPerKind === undefined ? 20 : payload.maxEntriesPerKind;
	if (!Number.isInteger(max) || (max as number) < 1) {
		throw new TypeError("harness maxEntriesPerKind must be a positive integer");
	}
	const { scope, state, directory } = loadState(directories, requestedGlobal(payload), false);
	const lines = [`Harness state (${scope}): ${directory ? getHarnessStatePath(directory) : "unpersisted"}`];
	for (const kind of HARNESS_KINDS) {
		const entries = Object.values(state.entries[kind]);
		lines.push(`${kind}: ${entries.length}`);
		for (const entry of entries.slice(0, max as number)) {
			const content = entry.content.replace(/\s+/g, " ").trim();
			lines.push(
				`  - [${entry.scope ?? scope}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version}): ${content.length > 120 ? `${content.slice(0, 117)}...` : content}`,
			);
		}
	}
	lines.push(`refinements: ${state.refinements.length}`);
	return lines.join("\n");
}

export function createHarnessHostHandlers(directories: HarnessHostDirectories): HostRequestHandlers {
	return {
		"harness.create": async (payload) => ({ entry: mutateEntry(directories, payload, "create") }),
		"harness.update": async (payload) => ({ entry: mutateEntry(directories, payload, "update") }),
		"harness.upsert": async (payload) => ({ entry: mutateEntry(directories, payload, "upsert") }),
		"harness.get": async (payload) => ({ entry: readEntry(directories, payload) ?? null }),
		"harness.delete": async (payload) => ({ deleted: deleteEntry(directories, payload) }),
		"harness.list": async (payload) => ({ entries: listEntries(directories, payload) }),
		"harness.record_refinement": async (payload) => {
			const global = requestedGlobal(payload);
			const { directory, state } = loadState(directories, global, true);
			const trigger = requireString(payload, "trigger");
			const rawChanges = payload.changes;
			if (typeof rawChanges !== "string" && !Array.isArray(rawChanges)) {
				throw new TypeError("harness changes must be a string or string array");
			}
			const changes = typeof rawChanges === "string" ? [rawChanges] : rawChanges.map(String);
			const event: HarnessRefinementEvent = {
				changes,
				created_at: new Date().toISOString(),
				evidence: optionalString(payload, "evidence") ?? "",
				id: optionalString(payload, "id") ?? `refine_${String(state.refinements.length + 1).padStart(4, "0")}`,
				outcome: optionalString(payload, "outcome") ?? "",
				trigger,
			};
			state.refinements.push(event);
			saveHarnessState(directory!, state);
			return { event };
		},
		"harness.overview": async (payload) => ({ overview: overview(directories, payload) }),
		"harness.snapshot": async (payload) => ({
			state: loadState(directories, requestedGlobal(payload), false).state,
		}),
	};
}
