import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { requireFactoryEnabled, validateFactorySpec } from "./factory.ts";

export type HarnessKind = "prompt" | "memory" | "skill" | "subagent" | "factory";
export type HarnessScope = "local" | "global";

const DEFAULT_FILE_NAME = "harness_state.json";
const DEFAULT_HARNESS_DIR_NAME = "harness";
const KINDS: readonly HarnessKind[] = ["prompt", "memory", "skill", "subagent", "factory"];
const LOCK_STALE_AFTER_MS = 10_000;
const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_INTERVAL_MS = 20;
const PROCESS_TOKEN = randomUUID().replace(/-/g, "");

const stateCache = new Map<string, HarnessState>();

export interface HarnessEntry {
	id: string;
	kind: HarnessKind;
	title: string;
	content: string;
	path: string;
	scope: HarnessScope;
	reference: Record<string, unknown>;
	arguments: Record<string, unknown>;
	metadata: Record<string, unknown>;
	source: string;
	createdAt: string;
	updatedAt: string;
	/** Snake-case aliases kept in sync on disk and readable for compatibility. */
	created_at: string;
	updated_at: string;
	version: number;
}

export interface RefinementEvent {
	id: string;
	trigger: string;
	changes: string[];
	evidence: string;
	outcome: string;
	createdAt: string;
	created_at: string;
}

export interface HarnessMutationOptions {
	id?: string;
	path?: string;
	reference?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	source?: string;
	global?: boolean;
	global_?: boolean;
}

export interface HarnessUpdateOptions extends Omit<HarnessMutationOptions, "id"> {}

export interface HarnessFactoryOptions {
	id?: string;
	path?: string;
	dag?: Record<string, unknown>;
	machine?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	global?: boolean;
	global_?: boolean;
}

function nowIso(): string {
	return new Date().toISOString();
}

function slug(raw: string, fallback: string): string {
	const chars: string[] = [];
	for (const ch of raw.trim()) {
		if (/[\p{L}\p{N}]/u.test(ch)) {
			chars.push(ch.toLowerCase());
		} else {
			chars.push("_");
		}
	}
	const normalized = chars
		.join("")
		.split("_")
		.filter((part) => part.length > 0)
		.join("_");
	return (normalized || fallback).slice(0, 80);
}

const CJK_TERM_CHAR_RE =
	/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{2ebf0}-\u{2ee5f}\u{2f800}-\u{2fa1f}\u{30000}-\u{3134f}\u{31350}-\u{323af}\u{323b0}-\u{3347f}]/u;

const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}]/u;

function isAscii(text: string): boolean {
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) > 127) return false;
	}
	return true;
}

function harnessQueryRuns(text: string): string[] {
	const runs: string[] = [];
	let run: string[] = [];
	let runIsCjk = false;
	for (const ch of text) {
		if (WORD_CHAR_RE.test(ch)) {
			const chIsCjk = CJK_TERM_CHAR_RE.test(ch);
			if (run.length > 0 && chIsCjk !== runIsCjk) {
				runs.push(run.join(""));
				run = [];
			}
			runIsCjk = chIsCjk;
			run.push(ch);
		} else if (run.length > 0) {
			runs.push(run.join(""));
			run = [];
		}
	}
	if (run.length > 0) runs.push(run.join(""));
	return runs;
}

export function harnessQueryTerms(query: string): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const run of harnessQueryRuns(query.toLowerCase())) {
		let candidates: string[];
		if (CJK_TERM_CHAR_RE.test(run)) {
			const chars = [...run];
			if (chars.length > 1) {
				candidates = [];
				for (let i = 0; i < chars.length - 1; i += 1) {
					candidates.push(`${chars[i]}${chars[i + 1]}`);
				}
			} else {
				candidates = [run];
			}
		} else if (isAscii(run)) {
			candidates = run.length >= 3 ? [run] : [];
		} else {
			candidates = [...run].length >= 2 ? [run] : [];
		}
		for (const term of candidates) {
			if (!seen.has(term)) {
				seen.add(term);
				terms.push(term);
			}
		}
	}
	return terms;
}

export function agentDir(): string {
	const raw =
		(process.env.PRIME_AGENT_CODING_AGENT_DIR ?? "").trim() ||
		(process.env.PI_CODING_AGENT_DIR ?? "").trim() ||
		path.join(homedir(), ".prime", "agent");
	return path.resolve(raw.replace(/^~(?=\/|$)/, homedir()));
}

function requireRefinementsEnabled(): void {
	try {
		const raw = fs.readFileSync(path.join(agentDir(), "settings.json"), "utf8");
		const doc = JSON.parse(raw) as unknown;
		if (doc && typeof doc === "object" && !Array.isArray(doc)) {
			if ((doc as Record<string, unknown>).harnessRefinements === false) {
				throw new Error("Harness refinements are disabled in /settings");
			}
		}
	} catch (error) {
		if (error instanceof Error && error.message === "Harness refinements are disabled in /settings") {
			throw error;
		}
	}
}

function resolveGlobalFlag(opts?: { global?: boolean; global_?: boolean }): boolean {
	if (!opts) return false;
	if (opts.global !== undefined) {
		if (typeof opts.global !== "boolean") {
			throw new TypeError(`global must be a boolean, got ${typeof opts.global}`);
		}
		return opts.global;
	}
	if (opts.global_ !== undefined) {
		if (typeof opts.global_ !== "boolean") {
			throw new TypeError(`global_ must be a boolean, got ${typeof opts.global_}`);
		}
		return opts.global_;
	}
	return false;
}

function stripScopePrefix(id: string | undefined, isGlobal: boolean): { id: string | undefined; isGlobal: boolean } {
	if (typeof id === "string") {
		const colon = id.indexOf(":");
		if (colon > 0) {
			const scope = id.slice(0, colon);
			const rest = id.slice(colon + 1);
			if (rest && (scope === "local" || scope === "global")) {
				return { id: rest, isGlobal: isGlobal || scope === "global" };
			}
		}
	}
	return { id, isGlobal };
}

