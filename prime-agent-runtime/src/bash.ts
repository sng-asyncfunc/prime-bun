import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import {
	activeCellId,
	currentCellExecution,
	emit,
	hostRequestRaw,
	isActive,
	sendHostRequestFireAndForget,
	writeCellStderr,
} from "./bridge.ts";

const IS_POSIX = process.platform !== "win32";
const HEAD_CAP = 512 * 1024;
const TAIL_CAP = 3 * 512 * 1024;
const COMPLETION_PREFIX = Buffer.from("\x1eprime-agent-complete:", "ascii");
const COMPLETION_SUFFIX = Buffer.from("\x1f", "ascii");
const CANCEL_TERM_GRACE_MS = 500;
const CANCEL_KILL_WAIT_MS = 2000;
const COMPLETION_NOTICE_COMMAND_CAP = 1000;
const BASH_COMMAND_MIME = "application/vnd.prime-agent.bash-command+json";
const BASH_ACTIVITY_MIME = "application/vnd.prime-agent.bash-activity+json";
const ACTIVITY_HISTORY_CAP = 64;
const ACTIVITY_FRAME_CAP = 16_384;
const PERSISTENT_DIR = "persistent-shells";
const PERSISTENT_POLL_MS = 1000;
const MAX_DEGRADE_HINTS = 3;

const PERSISTENT_WRAPPER =
	"read -r _prime_agent_gate || exit 127\n" +
	"exec 0</dev/null\n" +
	'"$1" -c "$2"\n' +
	"__prime_status=$?\n" +
	'printf \'%s\\n\' "$__prime_status" > "$3.tmp" && mv -f "$3.tmp" "$3"\n';

let completionNoticesWired = false;
let yieldAfterSeconds = 1.0;
let degradeHintsWritten = 0;

export function setCompletionNoticesWired(wired: boolean): void {
	completionNoticesWired = Boolean(wired);
}

export function isCompletionNoticesWired(): boolean {
	return completionNoticesWired;
}

/** Test helper to adjust the degrade window in unit tests. */
export function _setYieldAfterSecondsForTest(seconds: number): void {
	yieldAfterSeconds = seconds;
}

/** Test helper to reset degrade hint counter. */
export function _resetDegradeHintsForTest(): void {
	degradeHintsWritten = 0;
}

export class InterruptError extends Error {
	constructor(message = "Execution interrupted") {
		super(message);
		this.name = "InterruptError";
	}
}

export interface BashResult {
	readonly exitCode: number;
	readonly output: string;
	readonly duration: number;
	readonly running: false;
}

export interface BashSnapshot {
	readonly output: string;
	readonly exitCode: null;
	readonly running: true;
	readonly duration: number;
	readonly handle: BashHandle;
}

export interface BashOptions {
	persistent?: boolean;
}

export interface ShellResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ShellPromise extends Promise<ShellResult> {
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
}

const liveHandles = new Set<BashHandle>();
const activityHandles = new Map<string, BashHandle>();
const activityOrder: string[] = [];
let shutdownHookInstalled = false;

function resolveAgentDir(): string {
	const raw =
		(process.env.PRIME_AGENT_CODING_AGENT_DIR ?? "").trim() ||
		(process.env.PI_CODING_AGENT_DIR ?? "").trim() ||
		path.join(homedir(), ".prime", "agent");
	return path.resolve(raw.replace(/^~(?=\/|$)/, homedir()));
}

function capped(command: string): string {
	if (command.length > COMPLETION_NOTICE_COMMAND_CAP) {
		return `${command.slice(0, COMPLETION_NOTICE_COMMAND_CAP)}\n... [command truncated]`;
	}
	return command;
}

function noteDegrade(handle: BashHandle, boundSeconds: number): void {
	if (degradeHintsWritten >= MAX_DEGRADE_HINTS) return;
	degradeHintsWritten += 1;
	writeCellStderr(
		`bash: still running after ${boundSeconds}s (pid ${handle._pid}); ` +
			"returned a snapshot: r.running is true, r.output is the output so " +
			"far, r.handle is the live handle. End the turn — a [bash-done] " +
			"notification arrives when it finishes.\n",
	);
}

function resolveShell(): string {
	const override = process.env.PRIME_AGENT_BASH_SHELL;
	if (override) {
		if (!path.isAbsolute(override)) {
			throw new Error("PRIME_AGENT_BASH_SHELL must be an absolute path");
		}
		return override;
	}
	if (!IS_POSIX) {
		throw new Error(
			"bash() needs PRIME_AGENT_BASH_SHELL set to the absolute path of a " +
				"POSIX shell on Windows (e.g. install Git Bash in its default " +
				"location so the host injects it)",
		);
	}
	return Bun.which("bash") || "/bin/sh";
}

function withPrefix(command: string): string {
	const prefix = process.env.PRIME_AGENT_BASH_COMMAND_PREFIX;
	return prefix ? `${prefix}\n${command}` : command;
}

function fencePrintf(): string {
	for (const candidate of ["/usr/bin/printf", "/bin/printf"]) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return `'${candidate}'`;
		} catch {
			// continue
		}
	}
	return "\\command -p printf";
}

