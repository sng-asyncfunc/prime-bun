import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stderr, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type ResolvedBunRuntime, resolveBunRuntime } from "./bun-runtime.js";

const BOOTSTRAP_SCHEMA = 1;
const BOOTSTRAP_VERSION_FILE = ".bootstrap-version";
const BOOTSTRAP_LOCK_NAME = ".bootstrap.lock";
const BOOTSTRAP_LOCK_RETRY_MS = 100;
const BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS = 30_000;
const BUN_INSTALL_COMMAND = "curl -fsSL https://bun.sh/install | bash";
const RUNTIME_ASSET_NAMES = [
	"bun-worker",
	"bun-protocol",
	"bun-cell-transform",
	"bun-rlm-runtime",
	"state-snapshot",
] as const;
const KERNEL_DEPENDENCIES = {
	"@modelcontextprotocol/sdk": "^1.30.0",
	acorn: "^8.18.0",
} as const;

let inFlightEnsureKernelBun: { key: string; promise: Promise<KernelBunRuntime> } | undefined;

export type KernelBootstrapProgressHandler = (message: string) => void;

export interface KernelBunRuntime extends ResolvedBunRuntime {
	kernelDirectory: string;
	workerPath: string;
}

export interface EnsureKernelBunOptions {
	onProgress?: KernelBootstrapProgressHandler;
	runtimeSourceDirectory?: string;
	installRuntime?: () => Promise<void>;
}

interface BootstrapVersion {
	schema: number;
	assetHash: string;
	dependencies: Record<string, string>;
}

interface RuntimeAssets {
	directory: string;
	extension: ".js" | ".ts";
	hash: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

function homeDirectory(): string {
	return process.env.HOME || os.homedir();
}

function expandHome(filePath: string): string {
	if (filePath === "~") return homeDirectory();
	if (filePath.startsWith("~/")) return path.join(homeDirectory(), filePath.slice(2));
	return filePath;
}

export function getKernelBunDir(): string {
	const override = process.env.PRIME_AGENT_KERNEL_BUN_DIR?.trim();
	if (override) return path.resolve(expandHome(override));
	return path.join(homeDirectory(), ".prime", "agent", "kernel-bun");
}

function getXdgKernelBunDir(): string {
	const dataHome = process.env.XDG_DATA_HOME
		? path.resolve(expandHome(process.env.XDG_DATA_HOME))
		: path.join(homeDirectory(), ".local", "share");
	return path.join(dataHome, "prime", "agent", "kernel-bun");
}

async function resolveWritableKernelBunDir(): Promise<string> {
	const primary = getKernelBunDir();
	try {
		await mkdir(path.dirname(primary), { recursive: true });
		return primary;
	} catch (primaryError) {
		if (process.env.PRIME_AGENT_KERNEL_BUN_DIR) {
			throw new Error(`couldn't create Bun kernel directory ${primary}: ${errorMessage(primaryError)}`);
		}
		const fallback = getXdgKernelBunDir();
		try {
			await mkdir(path.dirname(fallback), { recursive: true });
			return fallback;
		} catch (fallbackError) {
			throw new Error(
				`couldn't create Bun kernel directory at ${primary} or ${fallback}: ${errorMessage(fallbackError)}`,
			);
		}
	}
}

function reportProgress(options: EnsureKernelBunOptions, message: string): void {
	if (options.onProgress) {
		options.onProgress(message);
		return;
	}
	process.stderr.write(`${message}\n`);
}

function run(
	command: string,
	args: readonly string[],
	options: { cwd?: string; stdio?: "ignore" | "inherit" } = {},
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: process.env,
			stdio: options.stdio ?? "ignore",
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			reject(new Error(`${command} ${args.join(" ")} failed with ${reason}`));
		});
	});
}

async function confirmBunInstall(): Promise<boolean> {
	if (process.env.PRIME_AGENT_INSTALL_BUN === "0") return false;
	if (!stdin.isTTY || !stderr.isTTY) return false;
	const readline = createInterface({ input: stdin, output: stderr });
	try {
		const answer = (await readline.question("Prime Agent needs Bun. Install it from bun.sh now? [Y/n] "))
			.trim()
			.toLowerCase();
		return answer !== "n" && answer !== "no";
	} finally {
		readline.close();
	}
}