function envDir(name: string): string | null {
	const value = (process.env[name] ?? "").trim();
	return value || null;
}

function stateFile(stateDir?: string | null, isGlobal = false): string {
	let root: string | null = stateDir ?? null;
	if (root === null) {
		root = isGlobal ? envDir("RLM_GLOBAL_HARNESS_STATE_DIR") : envDir("RLM_HARNESS_STATE_DIR");
	}
	if (root === null && !isGlobal) {
		const sessionDir = envDir("RLM_SESSION_DIR");
		if (sessionDir) root = path.join(sessionDir, DEFAULT_HARNESS_DIR_NAME);
	}
	if (root === null && !isGlobal) {
		throw new Error(
			"Local harness state requires RLM_HARNESS_STATE_DIR or RLM_SESSION_DIR. " +
				"Use getHarnessState({ global: true }) for global state.",
		);
	}
	if (root) {
		return path.join(path.resolve(root.replace(/^~(?=\/|$)/, homedir())), DEFAULT_FILE_NAME);
	}
	return path.join(agentDir(), DEFAULT_HARNESS_DIR_NAME, DEFAULT_FILE_NAME);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
	if (Array.isArray(value)) return "an array";
	if (value === "") return "an empty string";
	if (value === null) return "null";
	return typeof value;
}

function describeEntry(id: unknown, title: unknown): string {
	if (typeof id === "string" && id) return id;
	if (typeof title === "string" && title) return title;
	return "<unnamed>";
}

function requireText(kind: string, entryName: string, field: string, value: unknown): void {
	if (typeof value !== "string" || !value) {
		throw new Error(
			`${kind} entry ${JSON.stringify(entryName)} rejected: ${field} must be a non-empty string, got ${typeName(value)}`,
		);
	}
}

function requireOptionalText(kind: string, entryName: string, field: string, value: unknown): void {
	if (value !== undefined) {
		requireText(kind, entryName, field, value);
	}
}

function requireOptionalRecord(kind: string, entryName: string, field: string, value: unknown): void {
	if (value !== undefined && !isPlainRecord(value)) {
		throw new Error(
			`${kind} entry ${JSON.stringify(entryName)} rejected: ${field} must be an object when provided, got ${typeName(value)}`,
		);
	}
}

function validateJavaScriptSkillReference(
	reference: Record<string, unknown> | undefined,
	entryName = "",
): Record<string, unknown> {
	const prefix = entryName ? `skill entry ${JSON.stringify(entryName)} rejected: ` : "";
	const reject = (message: string): never => {
		throw new Error(`${prefix}${message}`);
	};
	if (!isPlainRecord(reference)) {
		reject("skill entries require a JavaScript reference");
	}
	const normalized = { ...reference! };
	if (normalized.type !== "javascript") {
		reject("skill reference.type must be 'javascript'");
	}
	const hasImport =
		(typeof normalized.import === "string" && normalized.import.length > 0) ||
		(typeof normalized.javascript_import === "string" && normalized.javascript_import.length > 0);
	if (!hasImport) {
		reject("skill reference requires a JavaScript import");
	}
	const hasCallable =
		(typeof normalized.callable === "string" && normalized.callable.length > 0) ||
		(typeof normalized.call_pattern === "string" && normalized.call_pattern.length > 0);
	if (!hasCallable) {
		reject("skill reference requires a callable or call_pattern");
	}
	return normalized;
}

function factorySpecArgument(
	dag: Record<string, unknown> | undefined,
	machine: Record<string, unknown> | undefined,
): { spec: unknown; key: "dag" | "machine" } {
	if (dag !== undefined && machine !== undefined) {
		throw new Error("pass either dag or machine, not both");
	}
	if (machine !== undefined) return { spec: machine, key: "machine" };
	return { spec: dag, key: "dag" };
}

function validateFactoryArguments(entryName: string, args: Record<string, unknown>): void {
	const dag = args.dag;
	const machine = args.machine;
	if (dag !== undefined && dag !== null && machine !== undefined && machine !== null) {
		throw new Error(`factory entry ${JSON.stringify(entryName)} rejected: pass either dag or machine, not both`);
	}
	const spec = machine !== undefined && machine !== null ? machine : dag;
	if (!isPlainRecord(spec)) {
		throw new Error(
			`factory entry ${JSON.stringify(entryName)} rejected: factory entries require a dag or machine object in arguments`,
		);
	}
	const errors = validateFactorySpec(spec);
	if (errors.length > 0) {
		throw new Error(`factory entry ${JSON.stringify(entryName)} rejected: ${errors.join("; ")}`);
	}
}

function validateEntryShape(
	kind: HarnessKind,
	entryId: unknown,
	title: unknown,
	content: unknown,
	opts: {
		path: unknown;
		reference: unknown;
		arguments: unknown;
		metadata: unknown;
		source: unknown;
		existing: HarnessEntry | undefined;
	},
): void {
	const entryName = describeEntry(entryId, title);
	requireText(kind, entryName, "id", entryId);
	requireText(kind, entryName, "title", title);
	requireText(kind, entryName, "content", content);
	requireOptionalText(kind, entryName, "path", opts.path);
	requireOptionalRecord(kind, entryName, "reference", opts.reference);
	requireOptionalRecord(kind, entryName, "arguments", opts.arguments);
	requireOptionalRecord(kind, entryName, "metadata", opts.metadata);
	requireText(kind, entryName, "source", opts.source);
	if (kind === "skill") {
		if (opts.reference === undefined) {
			if (!opts.existing) {
				throw new Error(
					`skill entry ${JSON.stringify(entryName)} rejected: skill entries require a JavaScript reference`,
				);
			}
		} else {
			validateJavaScriptSkillReference(opts.reference as Record<string, unknown>, entryName);
		}
	}
	if (kind === "factory") {
		requireFactoryEnabled();
		if (opts.arguments === undefined && !opts.existing) {
			throw new Error(
				`factory entry ${JSON.stringify(entryName)} rejected: factory entries require a dag or machine object in arguments`,
			);
		}
		if (opts.arguments !== undefined) {
			validateFactoryArguments(entryName, opts.arguments as Record<string, unknown>);
		}
	}
}

