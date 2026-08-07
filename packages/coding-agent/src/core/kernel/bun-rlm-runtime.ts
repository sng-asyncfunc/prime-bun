export type BunHostRequest = (requestType: string, payload?: unknown) => Promise<unknown>;

export interface BunRlmSpawnHandle {
	rlmChildId: string;
	name: string;
	sessionDir: string;
	model: string;
}

export interface BunRlmModel {
	provider: string;
	id: string;
	name: string;
	selector: string;
}

export interface BunRlmSubagent {
	rlmChildId: string;
	activeSessionId: string | null;
	sessionId: string | null;
	sessionName: string;
	sessionDir: string;
	status: "running" | "completed" | "error";
}

export type BunHarnessKind = "prompt" | "memory" | "skill" | "subagent";
export type BunHarnessScope = "local" | "global";

export interface BunHarnessEntry {
	id: string;
	kind: BunHarnessKind;
	title: string;
	content: string;
	path: string;
	scope: BunHarnessScope;
	reference: Record<string, unknown>;
	arguments: Record<string, unknown>;
	metadata: Record<string, unknown>;
	source: string;
	createdAt: string;
	updatedAt: string;
	version: number;
}

export interface BunHarnessMutationOptions {
	id?: string;
	path?: string;
	reference?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	source?: string;
	global?: boolean;
}

export interface BunHarnessUpdateOptions extends Omit<BunHarnessMutationOptions, "id"> {}

export interface BunHarness {
	create(
		kind: BunHarnessKind,
		title: string,
		content: string,
		options?: BunHarnessMutationOptions,
	): Promise<BunHarnessEntry>;
	update(
		kind: BunHarnessKind,
		id: string,
		title: string,
		content: string,
		options?: BunHarnessUpdateOptions,
	): Promise<BunHarnessEntry>;
	upsert(
		kind: BunHarnessKind,
		title: string,
		content: string,
		options?: BunHarnessMutationOptions,
	): Promise<BunHarnessEntry>;
	get(kind: BunHarnessKind, id: string, options?: { global?: boolean }): Promise<BunHarnessEntry | null>;
	delete(kind: BunHarnessKind, id: string, options?: { global?: boolean }): Promise<boolean>;
	list(kind?: BunHarnessKind, options?: { global?: boolean }): Promise<BunHarnessEntry[]>;
	createMemory(title: string, content: string, options?: BunHarnessMutationOptions): Promise<BunHarnessEntry>;
	updateMemory(
		id: string,
		title: string,
		content: string,
		options?: BunHarnessUpdateOptions,
	): Promise<BunHarnessEntry>;
	deleteMemory(id: string, options?: { global?: boolean }): Promise<boolean>;
	createPromptNote(title: string, content: string, options?: BunHarnessMutationOptions): Promise<BunHarnessEntry>;
	updatePromptNote(
		id: string,
		title: string,
		content: string,
		options?: BunHarnessUpdateOptions,
	): Promise<BunHarnessEntry>;
	deletePromptNote(id: string, options?: { global?: boolean }): Promise<boolean>;
	createSkill(title: string, content: string, options: BunHarnessMutationOptions): Promise<BunHarnessEntry>;
	updateSkill(id: string, title: string, content: string, options?: BunHarnessUpdateOptions): Promise<BunHarnessEntry>;
	deleteSkill(id: string, options?: { global?: boolean }): Promise<boolean>;
	createSubagent(title: string, content: string, options?: BunHarnessMutationOptions): Promise<BunHarnessEntry>;
	updateSubagent(
		id: string,
		title: string,
		content: string,
		options?: BunHarnessUpdateOptions,
	): Promise<BunHarnessEntry>;
	deleteSubagent(id: string, options?: { global?: boolean }): Promise<boolean>;
	recordRefinement(
		trigger: string,
		changes: string | string[],
		options?: { evidence?: string; outcome?: string; id?: string; global?: boolean },
	): Promise<Record<string, unknown>>;
	overview(options?: { maxEntriesPerKind?: number; global?: boolean }): Promise<string>;
	snapshot(options?: { global?: boolean }): Promise<Record<string, unknown>>;
	planRefinement(observation: string, options?: { failingComponent?: string; nextStep?: string }): string[];
}