function statusScript(command: string, completionA: string, completionB: string): string {
	const emitCmd = fencePrintf();
	return (
		"read -r _prime_agent_gate || exit 127\n" +
		"exec 0</dev/null\n" +
		"{\n" +
		`${command}\n` +
		"} 3>&- 2>&1\n" +
		"__prime_status=$?\n" +
		"\\set +x\n" +
		`${emitCmd} '\\036prime-agent-complete:%s%s\\037' '${completionA}' '${completionB}' || exit "$__prime_status"\n` +
		`${emitCmd} '%s\\n' "$__prime_status" >&3\n` +
		"exec 3>&-\n" +
		"wait\n" +
		'exit "$__prime_status"\n'
	);
}

export function childEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) env[k] = v;
	}
	return {
		...env,
		NO_COLOR: "1",
		TERM: "dumb",
		CLICOLOR: "0",
		FORCE_COLOR: "0",
		GIT_EDITOR: "true",
		GIT_SEQUENCE_EDITOR: "true",
		GIT_TERMINAL_PROMPTS: "0",
		GIT_ASKPASS: "true",
		SSH_ASKPASS_REQUIRE: "never",
		EDITOR: "true",
		VISUAL: "true",
		PAGER: "cat",
		GIT_PAGER: "cat",
		DEBIAN_FRONTEND: "noninteractive",
	};
}

export function signalGroup(pid: number, sig: NodeJS.Signals | number): boolean {
	try {
		process.kill(-pid, sig);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ESRCH") return true;
		return false;
	}
}

function groupAlive(pid: number): boolean {
	if (!IS_POSIX) {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ESRCH") return false;
		return true;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ESRCH") return false;
	}
	try {
		if (process.platform === "linux") {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
			return state !== "Z";
		}
		if (process.platform === "darwin") {
			const out = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
				encoding: "utf8",
				timeout: 5000,
				env: { ...process.env, LC_ALL: "C", LANG: "C" },
			});
			return !out.trimStart().startsWith("Z");
		}
	} catch {
		// unknown state stays alive
	}
	return true;
}

export function processStartId(pid: number): string | null {
	if (process.platform === "win32") {
		return null;
	}
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (fields.length > 19 && fields[19]) {
			return `proc:${fields[19]}`;
		}
	} catch {
		// fall back to ps
	}
	try {
		const ps = process.platform === "darwin" ? "/bin/ps" : "ps";
		const out = execFileSync(ps, ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf8",
			timeout: 5000,
			env: { ...process.env, LC_ALL: "C", LC_TIME: "C", LANG: "C", TZ: "UTC" },
		}).trim();
		return out ? `ps:${out}` : null;
	} catch {
		return null;
	}
}

function shellIdentity(pid: number, startId: string): boolean | null {
	if (!pidAlive(pid)) return false;
	const current = processStartId(pid);
	return current === null ? null : current === startId;
}