function validateRefinementEvent(trigger: unknown, changes: unknown, evidence: unknown, outcome: unknown): void {
	if (typeof trigger !== "string" || !trigger) {
		throw new Error(`refinement event rejected: trigger must be a non-empty string, got ${typeName(trigger)}`);
	}
	if (typeof changes === "string") {
		if (!changes) {
			throw new Error("refinement event rejected: changes must be a non-empty string or a list of strings");
		}
	} else if (Array.isArray(changes)) {
		if (!changes.every((c) => typeof c === "string" && c.length > 0)) {
			throw new Error("refinement event rejected: changes must be a list of non-empty strings");
		}
	} else {
		throw new Error(`refinement event rejected: changes must be a string or a list of strings, got ${typeName(changes)}`);
	}
	if (typeof evidence !== "string") {
		throw new Error(`refinement event rejected: evidence must be a string when provided, got ${typeName(evidence)}`);
	}
	if (typeof outcome !== "string") {
		throw new Error(`refinement event rejected: outcome must be a string when provided, got ${typeName(outcome)}`);
	}
}

function sleepSync(ms: number): void {
	const arr = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(arr, 0, 0, ms);
}

function makeEntry(data: Omit<HarnessEntry, "createdAt" | "updatedAt" | "created_at" | "updated_at"> & {
	created_at: string;
	updated_at: string;
}): HarnessEntry {
	return {
		...data,
		createdAt: data.created_at,
		updatedAt: data.updated_at,
	};
}

function serializeEntry(entry: HarnessEntry): Record<string, unknown> {
	return {
		id: entry.id,
		kind: entry.kind,
		title: entry.title,
		content: entry.content,
		path: entry.path,
		scope: entry.scope,
		reference: entry.reference,
		arguments: entry.arguments,
		metadata: entry.metadata,
		source: entry.source,
		created_at: entry.created_at,
		updated_at: entry.updated_at,
		version: entry.version,
	};
}

function serializeRefinement(event: RefinementEvent): Record<string, unknown> {
	return {
		id: event.id,
		trigger: event.trigger,
		changes: event.changes,
		evidence: event.evidence,
		outcome: event.outcome,
		created_at: event.created_at,
	};
}

export class HarnessState {
	readonly filePath: string | null;
	readonly scope: HarnessScope;
	entries: Record<HarnessKind, Record<string, HarnessEntry>>;
	refinements: RefinementEvent[];
	_globalTargetStateDir: string | null = null;

	private readonly _localWriteError: string | null;
	private _loadedMtimeNs: bigint | null = null;
	private _heldLock: { lockPath: string; owner: string } | null = null;

	constructor(
		filePath?: string | null,
		opts?: { inMemory?: boolean; scope?: HarnessScope; localWriteError?: string | null },
	) {
		const scope = opts?.scope ?? "local";
		if (opts?.inMemory) {
			this.filePath = null;
		} else {
			this.filePath = filePath
				? path.resolve(filePath.replace(/^~(?=\/|$)/, homedir()))
				: stateFile(null, scope === "global");
		}
		this.scope = scope;
		this._localWriteError = opts?.localWriteError ?? null;
		this.entries = { prompt: {}, memory: {}, skill: {}, subagent: {}, factory: {} };
		this.refinements = [];
		if (!opts?.inMemory) {
			this.load();
		}
	}

	private _ensureLocalWritable(): void {
		requireRefinementsEnabled();
		if (this._localWriteError !== null) {
			throw new Error(this._localWriteError);
		}
	}

	private _diskMtimeNs(): bigint | null {
		if (!this.filePath) return null;
		try {
			return fs.statSync(this.filePath, { bigint: true }).mtimeNs;
		} catch {
			return null;
		}
	}

	private _syncFromDisk(): void {
		requireRefinementsEnabled();
		if (this._diskMtimeNs() !== this._loadedMtimeNs) {
			this.load();
		}
	}