async function installBun(options: EnsureKernelBunOptions): Promise<void> {
	reportProgress(options, "› installing Bun (one-time)…");
	if (options.installRuntime) {
		await options.installRuntime();
		return;
	}
	await run("sh", ["-c", BUN_INSTALL_COMMAND], { stdio: options.onProgress ? "ignore" : "inherit" });
}

async function resolveOrInstallBun(options: EnsureKernelBunOptions): Promise<ResolvedBunRuntime> {
	try {
		return await resolveBunRuntime();
	} catch (initialError) {
		const hasOverride = Boolean(process.env.PRIME_AGENT_KERNEL_BUN?.trim());
		const shouldInstall =
			!hasOverride &&
			(process.env.PRIME_AGENT_INSTALL_BUN === "1" || (!options.onProgress && (await confirmBunInstall())));
		if (!shouldInstall) {
			throw new Error(
				`Bun is required for the persistent JavaScript runtime. Install it with ${BUN_INSTALL_COMMAND}, or set PRIME_AGENT_INSTALL_BUN=1 to let Prime Agent run that installer. ${errorMessage(initialError)}`,
				{ cause: initialError },
			);
		}
		try {
			await installBun(options);
			return await resolveBunRuntime();
		} catch (installError) {
			throw new Error(
				`couldn't install Bun from bun.sh; run ${BUN_INSTALL_COMMAND}, then retry. ${errorMessage(installError)}`,
				{ cause: installError },
			);
		}
	}
}

function bootstrapLockDir(kernelDirectory: string): string {
	return path.join(path.dirname(kernelDirectory), `${path.basename(kernelDirectory)}${BOOTSTRAP_LOCK_NAME}`);
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error, "EPERM");
	}
}

async function readLockPid(lockDir: string): Promise<number | undefined> {
	try {
		const pid = Number.parseInt((await readFile(path.join(lockDir, "pid"), "utf8")).trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

async function missingPidLockIsStale(lockDir: string): Promise<boolean> {
	try {
		return Date.now() - (await stat(lockDir)).mtimeMs > BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS;
	} catch {
		return false;
	}
}

async function acquireBootstrapLock(kernelDirectory: string): Promise<() => Promise<void>> {
	const lockDir = bootstrapLockDir(kernelDirectory);
	await mkdir(path.dirname(lockDir), { recursive: true });
	for (;;) {
		try {
			await mkdir(lockDir);
			await writeFile(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");
			return () => rm(lockDir, { recursive: true, force: true });
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) throw error;
			const pid = await readLockPid(lockDir);
			if (pid === undefined ? await missingPidLockIsStale(lockDir) : !processIsRunning(pid)) {
				await rm(lockDir, { recursive: true, force: true });
				continue;
			}
			await sleep(BOOTSTRAP_LOCK_RETRY_MS);
		}
	}
}

async function resolveRuntimeAssets(configuredDirectory: string | undefined): Promise<RuntimeAssets> {
	const directory = path.resolve(configuredDirectory ?? path.dirname(fileURLToPath(import.meta.url)));
	const extension = (await exists(path.join(directory, "bun-worker.js"))) ? ".js" : ".ts";
	const hash = createHash("sha256");
	for (const name of RUNTIME_ASSET_NAMES) {
		const assetPath = path.join(directory, `${name}${extension}`);
		let content: Buffer;
		try {
			content = await readFile(assetPath);
		} catch (error) {
			throw new Error(`Bun runtime asset is missing: ${assetPath}`, { cause: error });
		}
		hash.update(`${name}${extension}\0`);
		hash.update(content);
		hash.update("\0");
	}
	return { directory, extension, hash: `sha256:${hash.digest("hex")}` };
}

async function readBootstrapVersion(kernelDirectory: string): Promise<BootstrapVersion | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path.join(kernelDirectory, BOOTSTRAP_VERSION_FILE), "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		if (
			typeof record.schema !== "number" ||
			typeof record.assetHash !== "string" ||
			typeof record.dependencies !== "object" ||
			record.dependencies === null ||
			Array.isArray(record.dependencies)
		) {
			return undefined;
		}
		const dependencies = record.dependencies as Record<string, unknown>;
		if (!Object.values(dependencies).every((value) => typeof value === "string")) return undefined;
		return {
			assetHash: record.assetHash,
			dependencies: dependencies as Record<string, string>,
			schema: record.schema,
		};
	} catch {
		return undefined;
	}
}

