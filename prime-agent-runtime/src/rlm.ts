import { type BashHandle, persistentShells } from "./bash.ts";
import { emit, hostRequest } from "./bridge.ts";
import {
	FACTORY_HELP,
	graphFactory,
	resumeFactory,
	runFactory,
	statusFactory,
	stopFactory,
	watchFactory,
} from "./factory.ts";
import { getHarnessState, harnessProxy } from "./harness.ts";

const RENAMED_RUN_MESSAGE =
	"rlm.run was renamed; spawn a child with: const handle = await rlm.spawn('sub-task', { name: 'worker' })";
const TRANSCRIPT_READ_MIME = "application/vnd.prime-agent.transcript-read+json";
export const RLM_PROGRESS_NOTE_MAX_LENGTH = 512;

export interface RlmSpawnHandle {
	readonly rlmChildId: string;
	readonly name: string;
	readonly sessionDir: string;
	readonly model: string;
}

export interface RlmCreateSessionHandle {
	readonly activeSessionId: string;
	readonly sessionId: string;
	readonly name: string;
	readonly sessionFile: string;
	readonly model: string;
}

export interface RlmModel {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly selector: string;
}

export interface RlmSubagentActivity {
	readonly kind: "waiting" | "writing" | "executing";
	readonly toolName: string | null;
}

export interface RlmSubagent {
	readonly rlmChildId: string;
	readonly activeSessionId: string | null;
	readonly sessionId: string | null;
	readonly sessionName: string;
	readonly sessionDir: string;
	readonly status: "running" | "completed" | "error" | "cancelled";
	readonly activity: RlmSubagentActivity | null;
	readonly toolUseCount: number | null;
	readonly durationMs: number | null;
	readonly answerPreview: string | null;
	readonly repliedSinceTask: boolean | null;
	readonly progressNote: string | null;
	readonly label: string | null;
	readonly lastActivityAt: number | null;
	readonly activityStaleMs: number | null;
}

export interface RlmChildResult {
	readonly rlmChildId: string;
	readonly sessionName: string | null;
	readonly sessionDir: string | null;
	readonly status: "queued" | "running" | "done" | "error" | "cancelled";
	readonly settled: boolean;
	readonly answerPreview: string | null;
	readonly answerText: string | null;
	readonly error: string | null;
	readonly durationMs: number | null;
	readonly toolUseCount: number | null;
	readonly repliedSinceTask: boolean | null;
}

export interface RlmProgressNoteResult {
	readonly accepted: boolean;
	readonly retryAfterMs: number | null;
}

export interface RlmMessage {
	readonly index: number;
	readonly id: string;
	readonly role: string;
	readonly text: string;
	readonly timestamp: number | null;
	readonly raw: Record<string, unknown>;
}

export type RlmChildTarget = string | RlmSpawnHandle | RlmSubagent;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, operation: string): string {
	const value = obj[key];
	if (typeof value !== "string" || !value) {
		throw new Error(`${operation} returned an invalid ${key}`);
	}
	return value;
}

function optionalString(obj: Record<string, unknown>, key: string, operation: string): string | null {
	const value = obj[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error(`${operation} entry has invalid ${key}`);
	}
	return value;
}

function optionalInt(obj: Record<string, unknown>, key: string, operation: string): number | null {
	const value = obj[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new Error(`${operation} entry has invalid ${key}`);
	}
	return value;
}

function optionalBool(obj: Record<string, unknown>, key: string, operation: string): boolean | null {
	const value = obj[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "boolean") {
		throw new Error(`${operation} entry has invalid ${key}`);
	}
	return value;
}

