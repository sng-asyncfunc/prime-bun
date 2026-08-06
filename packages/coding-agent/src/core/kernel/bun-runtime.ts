import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const MINIMUM_BUN_VERSION = "1.3.14";

export interface ResolvedBunRuntime {
	path: string;
	version: string;
}

export type BunSerializationStatus = "preserved" | "rejected" | "degraded";

export interface BunSerializationMatrix {
	primitive: BunSerializationStatus;
	plainObject: BunSerializationStatus;
	cycle: BunSerializationStatus;
	date: BunSerializationStatus;
	regexp: BunSerializationStatus;
	map: BunSerializationStatus;
	set: BunSerializationStatus;
	arrayBuffer: BunSerializationStatus;
	typedArray: BunSerializationStatus;
	function: BunSerializationStatus;
	promise: BunSerializationStatus;
	weakCollection: BunSerializationStatus;
	customClass: BunSerializationStatus;
}

export interface ResolveBunRuntimeOptions {
	env?: NodeJS.ProcessEnv;
	homeDirectory?: string;
	findOnPath?: (name: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
	readVersion?: (executablePath: string) => Promise<string>;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function parseVersion(version: string): readonly [number, number, number] {
	const match = VERSION_PATTERN.exec(version.trim());
	if (!match) {
		throw new Error(`Invalid Bun version: ${version}`);
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function assertSupportedBunVersion(version: string): void {
	const actual = parseVersion(version);
	const minimum = parseVersion(MINIMUM_BUN_VERSION);
	for (let index = 0; index < minimum.length; index += 1) {
		const actualPart = actual[index];
		const minimumPart = minimum[index];
		if (actualPart > minimumPart) return;
		if (actualPart < minimumPart) {
			throw new Error(`Prime Agent requires Bun ${MINIMUM_BUN_VERSION} or newer, found ${version.trim()}`);
		}
	}
}

function executableNames(name: string, env: NodeJS.ProcessEnv): string[] {
	if (process.platform !== "win32") return [name];
	const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
		.split(";")
		.filter(Boolean)
		.map((extension) => extension.toLowerCase());
	return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const pathValue = env.PATH ?? env.Path ?? env.path;
	if (!pathValue) return undefined;
	for (const directory of pathValue.split(delimiter)) {
		if (!directory) continue;
		for (const executableName of executableNames(name, env)) {
			const candidate = join(directory, executableName);
			try {
				await access(candidate, fsConstants.X_OK);
				return candidate;
			} catch {}
		}
	}
	return undefined;
}

function execute(executablePath: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(executablePath, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				const detail = stderr.trim() || error.message;
				reject(new Error(`${executablePath} ${args.join(" ")} failed: ${detail}`, { cause: error }));
				return;
			}
			resolve(stdout.trim());
		});
	});
}

async function readVersion(executablePath: string): Promise<string> {
	return execute(executablePath, ["--version"]);
}

function runtimeError(executablePath: string, error: unknown): Error {
	return new Error(
		`Unable to use Bun at ${executablePath}. Install Bun ${MINIMUM_BUN_VERSION} or newer, or set PRIME_AGENT_KERNEL_BUN to a supported executable.`,
		{ cause: error },
	);
}

export async function resolveBunRuntime(options: ResolveBunRuntimeOptions = {}): Promise<ResolvedBunRuntime> {
	const env = options.env ?? process.env;
	const versionReader = options.readVersion ?? readVersion;
	const overriddenPath = env.PRIME_AGENT_KERNEL_BUN?.trim();
	const pathExecutable = overriddenPath ? undefined : await (options.findOnPath ?? findOnPath)("bun", env);
	const executablePath =
		overriddenPath || pathExecutable || join(options.homeDirectory ?? homedir(), ".bun", "bin", "bun");

	let version: string;
	try {
		version = (await versionReader(executablePath)).trim();
	} catch (error) {
		throw runtimeError(executablePath, error);
	}
	assertSupportedBunVersion(version);
	return { path: executablePath, version };
}

const SERIALIZATION_CHARACTERIZATION_SCRIPT = `
import { deserialize, serialize } from "bun:jsc";

class SnapshotClass {
  constructor(value) {
    this.value = value;
  }
}

const cycle = { value: 1 };
cycle.self = cycle;

const cases = {
  primitive: [42, (value) => value === 42],
  plainObject: [{ nested: [1, "two"] }, (value) => Object.getPrototypeOf(value) === Object.prototype && value.nested[1] === "two"],
  cycle: [cycle, (value) => value.self === value],
  date: [new Date("2024-01-02T03:04:05.000Z"), (value) => value instanceof Date && value.toISOString() === "2024-01-02T03:04:05.000Z"],
  regexp: [/prime/giu, (value) => value instanceof RegExp && value.source === "prime" && value.flags === "giu"],
  map: [new Map([["key", 7]]), (value) => value instanceof Map && value.get("key") === 7],
  set: [new Set(["value"]), (value) => value instanceof Set && value.has("value")],
  arrayBuffer: [Uint8Array.from([3, 5, 8]).buffer, (value) => value instanceof ArrayBuffer && new Uint8Array(value)[2] === 8],
  typedArray: [Uint16Array.from([13, 21]), (value) => value instanceof Uint16Array && value[1] === 21],
  function: [() => 1, () => true],
  promise: [Promise.resolve(1), () => true],
  weakCollection: [new WeakMap(), () => true],
  customClass: [new SnapshotClass(34), (value) => value instanceof SnapshotClass && value.value === 34],
};

const matrix = {};
for (const [name, [input, preserves]] of Object.entries(cases)) {
  try {
    const restored = deserialize(serialize(input));
    matrix[name] = preserves(restored) ? "preserved" : "degraded";
  } catch {
    matrix[name] = "rejected";
  }
}
console.log(JSON.stringify(matrix));
`;

export async function characterizeBunSerialization(executablePath: string): Promise<BunSerializationMatrix> {
	const output = await execute(executablePath, ["--eval", SERIALIZATION_CHARACTERIZATION_SCRIPT]);
	return JSON.parse(output) as BunSerializationMatrix;
}