	private static _ownerDead(recorded: string): boolean {
		const parts = recorded.trim().split(" ");
		if (parts.length !== 2 || !parts[1]) return true;
		const pid = Number.parseInt(parts[0]!, 10);
		if (!Number.isInteger(pid) || pid <= 0) return true;
		try {
			process.kill(pid, 0);
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException)?.code === "ESRCH";
		}
	}

	private static _ownerMatches(lockPath: string, owner: string): boolean {
		try {
			return fs.readFileSync(path.join(lockPath, "owner"), "utf8").trim() === owner;
		} catch {
			return false;
		}
	}

	private _acquireLockDir(lockPath: string): string {
		const owner = `${process.pid} ${PROCESS_TOKEN}.${randomUUID().replace(/-/g, "")}`;
		const ownerPath = path.join(lockPath, "owner");
		for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
			try {
				fs.mkdirSync(lockPath, { mode: 0o700 });
				try {
					fs.writeFileSync(ownerPath, `${owner}\n`, { encoding: "utf8", mode: 0o600 });
				} catch (err) {
					try {
						fs.rmdirSync(lockPath);
					} catch {
						// ignore
					}
					throw err;
				}
				return owner;
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
				let stale = false;
				try {
					stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_AFTER_MS;
				} catch {
					continue;
				}
				if (stale) {
					let recorded: string | null = null;
					try {
						recorded = fs.readFileSync(ownerPath, "utf8");
					} catch {
						recorded = null;
					}
					if (recorded === null || HarnessState._ownerDead(recorded)) {
						try {
							fs.unlinkSync(ownerPath);
						} catch {
							// ignore
						}
						try {
							fs.rmdirSync(lockPath);
						} catch {
							// ignore
						}
						continue;
					}
				}
				sleepSync(LOCK_RETRY_INTERVAL_MS);
			}
		}
		throw new Error(`harness state lock not acquired: ${lockPath}`);
	}

	private _withLock<T>(fn: () => T): T {
		if (this.filePath) {
			const parentDir = path.dirname(this.filePath);
			fs.mkdirSync(parentDir, { recursive: true });
			const resolvedTarget = fs.existsSync(this.filePath)
				? fs.realpathSync(this.filePath)
				: path.join(fs.realpathSync(parentDir), path.basename(this.filePath));
			const lockPath = `${resolvedTarget}.lock`;
			this._heldLock = { lockPath, owner: this._acquireLockDir(lockPath) };
		}
		try {
			this._syncFromDisk();
			return fn();
		} finally {
			if (this._heldLock) {
				const { lockPath, owner } = this._heldLock;
				if (HarnessState._ownerMatches(lockPath, owner)) {
					try {
						fs.unlinkSync(path.join(lockPath, "owner"));
					} catch {
						// ignore
					}
					try {
						fs.rmdirSync(lockPath);
					} catch {
						// ignore
					}
				}
				this._heldLock = null;
			}
		}
	}

	load(): this {
		requireRefinementsEnabled();
		if (!this.filePath || !fs.existsSync(this.filePath)) {
			this._loadedMtimeNs = null;
			return this;
		}
		const mtime = this._diskMtimeNs();
		let data: unknown = {};
		try {
			data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
		} catch {
			data = {};
		}
		if (!isPlainRecord(data)) data = {};

		const entries: Record<HarnessKind, Record<string, HarnessEntry>> = {
			prompt: {},
			memory: {},
			skill: {},
			subagent: {},
			factory: {},
		};
		const rawEntries = data.entries;
		if (isPlainRecord(rawEntries)) {
			for (const kind of KINDS) {
				const rawKind = rawEntries[kind];
				if (!isPlainRecord(rawKind)) continue;
				for (const [entryId, rawEntry] of Object.entries(rawKind)) {
					if (!isPlainRecord(rawEntry)) continue;
					if (typeof rawEntry.title !== "string" || typeof rawEntry.content !== "string") continue;
					const createdAt =
						typeof rawEntry.created_at === "string"
							? rawEntry.created_at
							: typeof rawEntry.createdAt === "string"
								? rawEntry.createdAt
								: nowIso();
					const updatedAt =
						typeof rawEntry.updated_at === "string"
							? rawEntry.updated_at
							: typeof rawEntry.updatedAt === "string"
								? rawEntry.updatedAt
								: nowIso();
					let version = rawEntry.version;
					if (typeof version === "string") {
						const parsed = Number.parseInt(version, 10);
						version = Number.isInteger(parsed) ? parsed : 1;
					}
					if (typeof version !== "number" || !Number.isInteger(version)) version = 1;
					entries[kind][entryId] = makeEntry({
						id: entryId,
						kind,
						title: rawEntry.title,
						content: rawEntry.content,
						path: typeof rawEntry.path === "string" ? rawEntry.path : "general",
						scope: rawEntry.scope === "local" || rawEntry.scope === "global" ? rawEntry.scope : this.scope,
						reference: isPlainRecord(rawEntry.reference) ? rawEntry.reference : {},
						arguments: isPlainRecord(rawEntry.arguments) ? rawEntry.arguments : {},
						metadata: isPlainRecord(rawEntry.metadata) ? rawEntry.metadata : {},
						source: typeof rawEntry.source === "string" ? rawEntry.source : "agent",
						created_at: createdAt,
						updated_at: updatedAt,
						version,
					});
				}
			}
		}
		this.entries = entries;

		const refinements: RefinementEvent[] = [];
		const rawRefinements = data.refinements;
		if (Array.isArray(rawRefinements)) {
			for (const rawEvent of rawRefinements) {
				if (!isPlainRecord(rawEvent)) continue;
				if (typeof rawEvent.id !== "string" || typeof rawEvent.trigger !== "string") continue;
				let changes: string[];
				if (typeof rawEvent.changes === "string") {
					changes = [rawEvent.changes];
				} else if (Array.isArray(rawEvent.changes)) {
					changes = rawEvent.changes.map((c) => String(c));
				} else {
					continue;
				}
				const createdAt =
					typeof rawEvent.created_at === "string"
						? rawEvent.created_at
						: typeof rawEvent.createdAt === "string"
							? rawEvent.createdAt
							: nowIso();
				refinements.push({
					id: rawEvent.id,
					trigger: rawEvent.trigger,
					changes,
					evidence: typeof rawEvent.evidence === "string" ? rawEvent.evidence : "",
					outcome: typeof rawEvent.outcome === "string" ? rawEvent.outcome : "",
					created_at: createdAt,
					createdAt,
				});
			}
		}
		this.refinements = refinements;
		this._loadedMtimeNs = mtime;
		return this;
	}

	private _globalTarget(isGlobal: boolean): HarnessState | null {
		if (!isGlobal) return null;
		const target = getHarnessState({ stateDir: this._globalTargetStateDir ?? undefined, global: true });
		if (this.filePath !== null && target.filePath === this.filePath && target.scope === this.scope) {
			return null;
		}
		return target;
	}

	save(): this {
		requireRefinementsEnabled();
		if (!this.filePath) return this;
		if (!this._heldLock) {
			throw new Error("harness state lock not acquired");
		}
		const parentDir = path.dirname(this.filePath);
		fs.mkdirSync(parentDir, { recursive: true });
		const targetPath = fs.existsSync(this.filePath)
			? fs.realpathSync(this.filePath)
			: path.join(fs.realpathSync(parentDir), path.basename(this.filePath));
		const tempPath = `${targetPath}.${process.pid}.${randomUUID().replace(/-/g, "")}.tmp`;

		let existingMode: number | null = null;
		try {
			existingMode = fs.statSync(targetPath).mode & 0o777;
		} catch {
			existingMode = null;
		}
		const mode = existingMode ?? 0o600;

		const data = {
			schema: 1,
			entries: Object.fromEntries(
				KINDS.map((kind) => [
					kind,
					Object.fromEntries(
						Object.entries(this.entries[kind]).map(([id, entry]) => [id, serializeEntry(entry)]),
					),
				]),
			),
			refinements: this.refinements.map(serializeRefinement),
		};

		try {
			const fd = fs.openSync(
				tempPath,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
				mode,
			);
			try {
				fs.writeSync(fd, JSON.stringify(data, null, 2));
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			if (existingMode !== null) {
				fs.chmodSync(tempPath, existingMode);
			}
			if (!HarnessState._ownerMatches(this._heldLock.lockPath, this._heldLock.owner)) {
				throw new Error(`harness state lock lost: ${this._heldLock.lockPath}`);
			}
			fs.renameSync(tempPath, targetPath);
		} finally {
			try {
				fs.unlinkSync(tempPath);
			} catch {
				// ignore
			}
		}
		this._loadedMtimeNs = this._diskMtimeNs();
		return this;
	}

	private _upsertLocked(
		kind: HarnessKind,
		title: string,
		content: string,
		opts: {
			id?: string;
			path?: string;
			reference?: Record<string, unknown>;
			arguments?: Record<string, unknown>;
			metadata?: Record<string, unknown>;
			source?: string;
		},
	): HarnessEntry {
		if (!KINDS.includes(kind)) {
			throw new Error(`unknown harness kind ${JSON.stringify(kind)}; expected one of ${KINDS.join(", ")}`);
		}
		const source = opts.source ?? "agent";
		requireText(kind, describeEntry(opts.id, title), "title", title);
		if (opts.id !== undefined) {
			requireText(kind, describeEntry(opts.id, title), "id", opts.id);
		}
		const entryId = opts.id || slug(title, kind);
		const existing = this.entries[kind][entryId];
		validateEntryShape(kind, entryId, title, content, {
			path: opts.path,
			reference: opts.reference,
			arguments: opts.arguments,
			metadata: opts.metadata,
			source,
			existing,
		});

		let entry: HarnessEntry;
		if (existing) {
			existing.title = title;
			existing.content = content;
			if (opts.path !== undefined) existing.path = opts.path;
			if (opts.reference !== undefined) existing.reference = { ...opts.reference };
			if (opts.arguments !== undefined) {
				existing.arguments =
					kind === "factory" ? structuredClone(opts.arguments) : { ...opts.arguments };
			}
			if (opts.metadata !== undefined) existing.metadata = { ...opts.metadata };
			existing.source = source;
			const now = nowIso();
			existing.updated_at = now;
			existing.updatedAt = now;
			existing.version += 1;
			entry = existing;
		} else {
			const now = nowIso();
			entry = makeEntry({
				id: entryId,
				kind,
				title,
				content,
				path: opts.path ?? "general",
				scope: this.scope,
				reference: opts.reference ? { ...opts.reference } : {},
				arguments: opts.arguments
					? kind === "factory"
						? structuredClone(opts.arguments)
						: { ...opts.arguments }
					: {},
				metadata: opts.metadata ? { ...opts.metadata } : {},
				source,
				created_at: now,
				updated_at: now,
				version: 1,
			});
			this.entries[kind][entryId] = entry;
		}
		this.save();
		return entry;
	}

	upsert(kind: HarnessKind, title: string, content: string, options: HarnessMutationOptions = {}): HarnessEntry {
		const { id, isGlobal } = stripScopePrefix(options.id, resolveGlobalFlag(options));
		const target = this._globalTarget(isGlobal);
		if (target) {
			return target.upsert(kind, title, content, { ...options, id, global: false, global_: false });
		}
		this._ensureLocalWritable();
		return this._withLock(() =>
			this._upsertLocked(kind, title, content, {
				id,
				path: options.path ?? "general",
				reference: options.reference,
				arguments: options.arguments,
				metadata: options.metadata,
				source: options.source ?? "agent",
			}),
		);
	}

	create(kind: HarnessKind, title: string, content: string, options: HarnessMutationOptions = {}): HarnessEntry {
		const { id, isGlobal } = stripScopePrefix(options.id, resolveGlobalFlag(options));
		const target = this._globalTarget(isGlobal);
		if (target) {
			return target.create(kind, title, content, { ...options, id, global: false, global_: false });
		}
		this._ensureLocalWritable();
		return this._withLock(() => {
			if (!KINDS.includes(kind)) {
				throw new Error(`unknown harness kind ${JSON.stringify(kind)}; expected one of ${KINDS.join(", ")}`);
			}
			requireText(kind, describeEntry(id, title), "title", title);
			if (id !== undefined) {
				requireText(kind, describeEntry(id, title), "id", id);
			}
			const entryId = id || slug(title, kind);
			if (entryId in this.entries[kind]) {
				throw new Error(`${kind} entry ${JSON.stringify(entryId)} already exists`);
			}
			return this._upsertLocked(kind, title, content, {
				id: entryId,
				path: options.path ?? "general",
				reference: options.reference,
				arguments: options.arguments,
				metadata: options.metadata,
				source: options.source ?? "agent",
			});
		});
	}

	update(
		kind: HarnessKind,
		rawId: string,
		title: string,
		content: string,
		options: HarnessUpdateOptions = {},
	): HarnessEntry {
		const { id, isGlobal } = stripScopePrefix(rawId, resolveGlobalFlag(options));
		const target = this._globalTarget(isGlobal);
		if (target) {
			return target.update(kind, id!, title, content, { ...options, global: false, global_: false });
		}
		this._ensureLocalWritable();
		return this._withLock(() => {
			if (!KINDS.includes(kind)) {
				throw new Error(`unknown harness kind ${JSON.stringify(kind)}; expected one of ${KINDS.join(", ")}`);
			}
			requireText(kind, describeEntry(id, title), "id", id);
			if (!(id! in this.entries[kind])) {
				throw new Error(`${kind} entry ${JSON.stringify(id)} does not exist`);
			}
			return this._upsertLocked(kind, title, content, {
				id: id!,
				path: options.path,
				reference: options.reference,
				arguments: options.arguments,
				metadata: options.metadata,
				source: options.source ?? "agent",
			});
		});
	}

	get(kind: HarnessKind, rawId: string, options?: { global?: boolean; global_?: boolean }): HarnessEntry | null {
		const { id, isGlobal } = stripScopePrefix(rawId, resolveGlobalFlag(options));
		const target = this._globalTarget(isGlobal);
		if (target) return target.get(kind, id!);
		this._syncFromDisk();
		if (!KINDS.includes(kind)) {
			throw new Error(`unknown harness kind ${JSON.stringify(kind)}; expected one of ${KINDS.join(", ")}`);
		}
		return (id !== undefined ? this.entries[kind][id] : undefined) ?? null;
	}

	delete(kind: HarnessKind, rawId: string, options?: { global?: boolean; global_?: boolean }): boolean {
		const { id, isGlobal } = stripScopePrefix(rawId, resolveGlobalFlag(options));
		const target = this._globalTarget(isGlobal);
		if (target) return target.delete(kind, id!);
		this._ensureLocalWritable();
		return this._withLock(() => {
			if (!KINDS.includes(kind)) {
				throw new Error(`unknown harness kind ${JSON.stringify(kind)}; expected one of ${KINDS.join(", ")}`);
			}
			if (id === undefined || !(id in this.entries[kind])) return false;
			delete this.entries[kind][id];
			this.save();
			return true;
		});
	}

	list(kind?: HarnessKind | null, options?: { global?: boolean; global_?: boolean }): HarnessEntry[] {
		const target = this._globalTarget(resolveGlobalFlag(options));
		if (target) return target.list(kind);
		this._syncFromDisk();
		const kinds = kind ? [kind] : KINDS;
		const records: HarnessEntry[] = [];
		for (const currentKind of kinds) {
			if (!KINDS.includes(currentKind)) {
				throw new Error(
					`unknown harness kind ${JSON.stringify(currentKind)}; expected one of ${KINDS.join(", ")}`,
				);
			}
			records.push(...Object.values(this.entries[currentKind]));
		}
		return records.sort(
			(a, b) =>
				a.kind.localeCompare(b.kind) ||
				a.path.localeCompare(b.path) ||
				a.title.localeCompare(b.title) ||
				a.id.localeCompare(b.id),
		);
	}

	// Convenience CRUD methods
	createMemory(title: string, content: string, options: HarnessMutationOptions = {}): HarnessEntry {
		return this.create("memory", title, content, options);
	}
	updateMemory(id: string, title: string, content: string, options: HarnessUpdateOptions = {}): HarnessEntry {
		return this.update("memory", id, title, content, options);
	}
	deleteMemory(id: string, options?: { global?: boolean; global_?: boolean }): boolean {
		return this.delete("memory", id, options);
	}

	createPromptNote(title: string, content: string, options: HarnessMutationOptions = {}): HarnessEntry {
		return this.create("prompt", title, content, { path: "policy", ...options });
	}
	updatePromptNote(id: string, title: string, content: string, options: HarnessUpdateOptions = {}): HarnessEntry {
		return this.update("prompt", id, title, content, options);
	}
	deletePromptNote(id: string, options?: { global?: boolean; global_?: boolean }): boolean {
		return this.delete("prompt", id, options);
	}

	createSkill(title: string, content: string, options: HarnessMutationOptions = {}): HarnessEntry {
		const validated = validateJavaScriptSkillReference(options.reference, describeEntry(options.id, title));
		return this.create("skill", title, content, { ...options, reference: validated });
	}
	updateSkill(id: string, title: string, content: string, options: HarnessUpdateOptions = {}): HarnessEntry {
		const validated =
			options.reference !== undefined
				? validateJavaScriptSkillReference(options.reference, describeEntry(id, title))
				: undefined;
		return this.update("skill", id, title, content, { ...options, reference: validated });
	}
	deleteSkill(id: string, options?: { global?: boolean; global_?: boolean }): boolean {
		return this.delete("skill", id, options);
	}

	createSubagent(title: string, content: string, options: HarnessMutationOptions = {}): HarnessEntry {
		return this.create("subagent", title, content, options);
	}
	updateSubagent(id: string, title: string, content: string, options: HarnessUpdateOptions = {}): HarnessEntry {
		return this.update("subagent", id, title, content, options);
	}
	deleteSubagent(id: string, options?: { global?: boolean; global_?: boolean }): boolean {
		return this.delete("subagent", id, options);
	}

	createFactory(title: string, content: string, options: HarnessFactoryOptions = {}): HarnessEntry {
		requireFactoryEnabled();
		const { spec, key } = factorySpecArgument(options.dag, options.machine);
		const errors = validateFactorySpec(spec);
		if (errors.length > 0) {
			throw new Error(errors.join("; "));
		}
		return this.create("factory", title, content, {
			id: options.id,
			path: options.path ?? "general",
			arguments: { [key]: structuredClone(spec) },
			metadata: options.metadata,
			global: options.global,
			global_: options.global_,
		});
	}

	updateFactory(id: string, title: string, content: string, options: HarnessFactoryOptions = {}): HarnessEntry {
		requireFactoryEnabled();
		let args: Record<string, unknown> | undefined;
		if (options.dag !== undefined || options.machine !== undefined) {
			const { spec, key } = factorySpecArgument(options.dag, options.machine);
			const errors = validateFactorySpec(spec);
			if (errors.length > 0) {
				throw new Error(errors.join("; "));
			}
			args = { [key]: structuredClone(spec) };
		}
		return this.update("factory", id, title, content, {
			path: options.path,
			arguments: args,
			metadata: options.metadata,
			global: options.global,
			global_: options.global_,
		});
	}

	deleteFactory(id: string, options?: { global?: boolean; global_?: boolean }): boolean {
		return this.delete("factory", id, options);
	}

	recordRefinement(
		trigger: string,
		changes: string | string[],
		options: { evidence?: string; outcome?: string; id?: string; global?: boolean; global_?: boolean } = {},
	): RefinementEvent {
		const target = this._globalTarget(resolveGlobalFlag(options));
		if (target) {
			return target.recordRefinement(trigger, changes, {
				evidence: options.evidence,
				outcome: options.outcome,
				id: options.id,
			});
		}
		this._ensureLocalWritable();
		return this._withLock(() => {
			const evidence = options.evidence ?? "";
			const outcome = options.outcome ?? "";
			validateRefinementEvent(trigger, changes, evidence, outcome);
			if (options.id !== undefined && (typeof options.id !== "string" || !options.id)) {
				throw new Error(
					`refinement event rejected: id must be a non-empty string when provided, got ${typeName(options.id)}`,
				);
			}
			const eventId = options.id || `refine_${String(this.refinements.length + 1).padStart(4, "0")}`;
			const normalizedChanges = typeof changes === "string" ? [changes] : [...changes];
			const now = nowIso();
			const event: RefinementEvent = {
				id: eventId,
				trigger,
				changes: normalizedChanges,
				evidence,
				outcome,
				created_at: now,
				createdAt: now,
			};
			this.refinements.push(event);
			this.save();
			return event;
		});
	}

	planRefinement(
		observation: string,
		options: { failingComponent?: string; nextStep?: string } = {},
	): string[] {
		const target = options.failingComponent ? ` for ${options.failingComponent}` : "";
		const plan = [
			`Diagnose the repeated failure or opportunity${target}: ${observation}`,
			"Update the smallest useful prompt note, memory item, skill, or subagent spec.",
			"Run the next action with the changed harness state, then record the outcome.",
		];
		if (options.nextStep) {
			plan.push(`Immediate validation step: ${options.nextStep}`);
		}
		return plan;
	}

	overview(options: { maxEntriesPerKind?: number; global?: boolean; global_?: boolean } = {}): string {
		const target = this._globalTarget(resolveGlobalFlag(options));
		if (target) return target.overview({ maxEntriesPerKind: options.maxEntriesPerKind });
		this._syncFromDisk();
		const maxEntriesPerKind = options.maxEntriesPerKind ?? 20;
		const lines: string[] = [
			`Harness state (${this.scope}): ${this.filePath}`,
			"Call contract: installed JavaScript skills use await <skillGlobal>(...) in the Bun REPL; " +
				"harness skill entries are JavaScript REPL skills and must include a JavaScript reference plus arguments. " +
				"Spawn a subagent spec by composing a concise task prompt and calling " +
				"const handle = await rlm.spawn('sub-task', { name: 'worker' }); admission returns immediately with rlmChildId, name, sessionDir, " +
				"and model, never the child's answer. Results arrive only through explicit agentMessage replies or " +
				"files; children reply with await agentMessage.send(message, { receiverRole: 'parent' }). Use " +
				"await rlm.listSubagents() to recover direct child handles and await agentMessage.send(..., " +
				"{ receiverRole: 'child', receiverName: handle.name }) for follow-ups.",
			"Factory entries declare validated state-machine workflows of subagent states in arguments.machine " +
				"(the original DAG sugar in arguments.dag compiles to machine form): manage them with " +
				"createFactory/updateFactory/deleteFactory (createFactory validates either form at write time); run " +
				'them with await rlm.factory.run("<id>"), watch with await rlm.factory.status(runId), stop with ' +
				"await rlm.factory.stop(runId), and resume an escalate-paused run with " +
				"await rlm.factory.resume(runId).",
		];

		for (const kind of KINDS) {
			const allKind = this.list(kind);
			const records = allKind.slice(0, maxEntriesPerKind);
			lines.push(`${kind}: ${allKind.length}`);
			for (const entry of records) {
				let summary = entry.content.trim().replace(/\n/g, " ");
				if (summary.length > 120) summary = `${summary.slice(0, 117)}...`;
				let argumentSummary = "";
				if (entry.kind === "skill" && Object.keys(entry.arguments).length > 0) {
					let argText = JSON.stringify(entry.arguments);
					if (argText.length > 120) argText = `${argText.slice(0, 117)}...`;
					argumentSummary = ` args=${argText}`;
				}
				let referenceSummary = "";
				if (entry.kind === "skill" && Object.keys(entry.reference).length > 0) {
					let refText = JSON.stringify(entry.reference);
					if (refText.length > 120) refText = `${refText.slice(0, 117)}...`;
					referenceSummary = ` ref=${refText}`;
				}
				lines.push(
					`  - [${entry.scope}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${referenceSummary}${argumentSummary}: ${summary}`,
				);
			}
			const overflow = allKind.length - records.length;
			if (overflow > 0) lines.push(`  - +${overflow} more`);
		}
		if (this.refinements.length > 0) {
			lines.push(`refinements: ${this.refinements.length}`);
			for (const event of this.refinements.slice(-5)) {
				lines.push(`  - [${event.id}] ${event.trigger}: ${event.changes.join(", ")}`);
			}
		} else {
			lines.push("refinements: 0");
		}
		return lines.join("\n");
	}

	search(
		query: string,
		optionsOrKind?: HarnessKind | { kind?: HarnessKind; limit?: number; global?: boolean; global_?: boolean } | null,
		limitArg?: number,
	): HarnessEntry[] {
		const opts =
			optionsOrKind && typeof optionsOrKind === "object"
				? optionsOrKind
				: { kind: optionsOrKind ?? undefined, limit: limitArg };
		const target = this._globalTarget(resolveGlobalFlag(opts));
		if (target) return target.search(query, { kind: opts.kind, limit: opts.limit });
		this._syncFromDisk();
		if (typeof query !== "string") {
			throw new TypeError(`query must be a string, got ${typeof query}`);
		}
		const limit = opts.limit ?? 10;
		if (!Number.isInteger(limit) || limit < 1) {
			throw new TypeError("limit must be a positive integer");
		}
		const terms = harnessQueryTerms(query);
		if (terms.length === 0) return [];

		const entries = this.list(opts.kind ?? null);
		const df = new Map<string, number>();
		for (const term of terms) df.set(term, 0);
		for (const entry of entries) {
			const title = entry.title.toLowerCase();
			const content = entry.content.toLowerCase();
			const pathAndId = `${entry.path} ${entry.id}`.toLowerCase();
			for (const term of terms) {
				if (title.includes(term) || content.includes(term) || pathAndId.includes(term)) {
					df.set(term, (df.get(term) ?? 0) + 1);
				}
			}
		}

		const termIdf = new Map<string, number>();
		for (const [term, count] of df) {
			if (count > 0) {
				termIdf.set(term, Math.log(1 + entries.length / count));
			}
		}

		const scored = entries
			.map((entry) => {
				const title = entry.title.toLowerCase();
				const content = entry.content.toLowerCase();
				const pathAndId = `${entry.path} ${entry.id}`.toLowerCase();
				let total = 0;
				for (const [term, idf] of termIdf) {
					const fields =
						(title.includes(term) ? 1 : 0) +
						(content.includes(term) ? 1 : 0) +
						(pathAndId.includes(term) ? 1 : 0);
					if (fields > 0) {
						total += idf * (1 + (fields - 1) * 0.5);
					}
				}
				return { entry, score: total, recency: entry.updated_at || "" };
			})
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score || b.recency.localeCompare(a.recency));

		return scored.slice(0, limit).map((item) => item.entry);
	}

	snapshot(options?: { global?: boolean; global_?: boolean }): Record<string, unknown> {
		const target = this._globalTarget(resolveGlobalFlag(options));
		if (target) return target.snapshot();
		this._syncFromDisk();
		return {
			file_path: String(this.filePath),
			filePath: String(this.filePath),
			scope: this.scope,
			entries: Object.fromEntries(
				KINDS.map((kind) => [
					kind,
					Object.fromEntries(
						Object.entries(this.entries[kind]).map(([id, entry]) => [id, serializeEntry(entry)]),
					),
				]),
			),
			refinements: this.refinements.map(serializeRefinement),
		};
	}

	// Snake-case aliases for ergonomic compatibility
	create_memory = this.createMemory.bind(this);
	update_memory = this.updateMemory.bind(this);
	delete_memory = this.deleteMemory.bind(this);
	create_prompt_note = this.createPromptNote.bind(this);
	update_prompt_note = this.updatePromptNote.bind(this);
	delete_prompt_note = this.deletePromptNote.bind(this);
	create_skill = this.createSkill.bind(this);
	update_skill = this.updateSkill.bind(this);
	delete_skill = this.deleteSkill.bind(this);
	create_subagent = this.createSubagent.bind(this);
	update_subagent = this.updateSubagent.bind(this);
	delete_subagent = this.deleteSubagent.bind(this);
	create_factory = this.createFactory.bind(this);
	update_factory = this.updateFactory.bind(this);
	delete_factory = this.deleteFactory.bind(this);
	record_refinement = this.recordRefinement.bind(this);
	plan_refinement = this.planRefinement.bind(this);
}