function recordJournal(pid: number, active: boolean): boolean {
	const journalPath = process.env.PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL;
	const ownerRaw = process.env.PRIME_AGENT_KERNEL_OWNER_PID;
	if (!journalPath || !ownerRaw) return true;
	const ownerPid = Number.parseInt(ownerRaw, 10);
	if (!Number.isInteger(ownerPid) || String(ownerPid) !== ownerRaw.trim()) {
		return false;
	}
	const startId = active ? processStartId(pid) : null;
	const record: Record<string, unknown> = {
		version: 1,
		pid,
		ownerPid,
		kernelPid: process.pid,
		...(startId ? { processStartId: startId } : {}),
		active,
		recordedAt: new Date().toISOString(),
	};
	const line = `${JSON.stringify(record)}\n`;
	try {
		const fd = fs.openSync(journalPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
		try {
			fs.writeSync(fd, line);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// Best-effort journaling never kills a live command
	}
	return true;
}

class BoundedBuffer {
	private headChunks: Buffer[] = [];
	private headSize = 0;
	private tailChunks: Buffer[] = [];
	private tailSize = 0;
	private dropped = 0;

	write(chunk: Buffer): void {
		if (chunk.byteLength === 0) return;
		let remaining = chunk;
		if (this.headSize < HEAD_CAP) {
			const take = Math.min(HEAD_CAP - this.headSize, remaining.byteLength);
			this.headChunks.push(Buffer.from(remaining.subarray(0, take)));
			this.headSize += take;
			remaining = remaining.subarray(take);
		}
		if (remaining.byteLength === 0) return;
		this.tailChunks.push(Buffer.from(remaining));
		this.tailSize += remaining.byteLength;
		while (this.tailSize > TAIL_CAP && this.tailChunks.length > 0) {
			const excess = this.tailSize - TAIL_CAP;
			const oldest = this.tailChunks[0]!;
			if (oldest.byteLength <= excess) {
				this.tailChunks.shift();
				this.tailSize -= oldest.byteLength;
				this.dropped += oldest.byteLength;
			} else {
				this.tailChunks[0] = oldest.subarray(excess);
				this.tailSize -= excess;
				this.dropped += excess;
			}
		}
	}

	text(): string {
		const head = Buffer.concat(this.headChunks, this.headSize);
		const tail = Buffer.concat(this.tailChunks, this.tailSize);
		if (this.dropped === 0) {
			return Buffer.concat([head, tail], head.byteLength + tail.byteLength).toString("utf8");
		}
		return `${head.toString("utf8")}\n... [${this.dropped} bytes dropped] ...\n${tail.toString("utf8")}`;
	}
}

class OutputFileBuffer {
	private kept: string | null = null;
	constructor(private readonly filePath: string) {}

	keep(): void {
		this.kept = this.text();
	}

	text(): string {
		if (this.kept !== null) return this.kept;
		let fd: number;
		try {
			fd = fs.openSync(this.filePath, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
			throw error;
		}
		try {
			const size = fs.fstatSync(fd).size;
			if (size <= HEAD_CAP + TAIL_CAP) {
				const buf = Buffer.allocUnsafe(size);
				let offset = 0;
				while (offset < size) {
					const n = fs.readSync(fd, buf, offset, size - offset, offset);
					if (n <= 0) break;
					offset += n;
				}
				return buf.subarray(0, offset).toString("utf8");
			}
			const head = Buffer.allocUnsafe(HEAD_CAP);
			fs.readSync(fd, head, 0, HEAD_CAP, 0);
			const tail = Buffer.allocUnsafe(TAIL_CAP);
			fs.readSync(fd, tail, 0, TAIL_CAP, size - TAIL_CAP);
			const dropped = size - HEAD_CAP - TAIL_CAP;
			return `${head.toString("utf8")}\n... [${dropped} bytes dropped] ...\n${tail.toString("utf8")}`;
		} finally {
			fs.closeSync(fd);
		}
	}
}

function splitLines(text: string): string[] {
	if (!text) return [];
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

function recordActivityCompletion(activityId: string): void {
	activityOrder.push(activityId);
	while (activityOrder.length > ACTIVITY_HISTORY_CAP) {
		const evicted = activityOrder.shift();
		if (evicted) activityHandles.delete(evicted);
	}
}

export class BashHandle implements PromiseLike<BashResult | BashSnapshot> {
	readonly command: string;
	readonly _activityId: string;
	_pid: number;
	readonly _startedMs: number;
	readonly _startedAt: string;
	_released = false;
	_reaped = false;
	_result: BashResult | null = null;

	protected _buffer: BoundedBuffer | OutputFileBuffer;
	protected _done = false;
	protected _doneResolvers: Array<() => void> = [];
	protected _reapedResolvers: Array<() => void> = [];
	protected _creatingCellFinished: Promise<void> | null;
	protected _creatingCellId: string | null;
	protected _awaitedByCreatingCell = false;
	protected _resultConsumed = false;
	protected _consumedNotice: (() => void) | null = null;
	protected _proc: ChildProcess | null = null;

	private _completionMarker: Buffer | null = null;
	private _completionPending: Buffer = Buffer.alloc(0);
	private _completionTerminal = false;
	private _completionOutput: string | null = null;
	private _completionResolvers: Array<() => void> = [];
	private _foregroundStatus: number | null = null;
	private _statusKnown = false;
	private _statusKnownResolvers: Array<() => void> = [];
	private _forceKillTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(command: string, skipSpawn = false) {
		this.command = command;
		this._activityId = randomBytes(16).toString("hex");
		const ctx = currentCellExecution();
		this._creatingCellFinished = ctx?.finished ?? null;
		this._creatingCellId = ctx?.cellId ?? null;
		this._buffer = new BoundedBuffer();
		this._startedMs = performance.now();
		this._startedAt = new Date().toISOString();
		this._pid = 0;

		if (skipSpawn) return;

		const shell = resolveShell();
		let script: string;
		if (IS_POSIX) {
			const token = randomBytes(32).toString("hex");
			const mid = Math.floor(token.length / 2);
			this._completionMarker = Buffer.concat([COMPLETION_PREFIX, Buffer.from(token, "ascii"), COMPLETION_SUFFIX]);
			script = statusScript(withPrefix(command), token.slice(0, mid), token.slice(mid));
		} else {
			script = withPrefix(command);
		}

		const proc = spawn(shell, ["-c", script], {
			cwd: process.cwd(),
			env: childEnv(),
			detached: IS_POSIX,
			stdio: IS_POSIX ? ["pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
		});
		this._proc = proc;
		if (!proc.pid) {
			throw new Error(`bash(): failed to spawn shell '${shell}'`);
		}
		this._pid = proc.pid;

		liveHandles.add(this);
		activityHandles.set(this._activityId, this);

		const enrolled = recordJournal(this._pid, true);
		if (!enrolled) {
			this._abortSpawn();
			throw new Error(
				"bash(): orphan-journal enrollment failed (journal configured but the " +
					"pid could not be recorded); the spawned process was killed",
			);
		}

		// Attach output stream listeners
		const onOutputChunk = (chunk: Buffer) => {
			if (IS_POSIX && this._completionMarker) {
				this._consumeOutput(chunk);
			} else {
				(this._buffer as BoundedBuffer).write(chunk);
			}
		};
		proc.stdout?.on("data", onOutputChunk);
		proc.stderr?.on("data", onOutputChunk);
		proc.stdout?.on("end", () => this._abandonCompletion());

		if (IS_POSIX) {
			const statusStream = proc.stdio[3] as NodeJS.ReadableStream | null;
			let statusBuf = "";
			const finishStatus = () => {
				if (this._statusKnown) return;
				this._statusKnown = true;
				const parsed = Number.parseInt(statusBuf.trim(), 10);
				if (statusBuf.includes("\n") && Number.isInteger(parsed)) {
					this._foregroundStatus = parsed;
				}
				for (const r of this._statusKnownResolvers.splice(0)) r();
				if (this._foregroundStatus !== null) {
					void this._waitForCompletion().then((output) => {
						this._finalize(this._foregroundStatus!, output);
					});
				}
			};
			statusStream?.on("data", (chunk: Buffer) => {
				statusBuf += chunk.toString("utf8");
				if (statusBuf.includes("\n")) {
					finishStatus();
				}
			});
			statusStream?.on("end", finishStatus);
			statusStream?.on("error", finishStatus);

			// Open gate now that pid is journaled
			try {
				proc.stdin?.write("\n");
				proc.stdin?.end();
			} catch {
				// child already exited
			}
		} else {
			this._statusKnown = true;
		}

		proc.on("close", (code, sig) => {
			const exitCode = code !== null ? code : sig ? 128 : -1;
			void this._onProcessExit(exitCode);
		});
		proc.on("error", () => {
			void this._onProcessExit(-1);
		});

		this._scheduleBackgroundCompletionNotice();
	}

	get pid(): number {
		this._released = true;
		return this._pid;
	}

	get running(): boolean {
		this._released = true;
		return !this._reaped;
	}

	output(): string {
		this._released = true;
		this._noteResultConsumed();
		return this._buffer.text();
	}

	tail(n = 50): string {
		this._released = true;
		this._noteResultConsumed();
		const lines = splitLines(this._buffer.text());
		return lines.slice(-Math.max(0, n)).join("\n");
	}

	poll(): BashResult | null {
		this._released = true;
		this._noteResultConsumed();
		return this._done ? this._result : null;
	}

	kill(sig: NodeJS.Signals | number = "SIGTERM", grace = 5.0): void {
		this._released = true;
		if (this._reaped) return;
		if (!IS_POSIX) {
			try {
				this._proc?.kill(typeof sig === "string" ? sig : undefined);
			} catch {
				// ignore
			}
			return;
		}
		signalGroup(this._pid, sig);
		if (sig === "SIGTERM" || sig === 15) {
			if (this._forceKillTimer) clearTimeout(this._forceKillTimer);
			this._forceKillTimer = setTimeout(() => this._forceKill(), Math.max(0, grace * 1000));
			this._forceKillTimer.unref?.();
		}
	}

	protected _forceKill(): void {
		if (!this._reaped) {
			signalGroup(this._pid, "SIGKILL");
		}
	}

	private _abortSpawn(): void {
		if (IS_POSIX) {
			try {
				this._proc?.stdin?.destroy();
			} catch {
				// ignore
			}
			signalGroup(this._pid, "SIGKILL");
		} else {
			try {
				this._proc?.kill("SIGKILL");
			} catch {
				// ignore
			}
		}
		this._reaped = true;
		liveHandles.delete(this);
		activityHandles.delete(this._activityId);
		recordJournal(this._pid, false);
	}

	private _consumeOutput(chunk: Buffer): void {
		const marker = this._completionMarker!;
		if (this._completionTerminal) {
			(this._buffer as BoundedBuffer).write(chunk);
			return;
		}
		const data = this._completionPending.byteLength > 0 ? Buffer.concat([this._completionPending, chunk]) : chunk;
		const markerAt = data.indexOf(marker);
		if (markerAt >= 0) {
			(this._buffer as BoundedBuffer).write(data.subarray(0, markerAt));
			this._completionPending = Buffer.alloc(0);
			this._completionOutput = this._buffer.text();
			this._completionTerminal = true;
			for (const r of this._completionResolvers.splice(0)) r();
			const after = data.subarray(markerAt + marker.byteLength);
			if (after.byteLength > 0) {
				(this._buffer as BoundedBuffer).write(after);
			}
			return;
		}
		let retained = 0;
		const maxCheck = Math.min(data.byteLength, marker.byteLength - 1);
		for (let size = maxCheck; size > 0; size -= 1) {
			if (data.subarray(data.byteLength - size).equals(marker.subarray(0, size))) {
				retained = size;
				break;
			}
		}
		if (retained > 0) {
			(this._buffer as BoundedBuffer).write(data.subarray(0, data.byteLength - retained));
			this._completionPending = Buffer.from(data.subarray(data.byteLength - retained));
		} else {
			(this._buffer as BoundedBuffer).write(data);
			this._completionPending = Buffer.alloc(0);
		}
	}

	private _abandonCompletion(): void {
		if (this._completionTerminal) return;
		if (this._completionPending.byteLength > 0) {
			(this._buffer as BoundedBuffer).write(this._completionPending);
			this._completionPending = Buffer.alloc(0);
		}
		this._completionTerminal = true;
		for (const r of this._completionResolvers.splice(0)) r();
	}

	private _waitForCompletion(): Promise<string | null> {
		if (this._completionTerminal) return Promise.resolve(this._completionOutput);
		return new Promise((resolve) => {
			this._completionResolvers.push(() => resolve(this._completionOutput));
		});
	}

	private _waitStatusKnown(): Promise<void> {
		if (this._statusKnown) return Promise.resolve();
		return new Promise((resolve) => {
			this._statusKnownResolvers.push(resolve);
		});
	}

	private async _onProcessExit(exitCode: number): Promise<void> {
		await this._waitStatusKnown();
		if (this._foregroundStatus === null && !this._done) {
			this._abandonCompletion();
			this._finalize(exitCode);
		}
		let delivered = true;
		if (IS_POSIX) {
			if (groupAlive(this._pid)) {
				delivered = signalGroup(this._pid, "SIGKILL");
			}
		}
		if (this._forceKillTimer) {
			clearTimeout(this._forceKillTimer);
			this._forceKillTimer = null;
		}
		this._reaped = true;
		for (const r of this._reapedResolvers.splice(0)) r();
		if (delivered) {
			recordJournal(this._pid, false);
		}
		liveHandles.delete(this);
		recordActivityCompletion(this._activityId);
	}

	protected _finalize(exitCode: number, output?: string | null): void {
		if (this._done) return;
		const finalOutput = output !== undefined && output !== null ? output : this._buffer.text();
		this._result = Object.freeze({
			exitCode,
			output: finalOutput,
			duration: (performance.now() - this._startedMs) / 1000,
			running: false as const,
		});
		this._done = true;
		for (const r of this._doneResolvers.splice(0)) r();
	}

	protected _waitDone(): Promise<BashResult> {
		if (this._done && this._result) return Promise.resolve(this._result);
		return new Promise((resolve) => {
			this._doneResolvers.push(() => resolve(this._result!));
		});
	}

	protected _waitReaped(): Promise<void> {
		if (this._reaped) return Promise.resolve();
		return new Promise((resolve) => {
			this._reapedResolvers.push(resolve);
		});
	}

	protected _noteResultConsumed(): void {
		if (!this._done) return;
		if (activeCellId() === null) return;
		if (this._resultConsumed) return;
		this._resultConsumed = true;
		const notice = this._consumedNotice;
		this._consumedNotice = null;
		if (notice) notice();
	}

	protected _armConsumedNotice(command: string): void {
		const dispatch = () => {
			if (!isActive()) return;
			sendHostRequestFireAndForget({
				type: "bash.consumed",
				pid: this._pid,
				command,
			});
		};
		if (!this._resultConsumed) {
			this._consumedNotice = dispatch;
			return;
		}
		dispatch();
	}

	protected _scheduleBackgroundCompletionNotice(): void {
		const cellFinished = this._creatingCellFinished;
		if (!cellFinished || !isActive()) return;
		const activity = { id: this._activityId, pid: this._pid, active: true };
		emit({ [BASH_ACTIVITY_MIME]: activity });
		void this._notifyBackgroundCompletion(cellFinished, activity);
	}

	private async _notifyBackgroundCompletion(
		cellFinished: Promise<void>,
		activity: { id: string; pid: number; active: boolean },
	): Promise<void> {
		try {
			const result = await this._waitDone();
			await this._waitReaped();
			await cellFinished;
			if (this._awaitedByCreatingCell || this._resultConsumed || !isActive()) {
				return;
			}
			const command = capped(this.command);
			const reply = await hostRequestRaw({
				type: "bash.completed",
				pid: this._pid,
				command,
				exitCode: result.exitCode,
			});
			if (reply && reply.status === "ok") {
				this._armConsumedNotice(command);
			} else {
				writeCellStderr(
					`Background bash completion follow-up for pid ${this._pid} was not accepted. ` +
						"Inspect the saved handle with poll(), output(), or tail().\n",
				);
			}
		} catch {
			// Standalone or teardown
		} finally {
			if (isActive()) {
				emit({ [BASH_ACTIVITY_MIME]: { ...activity, active: false } });
			}
		}
	}

	protected _degradeSnapshot(): BashSnapshot {
		return Object.freeze({
			output: this._buffer.text(),
			exitCode: null,
			running: true as const,
			duration: (performance.now() - this._startedMs) / 1000,
			handle: this,
		});
	}

	private async _confirmGroupExit(): Promise<void> {
		const waitDeath = async (timeoutMs: number): Promise<boolean> => {
			const deadline = performance.now() + timeoutMs;
			while (groupAlive(this._pid)) {
				if (performance.now() >= deadline) return false;
				await new Promise((r) => setTimeout(r, 20));
			}
			return true;
		};
		if (!(await waitDeath(CANCEL_TERM_GRACE_MS))) {
			if (IS_POSIX) signalGroup(this._pid, "SIGKILL");
			else this.kill("SIGKILL");
			await waitDeath(CANCEL_KILL_WAIT_MS);
		}
	}

	protected async _awaitHandle(): Promise<BashResult | BashSnapshot> {
		const ctx = currentCellExecution();
		const isCreatingCell = ctx !== null && ctx.cellId === this._creatingCellId && ctx.isActive();
		const boundSeconds = completionNoticesWired ? yieldAfterSeconds : null;
		const owned = !this._released;
		this._released = true;

		const abortSignal = ctx?.abortSignal;
		if (abortSignal?.aborted) {
			if (owned) {
				this.kill("SIGTERM", CANCEL_TERM_GRACE_MS / 1000);
				await this._confirmGroupExit();
			}
			throw new InterruptError();
		}

		const resultPromise = this._waitDone();

		const outcome = await new Promise<
			{ kind: "done"; result: BashResult } | { kind: "degraded" } | { kind: "aborted" }
		>((resolve) => {
			let settled = false;
			let degradeTimer: ReturnType<typeof setTimeout> | null = null;

			const cleanup = () => {
				if (degradeTimer) {
					clearTimeout(degradeTimer);
					degradeTimer = null;
				}
				abortSignal?.removeEventListener("abort", onAbort);
			};

			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				if (owned) {
					if (isCreatingCell) this._awaitedByCreatingCell = true;
					this.kill("SIGTERM", CANCEL_TERM_GRACE_MS / 1000);
				}
				resolve({ kind: "aborted" });
			};

			if (abortSignal) {
				abortSignal.addEventListener("abort", onAbort, { once: true });
			}

			if (boundSeconds !== null) {
				degradeTimer = setTimeout(() => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve({ kind: "degraded" });
				}, Math.max(0, boundSeconds * 1000));
			}

			resultPromise.then((result) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve({ kind: "done", result });
			});
		});

		if (outcome.kind === "aborted") {
			if (owned) {
				if (isCreatingCell) this._awaitedByCreatingCell = true;
				this.kill("SIGTERM", CANCEL_TERM_GRACE_MS / 1000);
				await this._confirmGroupExit();
			}
			throw new InterruptError();
		}

		if (outcome.kind === "degraded") {
			noteDegrade(this, boundSeconds!);
			return this._degradeSnapshot();
		}

		if (isCreatingCell) {
			this._awaitedByCreatingCell = true;
		}
		this._noteResultConsumed();
		return outcome.result;
	}

	then<TResult1 = BashResult | BashSnapshot, TResult2 = never>(
		onfulfilled?: ((value: BashResult | BashSnapshot) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return this._awaitHandle().then(onfulfilled, onrejected);
	}

	_rawBufferText(): string {
		return this._buffer.text();
	}

	[Symbol.for("nodejs.util.inspect.custom")](): string {
		const state = this._result ? `exitCode=${this._result.exitCode}` : "running";
		return `<BashHandle pid=${this._pid} ${state} command=${JSON.stringify(this.command)}>`;
	}
}

function persistentHome(): string {
	return path.join(resolveAgentDir(), PERSISTENT_DIR);
}

function persistentFile(home: string, shellId: string, kind: "json" | "out" | "rc"): string {
	return path.join(home, `${shellId}.${kind}`);
}

function removeShellFiles(home: string, shellId: string): void {
	for (const kind of ["rc", "out", "json"] as const) {
		try {
			fs.unlinkSync(persistentFile(home, shellId, kind));
		} catch {
			// ignore
		}
	}
}

interface PersistentRecord {
	id: string;
	pid: number;
	startId: string;
	command: string;
	startedAt: string;
	sessionId: string;
}

function sessionRecords(home: string, sessionId: string): PersistentRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(home);
	} catch {
		return [];
	}
	const records: PersistentRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const record = JSON.parse(fs.readFileSync(path.join(home, name), "utf8")) as PersistentRecord;
			if (record && record.sessionId === sessionId) {
				records.push(record);
			}
		} catch {
			// ignore
		}
	}
	records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	return records;
}