function dependenciesMatch(actual: Record<string, string>): boolean {
	const expectedEntries = Object.entries(KERNEL_DEPENDENCIES);
	return (
		Object.keys(actual).length === expectedEntries.length &&
		expectedEntries.every(([name, version]) => actual[name] === version)
	);
}

async function provisionCurrent(kernelDirectory: string, assets: RuntimeAssets): Promise<boolean> {
	const version = await readBootstrapVersion(kernelDirectory);
	return (
		version?.schema === BOOTSTRAP_SCHEMA &&
		version.assetHash === assets.hash &&
		dependenciesMatch(version.dependencies) &&
		(await exists(path.join(kernelDirectory, `bun-worker${assets.extension}`))) &&
		(await exists(path.join(kernelDirectory, "node_modules", "acorn", "package.json"))) &&
		(await exists(path.join(kernelDirectory, "node_modules", "@modelcontextprotocol", "sdk", "package.json")))
	);
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, content, "utf8");
	await rename(temporaryPath, filePath);
}

async function provisionKernelRuntime(
	runtime: ResolvedBunRuntime,
	kernelDirectory: string,
	assets: RuntimeAssets,
	options: EnsureKernelBunOptions,
): Promise<void> {
	if (await provisionCurrent(kernelDirectory, assets)) return;
	const releaseLock = await acquireBootstrapLock(kernelDirectory);
	try {
		if (await provisionCurrent(kernelDirectory, assets)) return;
		reportProgress(options, "› preparing Bun runtime (one-time)…");
		await mkdir(kernelDirectory, { recursive: true });
		for (const name of RUNTIME_ASSET_NAMES) {
			await copyFile(
				path.join(assets.directory, `${name}${assets.extension}`),
				path.join(kernelDirectory, `${name}${assets.extension}`),
			);
		}
		await writeAtomic(
			path.join(kernelDirectory, "package.json"),
			`${JSON.stringify({ private: true, type: "module", dependencies: KERNEL_DEPENDENCIES }, null, 2)}\n`,
		);
		await run(runtime.path, ["install", "--production"], { cwd: kernelDirectory });
		await writeAtomic(
			path.join(kernelDirectory, BOOTSTRAP_VERSION_FILE),
			`${JSON.stringify({ schema: BOOTSTRAP_SCHEMA, assetHash: assets.hash, dependencies: KERNEL_DEPENDENCIES })}\n`,
		);
		reportProgress(options, "✓ Bun runtime ready");
	} finally {
		await releaseLock().catch(() => undefined);
	}
}

function ensureKey(options: EnsureKernelBunOptions): string {
	return [
		process.env.PRIME_AGENT_KERNEL_BUN ?? "",
		process.env.PRIME_AGENT_KERNEL_BUN_DIR ?? "",
		process.env.PATH ?? "",
		homeDirectory(),
		options.runtimeSourceDirectory ?? "",
	].join("\0");
}

async function ensureKernelBunUncached(options: EnsureKernelBunOptions): Promise<KernelBunRuntime> {
	const runtime = await resolveOrInstallBun(options);
	const kernelDirectory = await resolveWritableKernelBunDir();
	const assets = await resolveRuntimeAssets(options.runtimeSourceDirectory);
	try {
		await provisionKernelRuntime(runtime, kernelDirectory, assets, options);
	} catch (error) {
		throw new Error(
			`Failed to prepare the Bun kernel runtime. First-time setup needs internet to install its JavaScript packages; later starts work offline. ${errorMessage(error)}`,
			{ cause: error },
		);
	}
	return {
		...runtime,
		kernelDirectory,
		workerPath: path.join(kernelDirectory, `bun-worker${assets.extension}`),
	};
}

export function ensureKernelBun(options: EnsureKernelBunOptions = {}): Promise<KernelBunRuntime> {
	const key = ensureKey(options);
	if (inFlightEnsureKernelBun?.key === key) return inFlightEnsureKernelBun.promise;
	const promise = ensureKernelBunUncached(options).finally(() => {
		if (inFlightEnsureKernelBun?.promise === promise) inFlightEnsureKernelBun = undefined;
	});
	inFlightEnsureKernelBun = { key, promise };
	return promise;
}