export function getHarnessState(
	options?: { stateDir?: string; global?: boolean; global_?: boolean } | string,
): HarnessState {
	requireRefinementsEnabled();
	const opts = typeof options === "string" ? { stateDir: options } : (options ?? {});
	const isGlobal = resolveGlobalFlag(opts);
	const filePath = stateFile(opts.stateDir ?? null, isGlobal);
	const scope: HarnessScope = isGlobal ? "global" : "local";
	const cacheKey = `${scope}:${filePath}`;
	let state = stateCache.get(cacheKey);
	if (!state) {
		state = new HarnessState(filePath, { scope });
		if (opts.stateDir !== undefined) {
			let envFile: string | null = null;
			try {
				envFile = stateFile(null, isGlobal);
			} catch {
				envFile = null;
			}
			if (filePath !== envFile) {
				state._globalTargetStateDir = path.resolve(opts.stateDir.replace(/^~(?=\/|$)/, homedir()));
			}
		}
		stateCache.set(cacheKey, state);
	}
	return state;
}

export function clearHarnessStateCache(): void {
	stateCache.clear();
}

let proxyFallback: HarnessState | null = null;
let proxyUnpersisted: HarnessState | null = null;

function resolveProxyTarget(): HarnessState {
	try {
		return getHarnessState();
	} catch (error) {
		if (error instanceof Error && error.message.includes("Local harness state requires")) {
			if (!proxyUnpersisted) {
				proxyUnpersisted = new HarnessState(null, {
					inMemory: true,
					localWriteError:
						`${error.message} This session has no persistent local harness store; ` +
						"pass { global: true } to persist across sessions.",
				});
			}
			return proxyUnpersisted;
		}
		if (!proxyFallback) {
			proxyFallback = new HarnessState(null, { inMemory: true });
		}
		return proxyFallback;
	}
}

export const harnessProxy: HarnessState = new Proxy({} as HarnessState, {
	get(_target, prop) {
		if (prop === "then") return undefined;
		const resolved = resolveProxyTarget();
		const value = Reflect.get(resolved, prop, resolved);
		return typeof value === "function" ? value.bind(resolved) : value;
	},
	ownKeys() {
		return Reflect.ownKeys(resolveProxyTarget());
	},
	getOwnPropertyDescriptor(_target, prop) {
		return Reflect.getOwnPropertyDescriptor(resolveProxyTarget(), prop);
	},
});
