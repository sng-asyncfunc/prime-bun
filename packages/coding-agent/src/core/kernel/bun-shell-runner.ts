import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";

const EXIT_STDIO_GRACE_MS = 100;

export interface BunShellProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	errorCode?: string | number;
	timedOut?: boolean;
}

export interface BunShellProcessOptions {
	command: string;
	args: readonly string[];
	cwd?: string;
	detached?: boolean;
	env?: NodeJS.ProcessEnv;
	maxBufferBytes: number;
	timeoutMs?: number;
	onStart?: (pid: number) => void;
	onExit?: (pid: number) => void;
}

function processErrorCode(error: unknown): string | number | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code;
	return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function captureStream(
	child: ChildProcess,
	name: "stdout" | "stderr",
	maxBufferBytes: number,
	onOverflow: () => void,
): () => string {
	const chunks: Buffer[] = [];
	let bytes = 0;
	const stream = child[name];
	stream?.on("data", (chunk: Buffer | string) => {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const remaining = Math.max(0, maxBufferBytes - bytes);
		if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
		bytes += buffer.byteLength;
		if (bytes > maxBufferBytes) onOverflow();
	});
	return () => Buffer.concat(chunks).toString("utf8");
}

function normalizedExitCode(code: number | null, signal: NodeJS.Signals | null): number | null {
	if (code !== null) return code;
	if (!signal) return null;
	return 128 + (constants.signals[signal] ?? 1);
}

function waitForBunShellProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let graceTimer: NodeJS.Timeout | undefined;
		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			if (graceTimer) clearTimeout(graceTimer);
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(exitCode);
		};
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			if (graceTimer) clearTimeout(graceTimer);
			child.stdout?.destroy();
			child.stderr?.destroy();
			reject(error);
		});
		child.once("close", (code, signal) => finish(normalizedExitCode(code, signal)));
		child.once("exit", (code, signal) => {
			graceTimer = setTimeout(() => finish(normalizedExitCode(code, signal)), EXIT_STDIO_GRACE_MS);
			graceTimer.unref?.();
		});
	});
}

function killBunShellProcess(child: ChildProcess, detached: boolean): void {
	if (detached && child.pid !== undefined && process.platform !== "win32") {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {}
	}
	try {
		child.kill("SIGKILL");
	} catch {}
}

export async function runBunShellProcess(options: BunShellProcessOptions): Promise<BunShellProcessResult> {
	const detached = options.detached === true && process.platform !== "win32";
	const child = spawn(options.command, [...options.args], {
		cwd: options.cwd,
		detached,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	if (child.pid !== undefined) options.onStart?.(child.pid);
	let overflowed = false;
	let timedOut = false;
	const stopForOverflow = () => {
		if (overflowed) return;
		overflowed = true;
		killBunShellProcess(child, detached);
	};
	const stdout = captureStream(child, "stdout", options.maxBufferBytes, stopForOverflow);
	const stderr = captureStream(child, "stderr", options.maxBufferBytes, stopForOverflow);
	let failure: unknown;
	let timeout: NodeJS.Timeout | undefined;
	if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
		timeout = setTimeout(() => {
			timedOut = true;
			killBunShellProcess(child, detached);
		}, options.timeoutMs);
		timeout.unref?.();
	}
	const clearWallTimeout = () => {
		if (!timeout) return;
		clearTimeout(timeout);
		timeout = undefined;
	};
	child.once("exit", clearWallTimeout);
	const exitCode = await waitForBunShellProcess(child)
		.catch((error: unknown) => {
			failure = error;
			return null;
		})
		.finally(() => {
			clearWallTimeout();
			if (detached) killBunShellProcess(child, true);
			if (child.pid !== undefined) options.onExit?.(child.pid);
		});
	const capturedStderr = stderr();
	const errorCode = processErrorCode(failure);
	const timeoutMessage = timedOut
		? `command timed out after ${options.timeoutMs}ms (notebook stdin is closed; commands that wait for input or run indefinitely need explicit operands or a larger timeout)`
		: undefined;
	const overflowMessage = overflowed ? `command output exceeded ${options.maxBufferBytes} bytes` : undefined;
	return {
		exitCode: timedOut ? 124 : typeof exitCode === "number" ? exitCode : failure || overflowed ? 1 : 0,
		stdout: stdout(),
		stderr: [capturedStderr, overflowMessage, timeoutMessage].filter(Boolean).join("\n"),
		...(errorCode !== undefined ? { errorCode } : {}),
		...(timedOut ? { timedOut: true } : {}),
	};
}
