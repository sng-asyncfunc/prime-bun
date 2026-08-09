import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBunRuntime } from "../src/core/kernel/bun-runtime.js";
import { KernelManager } from "../src/core/kernel/index.js";

describe("Bun kernel state round-trip", { tags: ["kernel-heavy"] }, () => {
	let bunPath = "";
	let directory = "";
	let snapshotPath = "";
	let manifestPath = "";

	beforeAll(async () => {
		bunPath = (await resolveBunRuntime()).path;
		directory = await mkdtemp(join(tmpdir(), "prime-bun-state-"));
		snapshotPath = join(directory, "session.bin");
		manifestPath = join(directory, "session.json");
	});

	afterAll(async () => {
		await rm(directory, { force: true, recursive: true });
	});

	function createManager(overrides: ConstructorParameters<typeof KernelManager>[0] = {}): KernelManager {
		return new KernelManager({
			bun: bunPath,
			cwd: directory,
			snapshot: { path: snapshotPath, manifestPath },
			...overrides,
		});
	}

	it("saves supported names, reports unsupported values, and restores a fresh worker", async () => {
		const writer = createManager();
		try {
			await writer.execute(`
const count = 42;
const collection = new Map([["numbers", new Set([1, 2, 3])]]);
const createdAt = new Date("2024-01-02T03:04:05.000Z");
const callable = (value) => value + count;
const pathModule = await import("node:path");
globalThis.explicitValue = 40;
`);
			const snapshot = await writer.snapshotState();
			expect(snapshot?.saved).toEqual(
				expect.arrayContaining(["callable", "collection", "count", "createdAt", "explicitValue", "pathModule"]),
			);
			expect(existsSync(snapshotPath)).toBe(true);
			expect(existsSync(manifestPath)).toBe(true);
		} finally {
			await writer.dispose();
		}

		const reader = createManager();
		try {
			const restore = await reader.restoreState();
			expect(restore?.restored).toEqual(
				expect.arrayContaining(["callable", "collection", "count", "createdAt", "explicitValue", "pathModule"]),
			);
			const result = await reader.execute(
				`({ count, values: [...collection.get("numbers")], date: createdAt.toISOString(), doubled: callable(0), explicitValue, basename: pathModule.basename("/a/b") });`,
			);
			expect(result.result).toContain("count: 42");
			expect(result.result).toContain("values: [ 1, 2, 3 ]");
			expect(result.result).toContain('date: "2024-01-02T03:04:05.000Z"');
			expect(result.result).toContain("doubled: 42");
			expect(result.result).toContain("explicitValue: 40");
			expect(result.result).toContain('basename: "b"');
		} finally {
			await reader.dispose();
		}
	});

	it("restores a multi-megabyte typed array after restart", async () => {
		const snapshot = { path: snapshotPath, manifestPath, debounceMs: 60_000 };
		const writer = createManager({ snapshot });
		try {
			await writer.execute(`
const largeBytes = new Uint8Array(8 * 1024 * 1024);
largeBytes[0] = 17;
largeBytes[largeBytes.length - 1] = 251;
`);
			const snapshot = await writer.snapshotState();
			expect(snapshot?.saved).toContain("largeBytes");
		} finally {
			await writer.dispose();
		}

		const reader = createManager({ snapshot });
		try {
			expect((await reader.restoreState())?.restored).toContain("largeBytes");
			const result = await reader.execute(
				`({ length: largeBytes.length, first: largeBytes[0], last: largeBytes.at(-1) })`,
			);
			expect(result.result).toContain("length: 8388608");
			expect(result.result).toContain("first: 17");
			expect(result.result).toContain("last: 251");
		} finally {
			await reader.dispose();
		}
	});

	it("preserves aliases without duplicating their shared snapshot data", async () => {
		const aliasSnapshot = {
			path: join(directory, "aliases.bin"),
			manifestPath: join(directory, "aliases.json"),
			debounceMs: 60_000,
		};
		const writer = createManager({ snapshot: aliasSnapshot });
		try {
			await writer.execute(`
const sharedAliasBytes = new Uint8Array(1024 * 1024);
sharedAliasBytes[0] = 17;
sharedAliasBytes[sharedAliasBytes.length - 1] = 251;
const alias0 = sharedAliasBytes;
const alias1 = sharedAliasBytes;
const alias2 = sharedAliasBytes;
const alias3 = sharedAliasBytes;
const alias4 = sharedAliasBytes;
const alias5 = sharedAliasBytes;
const alias6 = sharedAliasBytes;
const alias7 = sharedAliasBytes;
`);
			const snapshot = await writer.snapshotState();
			expect(snapshot?.bytes).toBeLessThan(2 * 1024 * 1024);
		} finally {
			await writer.dispose();
		}

		const reader = createManager({ snapshot: aliasSnapshot });
		try {
			expect((await reader.restoreState())?.restored).toEqual(
				expect.arrayContaining(["sharedAliasBytes", "alias0", "alias7"]),
			);
			const result = await reader.execute(`({
				same: sharedAliasBytes === alias0 && alias0 === alias7,
				length: alias7.length,
				first: alias0[0],
				last: alias7.at(-1),
			});`);
			expect(result.result).toContain("same: true");
			expect(result.result).toContain("length: 1048576");
			expect(result.result).toContain("first: 17");
			expect(result.result).toContain("last: 251");
		} finally {
			await reader.dispose();
		}
	});

	it("snapshots typed arrays without Uint8Array.from", async () => {
		const writer = createManager({
			snapshot: {
				path: join(directory, "zero-copy.bin"),
				manifestPath: join(directory, "zero-copy.json"),
				debounceMs: 60_000,
			},
		});
		try {
			await writer.execute(`
const bytesWithoutCopies = new Uint8Array([3, 5, 8]);
Uint8Array.from = () => { throw new Error("Uint8Array.from must not be used while snapshotting"); };
`);
			const snapshot = await writer.snapshotState();
			expect(snapshot?.saved).toContain("bytesWithoutCopies");
		} finally {
			await writer.dispose();
		}
	});

	it("restores Float16Array values after restart", async () => {
		const snapshotConfig = { path: snapshotPath, manifestPath, debounceMs: 60_000 };
		const writer = createManager({ snapshot: snapshotConfig });
		try {
			await writer.execute(`
const float16Values = new Float16Array([1.5, -2.25, 0.5]);
`);
			const snapshot = await writer.snapshotState();
			expect(snapshot?.saved).toContain("float16Values");
		} finally {
			await writer.dispose();
		}

		const reader = createManager({ snapshot: snapshotConfig });
		try {
			expect((await reader.restoreState())?.restored).toContain("float16Values");
			const result = await reader.execute(
				`({ first: float16Values[0], middle: float16Values[1], last: float16Values[2], tag: Object.prototype.toString.call(float16Values) })`,
			);
			expect(result.result).toContain("first: 1.5");
			expect(result.result).toContain("middle: -2.25");
			expect(result.result).toContain("last: 0.5");
			expect(result.result).toContain('tag: "[object Float16Array]"');
		} finally {
			await reader.dispose();
		}
	});

	it("treats a missing snapshot as an empty restore", async () => {
		const missingPath = join(directory, "missing.bin");
		const manager = createManager({ snapshot: { path: missingPath, manifestPath: join(directory, "missing.json") } });
		try {
			expect(await manager.restoreState()).toEqual({ restored: [], failed: [], path: missingPath });
		} finally {
			await manager.dispose();
		}
	});

	it("reports a corrupt snapshot without poisoning the worker", async () => {
		const corruptPath = join(directory, "corrupt.bin");
		await writeFile(corruptPath, "not a Bun snapshot");
		const manager = createManager({
			snapshot: { path: corruptPath, manifestPath: join(directory, "corrupt.json") },
		});
		try {
			expect(await manager.restoreState()).toBeNull();
			expect(await manager.execute("6 * 7;")).toMatchObject({ status: "ok", result: "42" });
		} finally {
			await manager.dispose();
		}
	});

	it("lists user names without runtime handles or private bindings", async () => {
		const manager = createManager({ snapshot: undefined });
		try {
			expect(await manager.listNamespaceNames()).toBeNull();
			await manager.execute("const alpha = 1; const _private = 2; globalThis.beta = 2;");
			const names = await manager.listNamespaceNames();
			expect(names).toContain("alpha");
			expect(names).toContain("beta");
			expect(names).not.toContain("_private");
			expect(names).not.toContain("sh");
			await manager.execute("delete globalThis.beta;");
			expect(await manager.listNamespaceNames()).not.toContain("beta");
		} finally {
			await manager.dispose();
		}
	});

	it("auto-snapshots successful state after the configured debounce", async () => {
		const autoPath = join(directory, "auto.bin");
		const manager = createManager({
			snapshot: { path: autoPath, manifestPath: join(directory, "auto.json"), debounceMs: 25 },
		});
		try {
			await manager.execute('const autoValue = "persisted";');
			await expect.poll(() => existsSync(autoPath), { timeout: 5_000 }).toBe(true);
		} finally {
			await manager.dispose();
		}
	});

	it("does not persist cwd or environment values in the session snapshot", async () => {
		const privateMarker = "prime-session-secret-marker";
		const manager = createManager();
		try {
			await manager.execute(`process.env.PRIME_BUN_SESSION_SECRET = ${JSON.stringify(privateMarker)};`);
			await manager.snapshotState();
			const payload = await readFile(snapshotPath);
			expect(payload.includes(privateMarker)).toBe(false);
			expect(payload.includes("PRIME_BUN_SESSION_SECRET")).toBe(false);
		} finally {
			await manager.dispose();
		}
	});
});