function optionalActivity(obj: Record<string, unknown>, operation: string): RlmSubagentActivity | null {
	const value = obj.activity;
	if (value === undefined || value === null) return null;
	if (!isRecord(value)) throw new Error(`${operation} entry has invalid activity`);
	const kind = value.kind;
	if (kind !== "waiting" && kind !== "writing" && kind !== "executing") {
		throw new Error(`${operation} entry has invalid activity kind`);
	}
	const toolName = value.tool_name ?? value.toolName ?? null;
	if (toolName !== null && typeof toolName !== "string") {
		throw new Error(`${operation} entry has invalid activity tool_name`);
	}
	return Object.freeze({ kind, toolName });
}

function targetSelector(target: unknown, what = "collect target"): string {
	if (typeof target === "string") {
		const trimmed = target.trim();
		if (trimmed) return trimmed;
	} else if (isRecord(target)) {
		const id = target.rlmChildId ?? target.rlm_child_id;
		if (typeof id === "string" && id.trim()) return id.trim();
	}
	throw new TypeError(`${what} must be a spawn handle, subagent row, or non-empty string`);
}

function spawnHandleFromPayload(payload: unknown): RlmSpawnHandle {
	if (!isRecord(payload)) throw new Error("rlm.spawn returned an invalid spawn handle");
	return Object.freeze({
		rlmChildId: requireString(payload, "rlm_child_id", "rlm.spawn"),
		name: requireString(payload, "name", "rlm.spawn"),
		sessionDir: requireString(payload, "session_dir", "rlm.spawn"),
		model: requireString(payload, "model", "rlm.spawn"),
	});
}

function createSessionHandleFromPayload(payload: unknown): RlmCreateSessionHandle {
	if (!isRecord(payload)) throw new Error("rlm.createSession returned an invalid payload");
	return Object.freeze({
		activeSessionId: requireString(payload, "active_session_id", "rlm.createSession"),
		sessionId: requireString(payload, "session_id", "rlm.createSession"),
		name: requireString(payload, "name", "rlm.createSession"),
		sessionFile: requireString(payload, "session_file", "rlm.createSession"),
		model: requireString(payload, "model", "rlm.createSession"),
	});
}

function modelFromPayload(payload: unknown): RlmModel {
	if (!isRecord(payload)) throw new Error("rlm.findModels returned an invalid model entry");
	return Object.freeze({
		provider: requireString(payload, "provider", "rlm.findModels"),
		id: requireString(payload, "id", "rlm.findModels"),
		name: requireString(payload, "name", "rlm.findModels"),
		selector: requireString(payload, "selector", "rlm.findModels"),
	});
}

function subagentFromPayload(payload: unknown, operation = "rlm.listSubagents"): RlmSubagent {
	if (!isRecord(payload)) throw new Error(`${operation} returned an invalid subagent entry`);
	const status = payload.status;
	if (status !== "running" && status !== "completed" && status !== "error" && status !== "cancelled") {
		throw new Error(`${operation} entry has invalid status`);
	}
	return Object.freeze({
		rlmChildId: requireString(payload, "rlm_child_id", operation),
		activeSessionId: optionalString(payload, "active_session_id", operation),
		sessionId: optionalString(payload, "session_id", operation),
		sessionName: requireString(payload, "session_name", operation),
		sessionDir: requireString(payload, "session_dir", operation),
		status,
		activity: optionalActivity(payload, operation),
		toolUseCount: optionalInt(payload, "tool_use_count", operation),
		durationMs: optionalInt(payload, "duration_ms", operation),
		answerPreview: optionalString(payload, "answer_preview", operation),
		repliedSinceTask: optionalBool(payload, "replied_since_task", operation),
		progressNote: optionalString(payload, "progress_note", operation),
		label: optionalString(payload, "label", operation),
		lastActivityAt: optionalInt(payload, "last_activity_at", operation),
		activityStaleMs: optionalInt(payload, "activity_stale_ms", operation),
	});
}