function reapPersistentGroup(pid: number, startId: string, leaderExitWitnessed = false): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ESRCH") {
			if (leaderExitWitnessed) {
				return signalGroup(pid, "SIGKILL");
			}
			try {
				process.kill(-pid, 0);
				return false;
			} catch (groupErr) {
				return (groupErr as NodeJS.ErrnoException)?.code === "ESRCH";
			}
		}
	}
	const current = processStartId(pid);
	if (current === startId) {
		return signalGroup(pid, "SIGKILL");
	}
	return current !== null;
}

export class PersistentBashHandle extends BashHandle {
	private readonly _home: string;
	private readonly _rcPath: string;
	private readonly _startId: string;
	private _completionError: Error | null = null;
	private _persistentRunning: boolean;

	constructor(
		command: string,
		shellId: string,
		pid: number,
		startId: string,
		startedAt: string,
		home: string,
		proc: ChildProcess | null,
		running = true,
	) {
		super(command, true);
		(this as { _activityId: string })._activityId = shellId;
		this._pid = pid;
		this._startId = startId;
		(this as { _startedAt: string })._startedAt = startedAt;
		const elapsedSec = Math.max(0, (Date.now() - Date.parse(startedAt)) / 1000);
		(this as { _startedMs: number })._startedMs = performance.now() - elapsedSec * 1000;
		this._home = home;
		this._buffer = new OutputFileBuffer(persistentFile(home, shellId, "out"));
		this._rcPath = persistentFile(home, shellId, "rc");
		this._proc = proc;
		this._released = true;
		this._persistentRunning = running;

		activityHandles.set(shellId, this);
		void this._watchPersistent();
		this._schedulePersistentCompletionNotice();
	}