export interface BunRlmRuntime {
	(prompt: string, options?: Record<string, unknown>): Promise<BunRlmSpawnHandle>;
	run(prompt: string, options?: Record<string, unknown>): Promise<BunRlmSpawnHandle>;
	hostRequest: BunHostRequest;
	findModels(query?: string, limit?: number): Promise<BunRlmModel[]>;
	listSubagents(): Promise<BunRlmSubagent[]>;
	deleteSubagent(target: string | BunRlmSubagent): Promise<BunRlmSubagent>;
	harness: BunHarness;
	getHarnessState(options?: { global?: boolean }): Promise<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, operation: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${operation} returned an invalid object`);
	return value;
}

function requireString(record: Record<string, unknown>, key: string, operation: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value) throw new Error(`${operation} returned an invalid ${key}`);
	return value;
}

function optionalString(record: Record<string, unknown>, key: string, operation: string): string | null {
	const value = record[key];
	if (value === null) return null;
	if (typeof value !== "string") throw new Error(`${operation} returned an invalid ${key}`);
	return value;
}

function requireOptions(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new TypeError("rlm options must be an object");
	return value;
}

function spawnHandle(value: unknown): BunRlmSpawnHandle {
	const record = requireRecord(value, "rlm.run");
	return {
		model: requireString(record, "model", "rlm.run"),
		name: requireString(record, "name", "rlm.run"),
		rlmChildId: requireString(record, "rlm_child_id", "rlm.run"),
		sessionDir: requireString(record, "session_dir", "rlm.run"),
	};
}

function model(value: unknown): BunRlmModel {
	const record = requireRecord(value, "rlm.findModels");
	return {
		id: requireString(record, "id", "rlm.findModels"),
		name: requireString(record, "name", "rlm.findModels"),
		provider: requireString(record, "provider", "rlm.findModels"),
		selector: requireString(record, "selector", "rlm.findModels"),
	};
}

function subagent(value: unknown, operation: string): BunRlmSubagent {
	const record = requireRecord(value, operation);
	const status = record.status;
	if (status !== "running" && status !== "completed" && status !== "error") {
		throw new Error(`${operation} returned an invalid status`);
	}
	return {
		activeSessionId: optionalString(record, "active_session_id", operation),
		rlmChildId: requireString(record, "rlm_child_id", operation),
		sessionDir: requireString(record, "session_dir", operation),
		sessionId: optionalString(record, "session_id", operation),
		sessionName: requireString(record, "session_name", operation),
		status,
	};
}

function harnessEntry(value: unknown, operation: string): BunHarnessEntry {
	const record = requireRecord(value, operation);
	const kind = record.kind;
	const scope = record.scope;
	if (kind !== "prompt" && kind !== "memory" && kind !== "skill" && kind !== "subagent") {
		throw new Error(`${operation} returned an invalid kind`);
	}
	if (scope !== "local" && scope !== "global") throw new Error(`${operation} returned an invalid scope`);
	return {
		arguments: isRecord(record.arguments) ? record.arguments : {},
		content: requireString(record, "content", operation),
		createdAt: requireString(record, "created_at", operation),
		id: requireString(record, "id", operation),
		kind,
		metadata: isRecord(record.metadata) ? record.metadata : {},
		path: requireString(record, "path", operation),
		reference: isRecord(record.reference) ? record.reference : {},
		scope,
		source: requireString(record, "source", operation),
		title: requireString(record, "title", operation),
		updatedAt: requireString(record, "updated_at", operation),
		version: typeof record.version === "number" ? record.version : 1,
	};
}

function createHarness(hostRequest: BunHostRequest): BunHarness {
	const mutate = async (
		operation: "create" | "update" | "upsert",
		kind: BunHarnessKind,
		title: string,
		content: string,
		options: BunHarnessMutationOptions,
	): Promise<BunHarnessEntry> => {
		const response = requireRecord(
			await hostRequest(`harness.${operation}`, { kind, title, content, ...options }),
			`harness.${operation}`,
		);
		return harnessEntry(response.entry, `harness.${operation}`);
	};
	const remove = async (kind: BunHarnessKind, id: string, options: { global?: boolean } = {}): Promise<boolean> => {
		const response = requireRecord(await hostRequest("harness.delete", { kind, id, ...options }), "harness.delete");
		if (typeof response.deleted !== "boolean") throw new Error("harness.delete returned an invalid result");
		return response.deleted;
	};
	const harness: BunHarness = {
		create: (kind, title, content, options = {}) => mutate("create", kind, title, content, options),
		update: (kind, id, title, content, options = {}) => mutate("update", kind, title, content, { ...options, id }),
		upsert: (kind, title, content, options = {}) => mutate("upsert", kind, title, content, options),
		get: async (kind, id, options = {}) => {
			const response = requireRecord(await hostRequest("harness.get", { kind, id, ...options }), "harness.get");
			return response.entry === null ? null : harnessEntry(response.entry, "harness.get");
		},
		delete: remove,
		list: async (kind, options = {}) => {
			const response = requireRecord(await hostRequest("harness.list", { kind, ...options }), "harness.list");
			if (!Array.isArray(response.entries)) throw new Error("harness.list returned an invalid entries list");
			return response.entries.map((entry) => harnessEntry(entry, "harness.list"));
		},
		createMemory: (title, content, options = {}) => mutate("create", "memory", title, content, options),
		updateMemory: (id, title, content, options = {}) =>
			mutate("update", "memory", title, content, { ...options, id }),
		deleteMemory: (id, options = {}) => remove("memory", id, options),
		createPromptNote: (title, content, options = {}) => mutate("create", "prompt", title, content, options),
		updatePromptNote: (id, title, content, options = {}) =>
			mutate("update", "prompt", title, content, { ...options, id }),
		deletePromptNote: (id, options = {}) => remove("prompt", id, options),
		createSkill: (title, content, options) => mutate("create", "skill", title, content, options),
		updateSkill: (id, title, content, options = {}) => mutate("update", "skill", title, content, { ...options, id }),
		deleteSkill: (id, options = {}) => remove("skill", id, options),
		createSubagent: (title, content, options = {}) => mutate("create", "subagent", title, content, options),
		updateSubagent: (id, title, content, options = {}) =>
			mutate("update", "subagent", title, content, { ...options, id }),
		deleteSubagent: (id, options = {}) => remove("subagent", id, options),
		recordRefinement: async (trigger, changes, options = {}) => {
			const response = requireRecord(
				await hostRequest("harness.record_refinement", { trigger, changes, ...options }),
				"harness.recordRefinement",
			);
			return requireRecord(response.event, "harness.recordRefinement");
		},
		overview: async (options = {}) => {
			const response = requireRecord(await hostRequest("harness.overview", options), "harness.overview");
			return requireString(response, "overview", "harness.overview");
		},
		snapshot: async (options = {}) => {
			const response = requireRecord(await hostRequest("harness.snapshot", options), "harness.snapshot");
			return requireRecord(response.state, "harness.snapshot");
		},
		planRefinement: (observation, options = {}) => {
			const target = options.failingComponent ? ` for ${options.failingComponent}` : "";
			const plan = [
				`Diagnose the repeated failure or opportunity${target}: ${observation}`,
				"Update the smallest useful prompt note, memory item, skill, or subagent spec.",
				"Run the next action with the changed harness state, then record the outcome.",
			];
			if (options.nextStep) plan.push(`Immediate validation step: ${options.nextStep}`);
			return plan;
		},
	};
	return harness;
}

export function createBunRlmRuntime(hostRequest: BunHostRequest): BunRlmRuntime {
	const run = async (prompt: string, options: Record<string, unknown> = {}): Promise<BunRlmSpawnHandle> => {
		if (typeof prompt !== "string") throw new TypeError("rlm prompt must be a string");
		const kwargs = requireOptions(options);
		return spawnHandle(await hostRequest("rlm.run", { prompt, kwargs }));
	};
	const findModels = async (query = "", limit = 8): Promise<BunRlmModel[]> => {
		if (typeof query !== "string") throw new TypeError("rlm.findModels query must be a string");
		if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
			throw new RangeError("rlm.findModels limit must be an integer from 1 to 20");
		}
		const response = requireRecord(await hostRequest("rlm.find_models", { query, limit }), "rlm.findModels");
		if (!Array.isArray(response.models)) throw new Error("rlm.findModels returned an invalid models list");
		return response.models.map(model);
	};
	const listSubagents = async (): Promise<BunRlmSubagent[]> => {
		const response = requireRecord(await hostRequest("rlm.list_subagents"), "rlm.listSubagents");
		if (!Array.isArray(response.subagents)) {
			throw new Error("rlm.listSubagents returned an invalid subagents registry");
		}
		return response.subagents.map((entry) => subagent(entry, "rlm.listSubagents"));
	};
	const deleteSubagent = async (target: string | BunRlmSubagent): Promise<BunRlmSubagent> => {
		const selector = typeof target === "string" ? target.trim() : target.rlmChildId;
		if (!selector) throw new TypeError("rlm.deleteSubagent target must not be empty");
		const response = requireRecord(
			await hostRequest("rlm.delete_subagent", { target: selector }),
			"rlm.deleteSubagent",
		);
		return subagent(response.subagent, "rlm.deleteSubagent");
	};
	const harness = createHarness(hostRequest);
	const callable = async (prompt: string, options: Record<string, unknown> = {}) => run(prompt, options);
	return Object.assign(callable, {
		deleteSubagent,
		findModels,
		getHarnessState: (options: { global?: boolean } = {}) => harness.snapshot(options),
		harness,
		hostRequest,
		listSubagents,
		run,
	});
}