function childResultFromPayload(payload: unknown): RlmChildResult {
	if (!isRecord(payload)) throw new Error("rlm.collect returned an invalid result entry");
	const status = payload.status;
	if (
		status !== "queued" &&
		status !== "running" &&
		status !== "done" &&
		status !== "error" &&
		status !== "cancelled"
	) {
		throw new Error("rlm.collect entry has invalid status");
	}
	if (typeof payload.settled !== "boolean") {
		throw new Error("rlm.collect entry has invalid settled flag");
	}
	return Object.freeze({
		rlmChildId: requireString(payload, "rlm_child_id", "rlm.collect"),
		sessionName: optionalString(payload, "session_name", "rlm.collect"),
		sessionDir: optionalString(payload, "session_dir", "rlm.collect"),
		status,
		settled: payload.settled,
		answerPreview: optionalString(payload, "answer_preview", "rlm.collect"),
		answerText: optionalString(payload, "answer_text", "rlm.collect"),
		error: optionalString(payload, "error", "rlm.collect"),
		durationMs: optionalInt(payload, "duration_ms", "rlm.collect"),
		toolUseCount: optionalInt(payload, "tool_use_count", "rlm.collect"),
		repliedSinceTask: optionalBool(payload, "replied_since_task", "rlm.collect"),
	});
}

export async function _spawnWithFactory(
	prompt: string,
	options: {
		name: string;
		model?: string;
		thinking?: string;
		cwd?: string;
		factory?: { runId: string; specId: string; stateId: string };
	},
): Promise<RlmSpawnHandle> {
	if (typeof prompt !== "string") throw new TypeError(`prompt must be a string, got ${typeof prompt}`);
	if (!isRecord(options) || typeof options.name !== "string" || !options.name) {
		throw new TypeError("rlm.spawn requires an options object with a non-empty name");
	}
	const kwargs: Record<string, unknown> = { name: options.name };
	if (options.model !== undefined && options.model !== null) kwargs.model = options.model;
	if (options.thinking !== undefined && options.thinking !== null) kwargs.thinking = options.thinking;
	if (options.cwd !== undefined && options.cwd !== null) kwargs.cwd = options.cwd;
	if (options.factory !== undefined) kwargs.factory = options.factory;
	const payload = await hostRequest("rlm.run", { prompt, kwargs });
	return spawnHandleFromPayload(payload);
}

export async function spawn(
	prompt: string,
	options: { name: string; model?: string; thinking?: string; cwd?: string },
): Promise<RlmSpawnHandle> {
	return _spawnWithFactory(prompt, options);
}

export async function createSession(
	prompt: string,
	options: { name?: string; model?: string; thinking?: string; cwd?: string } = {},
): Promise<RlmCreateSessionHandle> {
	if (typeof prompt !== "string") throw new TypeError(`prompt must be a string, got ${typeof prompt}`);
	const kwargs: Record<string, unknown> = {};
	if (options.name !== undefined && options.name !== null) kwargs.name = options.name;
	if (options.model !== undefined && options.model !== null) kwargs.model = options.model;
	if (options.thinking !== undefined && options.thinking !== null) kwargs.thinking = options.thinking;
	if (options.cwd !== undefined && options.cwd !== null) kwargs.cwd = options.cwd;
	const payload = await hostRequest("rlm.create_session", { prompt, kwargs });
	return createSessionHandleFromPayload(payload);
}

export async function findModels(query = "", limit = 8): Promise<RlmModel[]> {
	if (typeof query !== "string") throw new TypeError(`query must be a string, got ${typeof query}`);
	if (typeof limit !== "number" || !Number.isInteger(limit)) {
		throw new TypeError(`limit must be an integer, got ${typeof limit}`);
	}
	const payload = await hostRequest("rlm.find_models", { query, limit });
	const models = payload.models;
	if (!Array.isArray(models)) throw new Error("rlm.findModels returned an invalid models list");
	return models.map(modelFromPayload);
}