	override kill(sig: NodeJS.Signals | number = "SIGTERM", grace = 5.0): void {
		if (this._reaped || shellIdentity(this._pid, this._startId) !== true) return;
		super.kill(sig, grace);
	}

	protected override _forceKill(): void {
		if (!this._reaped) {
			reapPersistentGroup(this._pid, this._startId);
		}
	}

	private async _watchPersistent(): Promise<void> {
		let exitCode = -1;
		if (this._proc) {
			exitCode = await new Promise<number>((resolve) => {
				this._proc!.once("close", (code) => resolve(code ?? -1));
				this._proc!.once("error", () => resolve(-1));
			});
		} else if (this._persistentRunning) {
			while (!fs.existsSync(this._rcPath) && shellIdentity(this._pid, this._startId) !== false) {
				await new Promise((r) => setTimeout(r, PERSISTENT_POLL_MS));
			}
		}

		try {
			const rawRc = fs.readFileSync(this._rcPath, "utf8");
			const parsed = Number.parseInt(rawRc.trim(), 10);
			if (Number.isNaN(parsed)) {
				this._completionError = new Error(`invalid persistent shell exit code: ${rawRc}`);
			} else {
				exitCode = parsed;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				this._completionError = error instanceof Error ? error : new Error(String(error));
			}
		}

		const reaped = reapPersistentGroup(this._pid, this._startId, this._proc !== null || this._persistentRunning);
		this._reaped = true;
		try {
			(this._buffer as OutputFileBuffer).keep();
		} catch (error) {
			this._completionError = error instanceof Error ? error : new Error(String(error));
		}
		if (this._completionError === null && reaped) {
			removeShellFiles(this._home, this._activityId);
		}
		this._finalize(exitCode, this._completionError !== null ? "" : undefined);
		for (const r of this._reapedResolvers.splice(0)) r();
		recordActivityCompletion(this._activityId);
	}

