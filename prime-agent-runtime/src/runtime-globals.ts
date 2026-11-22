import { execFile } from "node:child_process";
import * as fsModule from "node:fs";
import { createRequire } from "node:module";
import * as osModule from "node:os";
import * as pathModule from "node:path";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as utilModule from "node:util";
import { $ } from "bun";
import { emit, hostRequest } from "./bridge.ts";

export const JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER = "__PRIME_AGENT_JAVASCRIPT_SKILL_IMPORT_ERRORS__";
const MAX_SKILL_UNAVAILABLE_REASON_CHARS = 512;
const DEFAULT_SKILL_FACTORY_TIMEOUT_MS = 10_000;

export type PrimeFileSystem = Omit<typeof fsModule, keyof typeof fsModule.promises | "promises"> &
	typeof fsModule.promises & {
		callbacks: typeof fsModule;
		promises: typeof fsModule.promises;
	};

export interface InstallPackageResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface PreparedJavaScriptSkillInput {
	name: string;
	globalName?: string;
	global_name?: string;
	entryPath?: string;
	entry_path?: string;
	unavailableReason?: string | null;
	unavailable_reason?: string | null;
}

const PRIME_RUNTIME_GLOBAL_NAMES = [
	"$",
	"Bun",
	"fs",
	"os",
	"path",
	"util",
	"require",
	"sh",
	"bash",
	"mcp",
	"rlm",
	"installPackage",
	"hostRequest",
	"__primeDisplay",
	"__primeHostRequest",
	"__primeSetCompletionNoticesWired",
	"__primeLoadSkills",
] as const;

const BUN_ONLY_GLOBAL_NAMES = [
	"AsyncDisposableStack",
	"BuildError",
	"BuildMessage",
	"CloseEvent",
	"DisposableStack",
	"ErrorEvent",
	"Float16Array",
	"HTMLRewriter",
	"PerformanceServerTiming",
	"PerformanceTiming",
	"ResolveError",
	"ResolveMessage",
	"ShadowRealm",
	"SuppressedError",
	"URLPattern",
	"Worker",
	"addEventListener",
	"alert",
	"confirm",
	"dispatchEvent",
	"ffi",
	"jsc",
	"onerror",
	"onmessage",
	"postMessage",
	"prompt",
	"removeEventListener",
	"reportError",
	"self",
	"sqlite",
] as const;

export const BUN_RUNTIME_GLOBAL_NAMES: ReadonlySet<string> = new Set([
	...Object.getOwnPropertyNames(globalThis),
	...BUN_ONLY_GLOBAL_NAMES,
	...PRIME_RUNTIME_GLOBAL_NAMES,
]);

export const primeFileSystem: PrimeFileSystem = Object.freeze({
	...fsModule,
	...fsModule.promises,
	callbacks: fsModule,
	promises: fsModule.promises,
});

export function resolveKernelDirectory(): string {
	const envDir = (process.env.PRIME_AGENT_KERNEL_BUN_DIR ?? "").trim();
	if (envDir) return pathModule.resolve(envDir);
	// Default to the runtime package root (parent of src/)
	return pathModule.resolve(dirname(new URL(import.meta.url).pathname), "..");
}

export function resolveBunBinary(): string {
	const envBun = (process.env.PRIME_AGENT_KERNEL_BUN ?? "").trim();
	if (envBun) return envBun;
	return process.execPath || "bun";
}

export function createKernelRequire(kernelDir = resolveKernelDirectory()): NodeJS.Require {
	return createRequire(join(kernelDir, "package.json"));
}

export function installPackage(...names: string[]): Promise<InstallPackageResult> {
	if (names.length === 0 || names.some((name) => typeof name !== "string" || !name.trim())) {
		throw new Error("installPackage requires at least one non-empty package name");
	}
	if (names.some((name) => name.trimStart().startsWith("-"))) {
		throw new Error("installPackage package names cannot start with '-'");
	}
	const kernelDir = resolveKernelDirectory();
	const bunPath = resolveBunBinary();
	return new Promise((resolve, reject) => {
		execFile(
			bunPath,
			["add", "--cwd", kernelDir, ...names],
			{ cwd: kernelDir, encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
				const result = { exitCode, stderr, stdout };
				if (error) {
					reject(
						new Error(`bun add ${names.join(" ")} failed with exit code ${exitCode}: ${stderr.trim()}`, {
							cause: error,
						}),
					);
					return;
				}
				resolve(result);
			},
		);
	});
}

export function skillDisplay(mimeOrPayload: string | Record<string, unknown>, data?: unknown): void {
	if (typeof mimeOrPayload === "string") {
		if (!mimeOrPayload) {
			throw new TypeError("display() MIME type must be a non-empty string");
		}
		emit({ [mimeOrPayload]: data });
		return;
	}
	if (mimeOrPayload && typeof mimeOrPayload === "object" && !Array.isArray(mimeOrPayload)) {
		emit(mimeOrPayload);
		return;
	}
	throw new TypeError("display() requires (mimeType, data) or a non-empty MIME payload object");
}

class SkillFactoryTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillFactoryTimeoutError";
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new SkillFactoryTimeoutError(`${label} timed out after ${timeoutMs} ms`)),
			timeoutMs,
		);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message || error.name || "Error";
	return String(error);
}

function defineUnavailableSkill(name: string, globalName: string, reason: string): void {
	const clipped = reason.slice(0, MAX_SKILL_UNAVAILABLE_REASON_CHARS);
	const unavailable = new Proxy(
		async (): Promise<never> => {
			throw new Error(`JavaScript skill ${name} is unavailable: ${clipped}`);
		},
		{
			get(_target, prop) {
				if (prop === "then") return undefined;
				if (typeof prop === "symbol") return undefined;
				return async (): Promise<never> => {
					throw new Error(`JavaScript skill ${name} is unavailable: ${clipped}`);
				};
			},
		},
	);
	Object.defineProperty(globalThis, globalName, {
		configurable: true,
		enumerable: true,
		value: unavailable,
		writable: false,
	});
}

export function createSkillLoader(
	runtimeBindingNames: Set<string>,
	requireFn: NodeJS.Require,
	timeoutMs = DEFAULT_SKILL_FACTORY_TIMEOUT_MS,
): (skills: PreparedJavaScriptSkillInput[]) => Promise<Record<string, string>> {
	return async function __primeLoadSkills(
		skills: PreparedJavaScriptSkillInput[],
	): Promise<Record<string, string>> {
		const errors: Record<string, string> = {};
		if (!Array.isArray(skills)) {
			throw new TypeError("__primeLoadSkills requires an array of skill descriptors");
		}
		const context = {
			get cwd(): string {
				return process.cwd();
			},
			display: skillDisplay,
			hostRequest,
		};

		for (const rawSkill of skills) {
			const name = rawSkill.name;
			const globalName = rawSkill.globalName ?? rawSkill.global_name ?? "";
			const entryPath = rawSkill.entryPath ?? rawSkill.entry_path ?? "";
			const unavailableReason = rawSkill.unavailableReason ?? rawSkill.unavailable_reason ?? undefined;

			if (!globalName) {
				errors[name || "<unnamed>"] = "missing globalName";
				continue;
			}
			if (runtimeBindingNames.has(globalName)) {
				errors[globalName] = `JavaScript skill ${name} conflicts with runtime global ${globalName}`;
				continue;
			}
			if (unavailableReason !== undefined && unavailableReason !== null) {
				const reason = String(unavailableReason).slice(0, MAX_SKILL_UNAVAILABLE_REASON_CHARS);
				defineUnavailableSkill(name, globalName, reason);
				runtimeBindingNames.add(globalName);
				errors[globalName] = reason;
				continue;
			}
			if (!entryPath) {
				const reason = `JavaScript skill ${name} has no entry path`;
				defineUnavailableSkill(name, globalName, reason);
				runtimeBindingNames.add(globalName);
				errors[globalName] = reason;
				continue;
			}

			let loaded: unknown;
			try {
				try {
					loaded = requireFn(entryPath);
				} catch {
					loaded = await import(pathToFileURL(entryPath).href);
				}
			} catch (error) {
				const reason = errorMessage(error);
				defineUnavailableSkill(name, globalName, reason);
				runtimeBindingNames.add(globalName);
				errors[globalName] = reason;
				continue;
			}

			const exportsObj =
				typeof loaded === "object" && loaded !== null ? (loaded as Record<string, unknown>) : {};
			const factory = exportsObj.createSkill;
			let value: unknown;
			if (typeof factory === "function") {
				try {
					value = await withTimeout(
						Promise.resolve(factory(context)),
						timeoutMs,
						`JavaScript skill ${name} factory`,
					);
				} catch (error) {
					const reason = errorMessage(error);
					defineUnavailableSkill(name, globalName, reason);
					runtimeBindingNames.add(globalName);
					errors[globalName] = reason;
					continue;
				}
			} else {
				value = exportsObj.default ?? loaded;
			}

			if (value === undefined) {
				const reason = "module exports neither createSkill nor default";
				defineUnavailableSkill(name, globalName, reason);
				runtimeBindingNames.add(globalName);
				errors[globalName] = reason;
				continue;
			}

			Object.defineProperty(globalThis, globalName, {
				configurable: true,
				enumerable: true,
				value,
				writable: false,
			});
			runtimeBindingNames.add(globalName);
		}

		if (Object.keys(errors).length > 0) {
			process.stdout.write(`${JAVASCRIPT_SKILL_IMPORT_ERROR_REPORT_MARKER}${JSON.stringify(errors)}\n`);
		}
		return errors;
	};
}

export { $, osModule, pathModule, utilModule };