export async function listSubagents(): Promise<RlmSubagent[]> {
	const payload = await hostRequest("rlm.list_subagents");
	const entries = payload.subagents;
	if (!Array.isArray(entries)) throw new Error("rlm.listSubagents returned an invalid subagents registry");
	return entries.map((entry) => subagentFromPayload(entry));
}

export async function deleteSubagent(target: RlmChildTarget): Promise<RlmSubagent> {
	const selector = targetSelector(target, "target");
	const payload = await hostRequest("rlm.delete_subagent", { target: selector });
	return subagentFromPayload(payload.subagent, "rlm.deleteSubagent");
}

export async function rename(
	newName: string,
	options: { sessionId?: RlmChildTarget } = {},
): Promise<string> {
	if (typeof newName !== "string") throw new TypeError(`newName must be a string, got ${typeof newName}`);
	const payload: Record<string, unknown> = { name: newName };
	if (options.sessionId !== undefined && options.sessionId !== null) {
		payload.session_id = targetSelector(options.sessionId, "sessionId");
	}
	const reply = await hostRequest("rlm.rename", payload);
	return requireString(reply, "name", "rlm.rename");
}

export async function collect(
	targets?: RlmChildTarget | RlmChildTarget[] | null,
	options: { timeoutMs?: number; timeout_ms?: number } = {},
): Promise<RlmChildResult[]> {
	const timeoutMs = options.timeoutMs ?? options.timeout_ms ?? 0;
	if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 0) {
		throw new TypeError("timeoutMs must be a non-negative integer");
	}
	let selectors: string[];
	if (targets === undefined || targets === null) {
		selectors = [];
	} else if (Array.isArray(targets)) {
		selectors = targets.map((t) => targetSelector(t));
	} else {
		selectors = [targetSelector(targets)];
	}
	const payload = await hostRequest("rlm.collect", { targets: selectors, timeout_ms: timeoutMs });
	const results = payload.results;
	if (!Array.isArray(results)) throw new Error("rlm.collect returned an invalid results list");
	return results.map(childResultFromPayload);
}

export async function progressNote(message: string): Promise<RlmProgressNoteResult> {
	if (typeof message !== "string") throw new TypeError(`message must be a string, got ${typeof message}`);
	const stripped = message.trim();
	if (!stripped) throw new RangeError("message must not be empty");
	if (stripped.length > RLM_PROGRESS_NOTE_MAX_LENGTH) {
		throw new RangeError(`message must be at most ${RLM_PROGRESS_NOTE_MAX_LENGTH} characters`);
	}
	const payload = await hostRequest("rlm.progress.note", { message: stripped });
	if (typeof payload.accepted !== "boolean") {
		throw new Error("rlm.progress.note returned an invalid accepted flag");
	}
	const retryAfterMs = optionalInt(payload, "retry_after_ms", "rlm.progress.note");
	return Object.freeze({ accepted: payload.accepted, retryAfterMs });
}

export async function endTurn(): Promise<Record<string, unknown>> {
	return hostRequest("rlm.end_turn", {});
}

function messageText(message: Record<string, unknown>): string {
	const role = message.role;
	if (role === "compactionSummary" || role === "branchSummary") {
		return typeof message.summary === "string" ? message.summary : "";
	}
	if (role === "bashExecution") {
		return [message.command, message.output].filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
	}
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "text" && typeof b.text === "string")
			.map((b) => b.text as string)
			.join("\n");
	}
	return "";
}

function messageTimestamp(message: Record<string, unknown>): number | null {
	const value = message.timestamp;
	if (typeof value === "string") {
		const ms = Date.parse(value);
		return Number.isNaN(ms) ? null : Math.round(ms);
	}
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	return null;
}

function normalizeRoles(role: string | readonly string[] = "*"): string[] {
	return typeof role === "string" ? [role] : [...role];
}