	override poll(): BashResult | null {
		const result = super.poll();
		if (result !== null && this._completionError !== null) {
			throw this._completionError;
		}
		return result;
	}

	protected override async _awaitHandle(): Promise<BashResult | BashSnapshot> {
		const res = await super._awaitHandle();
		if (!res.running && this._completionError !== null) {
			throw this._completionError;
		}
		return res;
	}

	private _schedulePersistentCompletionNotice(): void {
		void (async () => {
			try {
				const result = await this._waitDone();
				if (this._completionError !== null) return;
				if (this._creatingCellFinished) {
					await this._creatingCellFinished;
				}
				if (this._awaitedByCreatingCell || this._resultConsumed || !isActive()) return;
				const command = capped(this.command);
				const reply = await hostRequestRaw({
					type: "bash.completed",
					pid: this._pid,
					command,
					exitCode: result.exitCode,
				});
				if (reply && reply.status === "ok") {
					this._armConsumedNotice(command);
				}
			} catch {
				// ignore
			}
		})();
	}

	override [Symbol.for("nodejs.util.inspect.custom")](): string {
		const state = this._result ? `exitCode=${this._result.exitCode}` : "running";
		return `<BashHandle persistent pid=${this._pid} ${state} command=${JSON.stringify(this.command)}>`;
	}
}