async function readTranscript(
	start: number,
	limit: number,
	roles: string[],
	agent?: RlmChildTarget | null,
): Promise<Record<string, unknown>> {
	const request = { start, limit, roles };
	if (agent === undefined || agent === null) {
		return hostRequest("rlm.session.messages", request);
	}
	return hostRequest("agent_observe.session_messages", {
		...request,
		target: targetSelector(agent, "agent"),
	});
}

const sessionNamespace = Object.freeze({
	async messages(
		start = -10,
		limit = 10,
		options: { role?: string | readonly string[]; agent?: RlmChildTarget | null } = {},
	): Promise<RlmMessage[]> {
		if (!Number.isInteger(limit) || limit < 0) {
			throw new RangeError("limit must not be negative");
		}
		const roles = normalizeRoles(options.role ?? "*");
		const reply = await readTranscript(start, limit, roles, options.agent);
		const rawRows = Array.isArray(reply.messages) ? reply.messages : [];
		const messages: RlmMessage[] = rawRows.map((row) => {
			const rec = row as Record<string, unknown>;
			const msg = (isRecord(rec.message) ? rec.message : {}) as Record<string, unknown>;
			return Object.freeze({
				index: Number(rec.index),
				id: String(rec.id),
				role: String(msg.role ?? ""),
				text: messageText(msg),
				timestamp: messageTimestamp(msg),
				raw: msg,
			});
		});
		const first = messages.length > 0 ? messages[0]!.index : null;
		const readEvent: Record<string, unknown> = {
			returned: messages.length,
			first,
			total: reply.total,
			roles,
		};
		if (options.agent !== undefined && options.agent !== null) {
			readEvent.agent = reply.agent;
		}
		emit({ [TRANSCRIPT_READ_MIME]: readEvent });
		return messages;
	},

	async count(
		optionsOrRole?: string | readonly string[] | { role?: string | readonly string[]; agent?: RlmChildTarget | null },
		maybeOptions?: { agent?: RlmChildTarget | null },
	): Promise<number> {
		let role: string | readonly string[] = "*";
		let agent: RlmChildTarget | null | undefined;
		if (typeof optionsOrRole === "string" || Array.isArray(optionsOrRole)) {
			role = optionsOrRole;
			agent = maybeOptions?.agent;
		} else if (isRecord(optionsOrRole)) {
			role = (optionsOrRole.role as string | readonly string[] | undefined) ?? "*";
			agent = optionsOrRole.agent as RlmChildTarget | null | undefined;
		}
		const reply = await readTranscript(0, 0, normalizeRoles(role), agent);
		return Number(reply.total ?? 0);
	},
});

const factoryNamespace = Object.freeze({
	help(): string {
		return FACTORY_HELP;
	},
	async run(specId: string, options?: { name?: string }): Promise<Record<string, unknown>> {
		return runFactory(specId, options);
	},
	async status(runId: string): Promise<Record<string, unknown>> {
		return statusFactory(runId);
	},
	async stop(runId: string): Promise<Record<string, unknown>> {
		return stopFactory(runId);
	},
	async resume(runId: string): Promise<Record<string, unknown>> {
		return resumeFactory(runId);
	},
	async graph(ref?: string | null): Promise<Record<string, unknown>> {
		return graphFactory(ref ?? undefined);
	},
	async watch(runId: string, timeout = 0): Promise<Record<string, unknown>> {
		return watchFactory(runId, timeout);
	},
});

const rlmObject: Record<string, unknown> = {
	spawn,
	createSession,
	findModels,
	listSubagents,
	deleteSubagent,
	rename,
	collect,
	progressNote,
	endTurn,
	emit,
	hostRequest,
	session: sessionNamespace,
	harness: harnessProxy,
	getHarnessState,
	factory: factoryNamespace,
	persistentShells(): BashHandle[] {
		return persistentShells();
	},
};

Object.defineProperty(rlmObject, "run", {
	enumerable: false,
	configurable: false,
	get() {
		throw new Error(RENAMED_RUN_MESSAGE);
	},
});

export const rlm = Object.freeze(rlmObject);