function spawnPersistent(command: string): PersistentBashHandle {
	if (!IS_POSIX) {
		throw new Error("bash({ persistent: true }) is only supported on POSIX");
	}
	const sessionId = process.env.RLM_SESSION_ID;
	if (!sessionId) {
		throw new Error(
			"bash({ persistent: true }) needs a saved session (RLM_SESSION_ID is unset): " +
				"the shell is assigned to the session that started it",
		);
	}
	const home = persistentHome();
	const shellId = randomBytes(16).toString("hex");
	fs.mkdirSync(home, { recursive: true, mode: 0o700 });
	const shell = resolveShell();
	const script = `{\n${withPrefix(command)}\n}\n__prime_status=$?\nwait\nexit "$__prime_status"\n`;
	const outPath = persistentFile(home, shellId, "out");
	const rcPath = persistentFile(home, shellId, "rc");
	const outFd = fs.openSync(outPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
	let proc: ChildProcess;
	try {
		proc = spawn(shell, ["-c", PERSISTENT_WRAPPER, "prime-agent-persistent", shell, script, rcPath], {
			cwd: process.cwd(),
			env: childEnv(),
			detached: true,
			stdio: ["pipe", outFd, outFd],
		});
	} finally {
		fs.closeSync(outFd);
	}
	if (!proc.pid) {
		throw new Error("bash({ persistent: true }): failed to spawn shell");
	}
	try {
		const startId = processStartId(proc.pid);
		if (!startId) {
			throw new Error("bash({ persistent: true }): the shell's start identity is unreadable");
		}
		const startedAt = new Date().toISOString();
		const record: PersistentRecord = {
			id: shellId,
			pid: proc.pid,
			startId,
			command,
			startedAt,
			sessionId,
		};
		const recordPath = persistentFile(home, shellId, "json");
		const tempPath = `${recordPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		fs.writeFileSync(tempPath, JSON.stringify(record), { mode: 0o600 });
		fs.renameSync(tempPath, recordPath);
		proc.stdin?.write("\n");
		proc.stdin?.end();
		return new PersistentBashHandle(command, shellId, proc.pid, startId, startedAt, home, proc, true);
	} catch (error) {
		try {
			proc.stdin?.destroy();
		} catch {
			// ignore
		}
		signalGroup(proc.pid, "SIGKILL");
		throw error;
	}
}

export function persistentShells(): BashHandle[] {
	return [...activityHandles.values()].filter((h) => h instanceof PersistentBashHandle);
}

export function rehydratePersistentShells(): void {
	const sessionId = process.env.RLM_SESSION_ID;
	if (!sessionId || !IS_POSIX) return;
	const home = persistentHome();
	for (const record of sessionRecords(home, sessionId)) {
		const identity = shellIdentity(record.pid, record.startId);
		if (identity === null) continue;
		if (identity || fs.existsSync(persistentFile(home, record.id, "rc"))) {
			new PersistentBashHandle(
				record.command,
				record.id,
				record.pid,
				record.startId,
				record.startedAt,
				home,
				null,
				identity,
			);
		} else if (reapPersistentGroup(record.pid, record.startId)) {
			removeShellFiles(home, record.id);
		}
	}
}

export function killLiveHandles(): void {
	for (const handle of [...liveHandles]) {
		const delivered = IS_POSIX ? signalGroup(handle._pid, "SIGKILL") : true;
		if (!IS_POSIX) {
			handle.kill("SIGKILL");
		}
		if (delivered) {
			recordJournal(handle._pid, false);
		}
	}
	liveHandles.clear();
}

function installShutdownHook(): void {
	if (shutdownHookInstalled) return;
	shutdownHookInstalled = true;
	process.on("exit", () => {
		killLiveHandles();
	});
}

export function bash(command: string, opts?: BashOptions | boolean): BashHandle {
	if (typeof command !== "string" || !command) {
		throw new TypeError("command must be a non-empty string");
	}
	const persistent = typeof opts === "boolean" ? opts : Boolean(opts?.persistent);
	let handle: BashHandle;
	if (persistent) {
		handle = spawnPersistent(command);
	} else {
		installShutdownHook();
		handle = new BashHandle(command);
	}
	const lines = command.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
	emit({
		[BASH_COMMAND_MIME]: {
			command: capped(command),
			lines,
		},
	});
	return handle;
}

export function sh(command: string): ShellPromise {
	if (typeof command !== "string") {
		throw new TypeError("sh command must be a string");
	}
	const shell = resolveShell();
	const source = withPrefix(command);
	const promise = new Promise<ShellResult>((resolve) => {
		execFile(
			shell,
			["-c", source],
			{ cwd: process.cwd(), encoding: "utf8", env: childEnv(), maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
				resolve({ exitCode, stderr, stdout });
			},
		);
	});
	const shellPromise = promise as ShellPromise;
	shellPromise.text = async () => (await promise).stdout;
	shellPromise.json = async <T = unknown>() => JSON.parse((await promise).stdout) as T;
	return shellPromise;
}

export function activityRequest(
	action: string,
	activityId?: string,
	lines = 50,
): Record<string, unknown> {
	if (action === "list") {
		const rows = [...activityHandles.entries()].map(([key, handle]) => ({
			id: key,
			command: handle.command.slice(0, 512),
			pid: handle._pid,
			startedAt: handle._startedAt,
			durationMs: Math.trunc(
				handle._result ? handle._result.duration * 1000 : performance.now() - handle._startedMs,
			),
			status: handle._reaped ? "finished" : "running",
			exitCode: handle._result ? handle._result.exitCode : null,
			persistent: handle instanceof PersistentBashHandle,
		}));
		while (JSON.stringify({ activities: rows }).length > ACTIVITY_FRAME_CAP && rows.length > 1) {
			const victim = rows.findIndex((row) => row.status !== "running");
			rows.splice(victim >= 0 ? victim : 0, 1);
		}
		return { activities: rows };
	}

	const handle = activityHandles.get(activityId ?? "");
	if (!handle) {
		throw new Error("Unknown kernel bash activity");
	}

	if (action === "tail") {
		if (!Number.isInteger(lines) || lines < 1 || lines > 200) {
			throw new RangeError("lines must be an integer between 1 and 200");
		}
		const tailText = splitLines(handle._rawBufferText()).slice(-lines).join("\n");
		let payload = Buffer.from(tailText, "utf8").subarray(-ACTIVITY_FRAME_CAP).toString("utf8");
		while (JSON.stringify({ tail: payload }).length > ACTIVITY_FRAME_CAP) {
			const excess = JSON.stringify({ tail: payload }).length - ACTIVITY_FRAME_CAP;
			const keep = Math.max(1, payload.length - Math.floor(excess / 6) - 1);
			payload = payload.slice(-keep);
		}
		return { activityId, tail: payload };
	}

	if (action === "kill") {
		if (handle._reaped) {
			return { activityId, killed: false };
		}
		handle.kill();
		return { activityId, killed: true };
	}

	throw new Error("Unknown kernel bash action");
}

export function capBashActivityFrame(frame: Record<string, unknown>): void {
	const tail = frame.tail;
	if (typeof tail === "string") {
		let current = tail;
		while (JSON.stringify(frame).length > ACTIVITY_FRAME_CAP) {
			const excess = JSON.stringify(frame).length - ACTIVITY_FRAME_CAP;
			const keep = Math.max(0, current.length - Math.floor(excess / 6) - 1);
			if (keep >= current.length) {
				frame.tail = "";
				break;
			}
			current = keep > 0 ? current.slice(-keep) : "";
			frame.tail = current;
		}
		return;
	}
	const rows = frame.activities;
	if (Array.isArray(rows)) {
		while (JSON.stringify(frame).length > ACTIVITY_FRAME_CAP && rows.length > 1) {
			const victim = rows.findIndex(
				(row) => typeof row === "object" && row !== null && (row as Record<string, unknown>).status !== "running",
			);
			rows.splice(victim >= 0 ? victim : 0, 1);
		}
	}
}
