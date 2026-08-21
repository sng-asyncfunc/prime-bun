import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUN_WORKER_PROTOCOL_VERSION,
	type BunWorkerSuccessResultMessage,
	type BunWorkerToHostMessage,
	type HostToBunWorkerMessage,
} from "../src/core/kernel/bun-protocol.js";
import { resolveBunRuntime } from "../src/core/kernel/bun-runtime.js";
import { decodeSnapshotPayload } from "../src/core/kernel/state-snapshot.js";

type MessageType = BunWorkerToHostMessage["type"];
type MessageOfType<T extends MessageType> = Extract<BunWorkerToHostMessage, { type: T }>;

interface MessageWaiter {
	predicate: (message: BunWorkerToHostMessage) => boolean;
	resolve: (message: BunWorkerToHostMessage) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

function requireSuccess(message: MessageOfType<"result">): asserts message is BunWorkerSuccessResultMessage {
	if (message.status !== "ok") throw new Error(`${message.error.name}: ${message.error.message}`);
	expect(message.status).toBe("ok");
}

function legacyV2ImportSnapshot(name: string, specifier: string): Buffer {
	const data = Buffer.from(specifier, "utf8");
	const header = Buffer.from(
		JSON.stringify({
			entries: [{ kind: "import", length: data.byteLength, name, offset: 0 }],
			version: 2,
		}),
		"utf8",
	);
	const prefix = Buffer.alloc(4);
	prefix.writeUInt32BE(header.byteLength);
	return Buffer.concat([prefix, header, data]);
}

function legacyV3ValueSnapshot(bunPath: string, name: string, expression: string): Buffer {
	const serialized = spawnSync(
		bunPath,
		["-e", `import { serialize } from "bun:jsc"; process.stdout.write(Buffer.from(serialize(${expression})))`],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	if (serialized.error) throw serialized.error;
	if (serialized.status !== 0 || !Buffer.isBuffer(serialized.stdout)) {
		throw new Error(`Failed to create legacy Bun snapshot fixture: ${serialized.stderr.toString("utf8")}`);
	}
	const header = Buffer.from(
		JSON.stringify({ entries: [{ length: serialized.stdout.byteLength, name, offset: 0 }], version: 3 }),
		"utf8",
	);
	const prefix = Buffer.alloc(4);
	prefix.writeUInt32BE(header.byteLength);
	return Buffer.concat([prefix, header, serialized.stdout]);
}

class BunWorkerTestClient {
	readonly messages: BunWorkerToHostMessage[] = [];
	readonly stdout: string[] = [];
	readonly stderr: string[] = [];
	private readonly waiters = new Set<MessageWaiter>();

	private constructor(
		readonly child: ChildProcess,
		private readonly protocolInput: Writable,
		protocolOutput: Readable,
	) {
		let bufferedProtocol = "";
		protocolOutput.setEncoding("utf8");
		protocolOutput.on("data", (chunk: string) => {
			bufferedProtocol += chunk;
			const lines = bufferedProtocol.split("\n");
			bufferedProtocol = lines.pop() ?? "";
			for (const line of lines) {
				if (line.trim()) this.acceptMessage(JSON.parse(line) as BunWorkerToHostMessage);
			}
		});
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.stdout.push(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => this.stderr.push(chunk));
	}

	static start(bunPath: string): BunWorkerTestClient {
		const workerPath = fileURLToPath(new URL("../src/core/kernel/bun-worker.ts", import.meta.url));
		const child = spawn(bunPath, [workerPath], {
			stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
		});
		const protocolInput = child.stdio[3] as Writable | null;
		const protocolOutput = child.stdio[4] as Readable | null;
		if (!protocolInput || !protocolOutput) {
			child.kill("SIGKILL");
			throw new Error("Bun worker protocol pipes were not created");
		}
		return new BunWorkerTestClient(child, protocolInput, protocolOutput);
	}

	send(message: HostToBunWorkerMessage): void {
		this.protocolInput.write(`${JSON.stringify(message)}\n`);
	}

	closeProtocolInput(): void {
		this.protocolInput.end();
	}

	async waitForExit(timeoutMs = 1_000): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Timed out waiting for Bun worker exit")), timeoutMs);
			this.child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	async waitForType<T extends MessageType>(
		type: T,
		predicate: (message: MessageOfType<T>) => boolean = () => true,
	): Promise<MessageOfType<T>> {
		const existing = this.messages.find(
			(message): message is MessageOfType<T> => message.type === type && predicate(message as MessageOfType<T>),
		);
		if (existing) return existing;
		return new Promise<BunWorkerToHostMessage>((resolve, reject) => {
			const waiter: MessageWaiter = {
				predicate: (message) => message.type === type && predicate(message as MessageOfType<T>),
				resolve,
				reject,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					reject(new Error(`Timed out waiting for Bun worker message: ${type}`));
				}, 5_000),
			};
			this.waiters.add(waiter);
		}).then((message) => message as MessageOfType<T>);
	}

	async waitForCellStream(cellId: string, name: "stdout" | "stderr", text: string): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (
			!this.messages.some((message) => {
				const record = message as unknown as Record<string, unknown>;
				return (
					record.type === "stream" &&
					record.cellId === cellId &&
					record.name === name &&
					typeof record.text === "string" &&
					record.text.includes(text)
				);
			})
		) {
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name} stream: ${text}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	async stop(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		this.send({
			id: "shutdown",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "shutdown",
		});
		await Promise.race([
			new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
			new Promise<void>((resolve) =>
				setTimeout(() => {
					this.child.kill("SIGKILL");
					resolve();
				}, 2_000),
			),
		]);
	}

	private acceptMessage(message: BunWorkerToHostMessage): void {
		this.messages.push(message);
		for (const waiter of this.waiters) {
			if (!waiter.predicate(message)) continue;
			clearTimeout(waiter.timer);
			this.waiters.delete(waiter);
			waiter.resolve(message);
		}
	}
}

describe("Bun worker", () => {
	let bunPath: string;
	let client: BunWorkerTestClient;

	beforeEach(async () => {
		const runtime = await resolveBunRuntime();
		bunPath = runtime.path;
		client = BunWorkerTestClient.start(bunPath);
		client.send({
			bunPath: runtime.path,
			commandPrefix: "",
			cwd: process.cwd(),
			id: "initialize",
			kernelDirectory: process.cwd(),
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			shell: { args: ["-c"], executable: "/bin/sh" },
			skillFactoryTimeoutMs: 1_000,
			structuredShellTimeoutMs: 120_000,
			skills: [],
			type: "initialize",
		});
		const ready = await client.waitForType("ready");
		expect(ready.replyTo).toBe("initialize");
		expect(ready.bunVersion).toMatch(/^1\.3\./);
	});

	afterEach(async () => {
		await client.stop();
	});

	it("persists bindings, permits redefinition, and supports top-level await", async () => {
		client.send({
			cellId: "cell-1",
			code: "const state = { count: 2 }; state.count;",
			id: "execute-1",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const first = await client.waitForType("result", (message) => message.replyTo === "execute-1");
		expect(first).toMatchObject({ stateChanged: true, status: "ok", value: "2" });

		client.send({
			cellId: "cell-2",
			code: "await Promise.resolve(); state.count += 3; state.count;",
			id: "execute-2",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const second = await client.waitForType("result", (message) => message.replyTo === "execute-2");
		expect(second).toMatchObject({ status: "ok", value: "5" });

		client.send({
			cellId: "cell-3",
			code: "const state = 9; state;",
			id: "execute-3",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const third = await client.waitForType("result", (message) => message.replyTo === "execute-3");
		expect(third).toMatchObject({ status: "ok", value: "9" });

		client.send({
			id: "names",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "list_names",
		});
		const names = await client.waitForType("list_names_result");
		expect(names.names).toEqual(["state"]);
	});

	it("reconciles direct global mutations only when the namespace is observed", async () => {
		client.send({
			cellId: "namespace-probe-setup",
			code: `
const namespaceProbe = { scans: 0 };
const originalGetOwnPropertyNames = Object.getOwnPropertyNames;
Object.getOwnPropertyNames = (value) => {
	if (value === globalThis) namespaceProbe.scans += 1;
	return originalGetOwnPropertyNames(value);
};
globalThis.discoveredName = 42;
`,
			id: "namespace-probe-setup-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		await client.waitForType("result", (message) => message.replyTo === "namespace-probe-setup-execute");

		client.send({
			cellId: "namespace-probe-ordinary",
			code: "1 + 1;",
			id: "namespace-probe-ordinary-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		await client.waitForType("result", (message) => message.replyTo === "namespace-probe-ordinary-execute");

		client.send({
			cellId: "namespace-probe-count",
			code: "namespaceProbe.scans;",
			id: "namespace-probe-count-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		await expect(
			client.waitForType("result", (message) => message.replyTo === "namespace-probe-count-execute"),
		).resolves.toMatchObject({ status: "ok", value: "0" });

		client.send({
			id: "namespace-probe-first-list",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "list_names",
		});
		const firstNames = await client.waitForType(
			"list_names_result",
			(message) => message.replyTo === "namespace-probe-first-list",
		);
		expect(firstNames.names).toContain("discoveredName");

		client.send({
			cellId: "namespace-probe-delete",
			code: "delete globalThis.discoveredName;",
			id: "namespace-probe-delete-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		await client.waitForType("result", (message) => message.replyTo === "namespace-probe-delete-execute");

		client.send({
			id: "namespace-probe-second-list",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "list_names",
		});
		const secondNames = await client.waitForType(
			"list_names_result",
			(message) => message.replyTo === "namespace-probe-second-list",
		);
		expect(secondNames.names).not.toContain("discoveredName");
	});

	it("executes erasable TypeScript syntax", async () => {
		client.send({
			cellId: "typescript-cell",
			code: 'import type { Stats } from "node:fs"; const typedValue: number = 42; typedValue;',
			id: "typescript-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const result = await client.waitForType("result", (message) => message.replyTo === "typescript-execute");
		expect(result).toMatchObject({ bindingNames: ["typedValue"], status: "ok", value: "42" });
	});

	it("persists conditional return mutations after TypeScript transpilation", async () => {
		client.send({
			cellId: "top-level-return-cell",
			code: `
let returnSeed: number = 20;
returnSeed += 1;
if (returnSeed === 21) {
	return ++returnSeed;
}
const unreachableReturnBinding: number = 99;
`,
			id: "top-level-return-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const returned = await client.waitForType("result", (message) => message.replyTo === "top-level-return-execute");
		expect(returned).toMatchObject({ status: "ok", value: "22" });

		client.send({
			cellId: "top-level-return-persistence-cell",
			code: "({ returnSeed, unreachableType: typeof unreachableReturnBinding });",
			id: "top-level-return-persistence-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const persisted = await client.waitForType(
			"result",
			(message) => message.replyTo === "top-level-return-persistence-execute",
		);
		requireSuccess(persisted);
		expect(persisted.value).toContain("returnSeed: 22");
		expect(persisted.value).toContain('unreachableType: "undefined"');
	});

	it("bounds inspected cell results before writing the protocol frame", async () => {
		client.send({
			cellId: "bounded-result-cell",
			code: '"x".repeat(1_000_000);',
			id: "bounded-result-execute",
			maxResultChars: 64,
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const result = await client.waitForType("result", (message) => message.replyTo === "bounded-result-execute");
		requireSuccess(result);
		expect(result.value?.length).toBeLessThanOrEqual(128);
		expect(result.value).toContain("result truncated at 64 chars");
	});

	it("bounds nested strings and collections before inspecting cell results", async () => {
		for (const [id, code] of [
			["nested-string", '({ nested: { payload: "x".repeat(1_000_000) } });'],
			[
				"nested-collections",
				'({ array: Array.from({ length: 100_000 }, (_, index) => index), map: new Map(Array.from({ length: 100_000 }, (_, index) => [index, "value-" + index])), object: Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => ["key-" + index, index])) });',
			],
		] as const) {
			client.send({
				cellId: `${id}-cell`,
				code,
				id: `${id}-execute`,
				maxResultChars: 512,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});

			const result = await client.waitForType("result", (message) => message.replyTo === `${id}-execute`);
			requireSuccess(result);
			expect(result.value?.length).toBeLessThanOrEqual(576);
			expect(result.value).toMatch(/truncated/i);
		}

		client.send({
			cellId: "post-bounded-collection-cell",
			code: "21 * 2;",
			id: "post-bounded-collection-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		await expect(
			client.waitForType("result", (message) => message.replyTo === "post-bounded-collection-execute"),
		).resolves.toMatchObject({ status: "ok", value: "42" });
	});

	it("preloads common modules with the JavaScript RLM and package APIs", async () => {
		client.send({
			cellId: "runtime-api-cell",
			code: `({
				runtime: typeof rlm,
				harness: typeof rlm.harness.createMemory,
				installPackage: typeof installPackage,
				hostRequest: typeof hostRequest,
				fs: typeof fs.promises.readFile,
				path: path.basename("/a/b"),
				os: typeof os.homedir,
				util: util.format("%s-%d", "ready", 1),
				require: require("node:path").basename("/c/d"),
				webCrypto: crypto === globalThis.crypto,
			});`,
			id: "runtime-api-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const result = await client.waitForType("result", (message) => message.replyTo === "runtime-api-execute");
		requireSuccess(result);
		expect(result.value).toContain('runtime: "function"');
		expect(result.value).toContain('harness: "function"');
		expect(result.value).toContain('installPackage: "function"');
		expect(result.value).toContain('hostRequest: "function"');
		expect(result.value).toContain('fs: "function"');
		expect(result.value).toContain('path: "b"');
		expect(result.value).toContain('os: "function"');
		expect(result.value).toContain('util: "ready-1"');
		expect(result.value).toContain('require: "d"');
		expect(result.value).toContain("webCrypto: true");
	});

	it("exposes await-first filesystem helpers while retaining sync and callback APIs", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-fs-global-"));
		const filePath = join(directory, "README.md");
		try {
			await writeFile(filePath, "filesystem-ready", "utf8");
			client.send({
				cellId: "filesystem-global-cell",
				code: `
const awaited = await fs.readFile(${JSON.stringify(filePath)}, "utf8");
const promised = await fs.promises.readFile(${JSON.stringify(filePath)}, "utf8");
const synchronous = fs.readFileSync(${JSON.stringify(filePath)}, "utf8");
const callback = await new Promise((resolve, reject) => {
	fs.callbacks.readFile(${JSON.stringify(filePath)}, "utf8", (error, value) => {
		if (error) reject(error);
		else resolve(value);
	});
});
({ awaited, promised, synchronous, callback });
`,
				id: "filesystem-global-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});

			const result = await client.waitForType(
				"result",
				(message) => message.replyTo === "filesystem-global-execute",
			);
			requireSuccess(result);
			expect(result.value).toContain('awaited: "filesystem-ready"');
			expect(result.value).toContain('promised: "filesystem-ready"');
			expect(result.value).toContain('synchronous: "filesystem-ready"');
			expect(result.value).toContain('callback: "filesystem-ready"');
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("persists static import bindings across cells", async () => {
		client.send({
			cellId: "static-import-cell",
			code: 'import { basename as importedBasename } from "node:path"; importedBasename("/a/b");',
			id: "static-import-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const imported = await client.waitForType("result", (message) => message.replyTo === "static-import-execute");
		expect(imported).toMatchObject({ status: "ok", value: '"b"' });

		client.send({
			cellId: "static-import-reuse-cell",
			code: 'importedBasename("/c/d");',
			id: "static-import-reuse-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const reused = await client.waitForType("result", (message) => message.replyTo === "static-import-reuse-execute");
		expect(reused).toMatchObject({ status: "ok", value: '"d"' });
	});

	it("keeps common runtime-global shadows cell-local without replacing the prepared globals", async () => {
		client.send({
			cellId: "runtime-collision-cell",
			code: [
				'const fs = require("fs");',
				'const crypto = require("crypto");',
				'const path = "/tmp/write-proof.md";',
				"({",
				'  digest: crypto.createHash("sha256").update("ok").digest("hex"),',
				"  hasWrite: typeof fs.writeFileSync,",
				"  path,",
				"})",
			].join("\n"),
			id: "runtime-collision-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const collision = await client.waitForType(
			"result",
			(message) => message.replyTo === "runtime-collision-execute",
		);
		requireSuccess(collision);
		expect(collision.bindingNames).toEqual([]);
		expect(collision.value).toContain('hasWrite: "function"');
		expect(collision.value).toContain('path: "/tmp/write-proof.md"');
		expect(collision.value).toContain("2689367b205c16ce32ed4200942b8b8b1e");

		client.send({
			cellId: "runtime-collision-check-cell",
			code: `({
				filesystem: "callbacks" in fs,
				basename: path.basename("/still/available"),
				webCrypto: crypto === globalThis.crypto,
			});`,
			id: "runtime-collision-check-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const result = await client.waitForType(
			"result",
			(message) => message.replyTo === "runtime-collision-check-execute",
		);
		requireSuccess(result);
		expect(result.value).toContain("filesystem: true");
		expect(result.value).toContain('basename: "available"');
		expect(result.value).toContain("webCrypto: true");
	});

	it("rejects package names that Bun would parse as command flags", async () => {
		client.send({
			cellId: "install-package-flag-cell",
			code: 'await installPackage("--registry=https://example.test");',
			id: "install-package-flag-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const result = await client.waitForType(
			"result",
			(message) => message.replyTo === "install-package-flag-execute",
		);
		expect(result).toMatchObject({
			error: { message: "installPackage package names cannot start with '-'" },
			status: "error",
		});
	});

	it("continues initialization when JavaScript skill globals collide", async () => {
		await client.stop();
		const runtime = await resolveBunRuntime();
		client = BunWorkerTestClient.start(runtime.path);
		const entryPath = fileURLToPath(new URL("./fixtures/skills/javascript-skill/src/index.ts", import.meta.url));
		client.send({
			bunPath: runtime.path,
			commandPrefix: "",
			cwd: process.cwd(),
			id: "collision-initialize",
			kernelDirectory: process.cwd(),
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			shell: { args: ["-c"], executable: "/bin/sh" },
			skillFactoryTimeoutMs: 1_000,
			structuredShellTimeoutMs: 120_000,
			skills: [
				{ entryPath, globalName: "duplicateSkill", name: "first-skill" },
				{ entryPath, globalName: "duplicateSkill", name: "second-skill" },
			],
			type: "initialize",
		});

		const ready = await client.waitForType("ready", (message) => message.replyTo === "collision-initialize");
		expect(ready.replyTo).toBe("collision-initialize");
		const diagnostic = await client.waitForType("diagnostic");
		expect(diagnostic.error.message).toMatch(/second-skill.*duplicateSkill/i);
		client.send({
			cellId: "collision-cell",
			code: 'await duplicateSkill("still-available");',
			id: "collision-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const result = await client.waitForType("result", (message) => message.replyTo === "collision-execute");
		expect(result).toMatchObject({ status: "ok", value: '"still-available"' });
	});

	it("isolates explicitly unavailable skills without loading their source", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-unavailable-skill-"));
		const unavailableEntryPath = join(directory, "unavailable.ts");
		const loadedMarkerPath = join(directory, "loaded.txt");
		const healthyEntryPath = fileURLToPath(
			new URL("./fixtures/skills/javascript-skill/src/index.ts", import.meta.url),
		);
		try {
			await writeFile(
				unavailableEntryPath,
				`void Bun.write(${JSON.stringify(loadedMarkerPath)}, "loaded"); export default () => "must-not-load";\n`,
			);
			const unavailableReason = `dependency install failed: ${"x".repeat(20_000)}`;
			const runtime = await resolveBunRuntime();
			client.send({
				bunPath: runtime.path,
				commandPrefix: "",
				cwd: process.cwd(),
				id: "unavailable-skill-initialize",
				kernelDirectory: process.cwd(),
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				shell: { args: ["-c"], executable: "/bin/sh" },
				skillFactoryTimeoutMs: 1_000,
				structuredShellTimeoutMs: 120_000,
				skills: [
					{
						entryPath: unavailableEntryPath,
						globalName: "unavailableSkill",
						name: "unavailable-skill",
						unavailableReason,
					},
					{ entryPath: healthyEntryPath, globalName: "healthySibling", name: "healthy-sibling" },
				],
				type: "initialize",
			});

			await client.waitForType("ready", (message) => message.replyTo === "unavailable-skill-initialize");
			const diagnostic = await client.waitForType("diagnostic", (message) =>
				message.error.message.includes("dependency install failed"),
			);
			expect(diagnostic.error.message.length).toBeLessThanOrEqual(1_024);
			client.send({
				cellId: "unavailable-skill-cell",
				code: "await unavailableSkill();",
				id: "unavailable-skill-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			const unavailable = await client.waitForType(
				"result",
				(message) => message.replyTo === "unavailable-skill-execute",
			);
			expect(unavailable).toMatchObject({
				error: { message: expect.stringMatching(/dependency install failed/i) },
				status: "error",
			});
			client.send({
				cellId: "healthy-sibling-cell",
				code: 'await healthySibling("available");',
				id: "healthy-sibling-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			const healthy = await client.waitForType("result", (message) => message.replyTo === "healthy-sibling-execute");
			expect(healthy).toMatchObject({ status: "ok", value: '"available"' });
			await expect(readFile(loadedMarkerPath, "utf8")).rejects.toThrow();
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("tags console and direct stdout/stderr with their originating cell", async () => {
		client.send({
			cellId: "output-cell",
			code: `
console.log('{"type":"ready","replyTo":"fake"}');
process.stdout.write("direct-out\\n");
process.stderr.write("direct-error\\n");
await Bun.write(Bun.stdout, "bun-out\\n");
await Bun.write(Bun.stderr, "bun-error\\n");
42;
`,
			id: "output-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const result = await client.waitForType("result", (message) => message.replyTo === "output-execute");
		await Promise.all([
			client.waitForCellStream("output-cell", "stdout", "direct-out"),
			client.waitForCellStream("output-cell", "stderr", "direct-error"),
			client.waitForCellStream("output-cell", "stdout", "bun-out"),
			client.waitForCellStream("output-cell", "stderr", "bun-error"),
		]);

		expect(result).toMatchObject({ status: "ok", value: "42" });
		expect(client.stdout.join("")).not.toContain('{"type":"ready","replyTo":"fake"}');
		expect(client.messages.filter((message) => message.type === "ready")).toHaveLength(1);
	});

	it("batches synchronous stdout writes before the cell result", async () => {
		client.send({
			cellId: "batched-output-cell",
			code: 'for (let index = 0; index < 10_000; index += 1) process.stdout.write("x");',
			id: "batched-output-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const result = await client.waitForType("result", (message) => message.replyTo === "batched-output-execute");
		const stdoutFrames = client.messages.filter(
			(message): message is Extract<BunWorkerToHostMessage, { type: "stream" }> =>
				message.type === "stream" && message.cellId === "batched-output-cell" && message.name === "stdout",
		);

		expect(stdoutFrames.map((message) => message.text).join("")).toBe("x".repeat(10_000));
		expect(stdoutFrames.every((message) => client.messages.indexOf(message) < client.messages.indexOf(result))).toBe(
			true,
		);
		expect(stdoutFrames.length).toBeLessThanOrEqual(4);
	});

	it("forwards Bun.write createPath options for ordinary files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-write-options-"));
		const filePath = join(directory, "nested", "created.txt");
		try {
			client.send({
				cellId: "bun-write-options-cell",
				code: `await Bun.write(${JSON.stringify(filePath)}, "created", { createPath: false });`,
				id: "bun-write-options-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			const result = await client.waitForType(
				"result",
				(message) => message.replyTo === "bun-write-options-execute",
			);
			expect(result).toMatchObject({ status: "error" });
			await expect(readFile(filePath, "utf8")).rejects.toThrow();
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("reports an unhandled rejection without terminating the worker", async () => {
		client.send({
			cellId: "unhandled-rejection-cell",
			code: `Promise.reject(new Error("detached rejection")); await Bun.sleep(20); 1;`,
			id: "unhandled-rejection-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const diagnostic = await client.waitForType("diagnostic", (message) =>
			message.error.message.includes("detached rejection"),
		);
		expect(diagnostic.cellId).toBe("unhandled-rejection-cell");
		const first = await client.waitForType("result", (message) => message.replyTo === "unhandled-rejection-execute");
		expect(first).toMatchObject({ status: "ok", value: "1" });

		client.send({
			cellId: "post-rejection-cell",
			code: "6 * 7;",
			id: "post-rejection-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const second = await client.waitForType("result", (message) => message.replyTo === "post-rejection-execute");
		expect(second).toMatchObject({ status: "ok", value: "42" });
	});

	it("streams output before a cell completes", async () => {
		client.send({
			cellId: "stream-cell",
			code: `
console.log("before-wait");
await new Promise((resolve) => setTimeout(resolve, 250));
console.log("after-wait");
7;
`,
			id: "stream-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		await client.waitForCellStream("stream-cell", "stdout", "before-wait");
		expect(client.messages.some((message) => message.type === "result" && message.replyTo === "stream-execute")).toBe(
			false,
		);
		const result = await client.waitForType("result", (message) => message.replyTo === "stream-execute");
		expect(result).toMatchObject({ status: "ok", value: "7" });
		await client.waitForCellStream("stream-cell", "stdout", "after-wait");
	});

	it("preserves cwd and environment across cells", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-worker-"));
		try {
			client.send({
				cellId: "environment-1",
				code: `process.chdir(${JSON.stringify(directory)}); process.env.PRIME_BUN_TEST = "yes";`,
				id: "environment-execute-1",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "environment-execute-1");

			client.send({
				cellId: "environment-2",
				code: "({ cwd: process.cwd(), env: process.env.PRIME_BUN_TEST });",
				id: "environment-execute-2",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			const state = await client.waitForType("result", (message) => message.replyTo === "environment-execute-2");
			requireSuccess(state);
			expect(state.value).toContain(directory);
			expect(state.value).toContain("yes");
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("uses the configured shell path and command prefix while exposing Bun Shell", async () => {
		const runtime = await resolveBunRuntime();
		client.send({
			bunPath: runtime.path,
			commandPrefix: "export PRIME_PREFIX=applied",
			cwd: process.cwd(),
			id: "shell-initialize",
			kernelDirectory: process.cwd(),
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			shell: { args: ["-c"], executable: "/bin/sh" },
			skillFactoryTimeoutMs: 1_000,
			structuredShellTimeoutMs: 120_000,
			skills: [],
			type: "initialize",
		});
		await client.waitForType("ready", (message) => message.replyTo === "shell-initialize");

		client.send({
			cellId: "shell-cell",
			code: `
const configured = await sh('printf %s "$PRIME_PREFIX"');
const native = await $\`printf %s bun-shell\`;
({ configured: configured.stdout, native: native.stdout.toString() });
`,
			id: "shell-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const result = await client.waitForType("result", (message) => message.replyTo === "shell-execute");
		requireSuccess(result);
		expect(result.value).toContain('configured: "applied"');
		expect(result.value).toContain('native: "bun-shell"');
	});

	it("accepts a redundant import of the preloaded Bun Shell global", async () => {
		client.send({
			cellId: "redundant-shell-import-cell",
			code: [
				'import { $ } from "bun";',
				"const importedShellResult = await $`printf first-run-ok`.quiet();",
				"importedShellResult.stdout.toString();",
			].join("\n"),
			id: "redundant-shell-import-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const result = await client.waitForType(
			"result",
			(message) => message.replyTo === "redundant-shell-import-execute",
		);
		expect(result).toMatchObject({
			bindingNames: ["importedShellResult"],
			status: "ok",
			value: '"first-run-ok"',
		});

		client.send({
			id: "redundant-shell-import-names",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "list_names",
		});
		const names = await client.waitForType(
			"list_names_result",
			(message) => message.replyTo === "redundant-shell-import-names",
		);
		expect(names.names).toContain("importedShellResult");
		expect(names.names).not.toContain("$");

		client.send({
			cellId: "preloaded-shell-after-import-cell",
			code: [
				"({",
				'  descriptorWritable: Object.getOwnPropertyDescriptor(globalThis, "$")?.writable,',
				"  output: (await $`printf still-preloaded`.quiet()).stdout.toString(),",
				"})",
			].join("\n"),
			id: "preloaded-shell-after-import-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const followingResult = await client.waitForType(
			"result",
			(message) => message.replyTo === "preloaded-shell-after-import-execute",
		);
		requireSuccess(followingResult);
		expect(followingResult.value).toContain('output: "still-preloaded"');
		expect(followingResult.value).toContain("descriptorWritable: false");
	});

	it("accepts redundant destructuring of the preloaded Bun Shell global", async () => {
		client.send({
			cellId: "redundant-shell-global-alias-cell",
			code: [
				"const { $ } = globalThis;",
				"const redundantAliasResult = await $`printf alias-ok`.quiet();",
				"redundantAliasResult.stdout.toString();",
			].join("\n"),
			id: "redundant-shell-global-alias-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const result = await client.waitForType(
			"result",
			(message) => message.replyTo === "redundant-shell-global-alias-execute",
		);
		expect(result).toMatchObject({
			bindingNames: ["redundantAliasResult"],
			status: "ok",
			value: '"alias-ok"',
		});
	});

	it("accepts canonical imports of preloaded Node modules as cell-local bindings", async () => {
		client.send({
			cellId: "redundant-node-import-cell",
			code: [
				'const fs = require("fs");',
				'const path = require("path");',
				'const os = require("os");',
				'const util = require("util");',
				"({",
				'  basename: path.basename("/a/b"),',
				'  nativeFs: !("callbacks" in fs),',
				"  platform: typeof os.platform,",
				'  formatted: util.format("%s-%d", "ready", 1),',
				"})",
			].join("\n"),
			id: "redundant-node-import-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const imported = await client.waitForType(
			"result",
			(message) => message.replyTo === "redundant-node-import-execute",
		);
		requireSuccess(imported);
		expect(imported.bindingNames).toEqual([]);
		expect(imported.value).toContain('basename: "b"');
		expect(imported.value).toContain("nativeFs: true");
		expect(imported.value).toContain('platform: "function"');
		expect(imported.value).toContain('formatted: "ready-1"');

		client.send({
			cellId: "preloaded-node-modules-after-import-cell",
			code: `({
				preloadedFs: "callbacks" in fs,
				fsWritable: Object.getOwnPropertyDescriptor(globalThis, "fs")?.writable,
				pathWritable: Object.getOwnPropertyDescriptor(globalThis, "path")?.writable,
			})`,
			id: "preloaded-node-modules-after-import-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const following = await client.waitForType(
			"result",
			(message) => message.replyTo === "preloaded-node-modules-after-import-execute",
		);
		requireSuccess(following);
		expect(following.value).toContain("preloadedFs: true");
		expect(following.value).toContain("fsWritable: false");
		expect(following.value).toContain("pathWritable: false");
	});

	it("rejects a noncanonical import that shadows the Bun Shell global", async () => {
		client.send({
			cellId: "noncanonical-shell-import-cell",
			code: 'import { spawn as $ } from "bun";',
			id: "noncanonical-shell-import-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const result = await client.waitForType(
			"result",
			(message) => message.replyTo === "noncanonical-shell-import-execute",
		);
		expect(result).toMatchObject({
			error: { message: expect.stringMatching(/\$.*runtime global/i) },
			stateChanged: false,
			status: "error",
		});
	});

	it("supports concise text and JSON shell consumers", async () => {
		client.send({
			cellId: "shell-consumer-cell",
			code: `
const text = await sh("printf shell-text").text();
const data = await sh("printf '{\\"answer\\":42}'").json();
({ text, answer: data.answer });
`,
			id: "shell-consumer-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const result = await client.waitForType("result", (message) => message.replyTo === "shell-consumer-execute");
		requireSuccess(result);
		expect(result.value).toContain('text: "shell-text"');
		expect(result.value).toContain("answer: 42");
	});

	it("accepts Bun Shell-style no-op consumers on the configured shell promise", async () => {
		client.send({
			cellId: "shell-compatibility-cell",
			code: `
const failed = await sh("exit 7").nothrow();
const quietText = await sh("printf quiet").quiet().text();
({ exitCode: failed.exitCode, quietText });
`,
			id: "shell-compatibility-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const result = await client.waitForType("result", (message) => message.replyTo === "shell-compatibility-execute");
		requireSuccess(result);
		expect(result.value).toContain("exitCode: 7");
		expect(result.value).toContain('quietText: "quiet"');
	});

	it("exits when the host closes the protocol input pipe", async () => {
		client.closeProtocolInput();
		await client.waitForExit();
	});

	it("round-trips host requests and emits structured displays", async () => {
		client.send({
			cellId: "host-cell",
			code: `
const response = await __primeHostRequest("test.echo", { value: 42 });
__primeDisplay("application/vnd.prime.test+json", { accepted: true });
response.answer;
`,
			id: "host-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const request = await client.waitForType("host_request");
		expect(request).toMatchObject({
			cellId: "host-cell",
			requestType: "test.echo",
			payload: { value: 42 },
		});
		expect(request.cellSource).toContain("__primeHostRequest");
		client.send({
			id: "host-response",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			requestId: request.requestId,
			type: "host_response",
			value: { answer: "accepted" },
		});

		const display = await client.waitForType("display");
		expect(display).toMatchObject({
			cellId: "host-cell",
			data: { accepted: true },
			mimeType: "application/vnd.prime.test+json",
		});
		const result = await client.waitForType("result", (message) => message.replyTo === "host-execute");
		expect(result).toMatchObject({ status: "ok", value: '"accepted"' });
	});

	it("reports cell errors without poisoning the next execution", async () => {
		client.send({
			cellId: "error-cell",
			code: 'globalThis.workerErrorMutation = 1; throw new TypeError("broken cell");',
			id: "error-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const failed = await client.waitForType("result", (message) => message.replyTo === "error-execute");
		expect(failed).toMatchObject({
			error: { message: "broken cell", name: "TypeError" },
			stateChanged: true,
			status: "error",
		});

		client.send({
			cellId: "recovery-cell",
			code: "6 * 7;",
			id: "recovery-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const recovered = await client.waitForType("result", (message) => message.replyTo === "recovery-execute");
		expect(recovered).toMatchObject({ stateChanged: true, status: "ok", value: "42" });
	});

	it("renders non-Error thrown values with a non-empty traceback", async () => {
		client.send({
			cellId: "non-error-throw-cell",
			code: 'throw "plain failure";',
			id: "non-error-throw-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const failed = await client.waitForType("result", (message) => message.replyTo === "non-error-throw-execute");
		expect(failed).toMatchObject({
			error: { message: "plain failure", name: "Error", stack: "Error: plain failure" },
			stateChanged: true,
			status: "error",
		});
	});

	it("reports parse failures without marking worker state changed", async () => {
		client.send({
			cellId: "parse-error-cell",
			code: "const broken = ;",
			id: "parse-error-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const failed = await client.waitForType("result", (message) => message.replyTo === "parse-error-execute");
		expect(failed).toMatchObject({
			error: { name: "SyntaxError" },
			stateChanged: false,
			status: "error",
		});
		if (failed.status !== "error") throw new Error("Expected a parse failure");
		expect(failed.error.message).toContain("line 1, column");
		expect(failed.error.message).toContain("const broken = ;");
		expect(failed.error.message).not.toContain("array of quoted lines");
		expect(failed.error.stack).toContain("SyntaxError:");
	});

	it("guides recovery when Markdown fences break a template literal", async () => {
		client.send({
			cellId: "fenced-template-error-cell",
			code: [
				"const content = `# Title",
				"```ts",
				"const answer = 42;",
				"```",
				"`;",
				'await fs.writeFile("/tmp/ignored.md", content);',
			].join("\n"),
			id: "fenced-template-error-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const failed = await client.waitForType(
			"result",
			(message) => message.replyTo === "fenced-template-error-execute",
		);
		expect(failed).toMatchObject({
			error: { name: "SyntaxError" },
			stateChanged: false,
			status: "error",
		});
		if (failed.status !== "error") throw new Error("Expected a fenced-template parse failure");
		expect(failed.error.message).toContain("line 2, column 4");
		expect(failed.error.message).toContain("```ts");
		expect(failed.error.message).toContain("This cell was not executed");
		expect(failed.error.message).toContain("`write_file` tool or a structured `write` action");
		expect(failed.error.message).toContain("content stays outside JavaScript syntax");
		expect(failed.error.message).not.toContain("array of quoted lines");
		expect(failed.error.stack).toContain("SyntaxError:");
		expect(failed.error.stack).toContain("line 2, column 4");
	});

	it("guides structured recovery for the reproduced missing-quote report write", async () => {
		client.send({
			cellId: "report-write-error-cell",
			code: [
				"const report = [",
				"  '# Report',",
				"  '| Activity | Owner |",
				"  '|----------|:-----:|",
				"  '| Publish | **R** |",
				"].join('\\n');",
				'await fs.writeFile("/tmp/ignored-report.md", report);',
			].join("\n"),
			id: "report-write-error-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const failed = await client.waitForType("result", (message) => message.replyTo === "report-write-error-execute");
		expect(failed).toMatchObject({ error: { name: "SyntaxError" }, stateChanged: false, status: "error" });
		if (failed.status !== "error") throw new Error("Expected a report parse failure");
		expect(failed.error.message).toContain("This cell was not executed");
		expect(failed.error.message).toContain("do not repair JavaScript string escaping");
		expect(failed.error.message).toContain("`write_file` tool or a structured `write` action");
		expect(failed.error.message).not.toContain("array of quoted lines");
	});

	it("bounds source excerpts for parse failures on long lines", async () => {
		client.send({
			cellId: "long-parse-error-cell",
			code: `const longValue = "${"x".repeat(2_000)}"; const broken = ;`,
			id: "long-parse-error-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const failed = await client.waitForType("result", (message) => message.replyTo === "long-parse-error-execute");
		if (failed.status !== "error") throw new Error("Expected a long-line parse failure");
		expect(failed.error.message).toContain("…");
		expect(failed.error.message).toContain("const broken = ;");
		expect(failed.error.message.length).toBeLessThan(1_200);
	});

	it("snapshots supported bindings independently and restores them", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-snapshot-"));
		const path = join(directory, "state.bin");
		const manifestPath = join(directory, "state.json");
		try {
			client.send({
				cellId: "snapshot-source",
				code: `
import { basename as staticBasename } from "node:path";
const plain = { count: 1, nested: new Map([["key", new Set([2, 3])]]) };
class Custom { constructor() { this.value = 4; } }
const custom = new Custom();
const callable = () => 5;
const pathModule = await import("node:path");
const { join: selectedJoin } = await import("node:path");
const requiredPath = require("node:path");
const { extname: requiredExtname } = require("node:path");
globalThis.explicitValue = 40;
plain.count;
`,
				id: "snapshot-source-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			const sourceResult = await client.waitForType(
				"result",
				(message) => message.replyTo === "snapshot-source-execute",
			);
			requireSuccess(sourceResult);

			client.send({
				id: "snapshot",
				includeRuntimeState: false,
				manifestPath,
				maxBytes: 1024 * 1024,
				path,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "snapshot",
			});
			const snapshot = await client.waitForType("snapshot_result");
			expect(snapshot).toMatchObject({
				replyTo: "snapshot",
				saved: expect.arrayContaining([
					"Custom",
					"callable",
					"explicitValue",
					"pathModule",
					"plain",
					"requiredPath",
					"requiredExtname",
					"selectedJoin",
					"staticBasename",
				]),
			});
			expect(snapshot.skipped.map((entry) => entry.name)).toContain("custom");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
				bunVersion: string;
				savedNames: string[];
				version: number;
			};
			expect(manifest.savedNames).toEqual(
				expect.arrayContaining(["Custom", "callable", "explicitValue", "pathModule", "plain"]),
			);
			expect(manifest.bunVersion).toMatch(/^1\.3\./);
			expect(manifest.version).toBe(4);

			client.send({
				cellId: "snapshot-mutation",
				code: `
plain.count = 99;
delete globalThis.explicitValue;
pathModule = undefined;
selectedJoin = undefined;
requiredPath = undefined;
requiredExtname = undefined;
staticBasename = undefined;
plain.count;
`,
				id: "snapshot-mutation-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "snapshot-mutation-execute");
			client.send({
				id: "restore",
				path,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "restore",
			});
			const restore = await client.waitForType("restore_result");
			expect(restore).toMatchObject({
				failed: [],
				replyTo: "restore",
				restored: expect.arrayContaining(["Custom", "callable", "explicitValue", "pathModule", "plain"]),
			});

			client.send({
				cellId: "snapshot-check",
				code: `({
					count: plain.count,
					called: callable(),
					custom: new Custom().value,
					explicitValue,
					basename: pathModule.basename("/a/b"),
					selected: selectedJoin("a", "b"),
					required: requiredPath.basename("/c/d"),
					requiredSelected: requiredExtname("archive.tar.gz"),
					static: staticBasename("/e/f"),
				});`,
				id: "snapshot-check-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			const result = await client.waitForType("result", (message) => message.replyTo === "snapshot-check-execute");
			requireSuccess(result);
			expect(result.value).toContain("count: 1");
			expect(result.value).toContain("called: 5");
			expect(result.value).toContain("custom: 4");
			expect(result.value).toContain("explicitValue: 40");
			expect(result.value).toContain('basename: "b"');
			expect(result.value).toContain('selected: "a/b"');
			expect(result.value).toContain('required: "d"');
			expect(result.value).toContain('requiredSelected: ".gz"');
			expect(result.value).toContain('static: "f"');
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("restores a large shared typed array after checkpoint buffer cleanup", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-large-snapshot-"));
		const path = join(directory, "state.bin");
		const manifestPath = join(directory, "state.json");
		try {
			client.send({
				cellId: "large-snapshot-source",
				code: `
const largeSnapshotValue = new Uint8Array(9 * 1024 * 1024);
largeSnapshotValue[0] = 17;
largeSnapshotValue[largeSnapshotValue.length - 1] = 239;
const largeSnapshotAlias = largeSnapshotValue;
`,
				id: "large-snapshot-source-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "large-snapshot-source-execute");

			client.send({
				id: "large-snapshot",
				includeRuntimeState: false,
				manifestPath,
				maxBytes: 20 * 1024 * 1024,
				path,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "snapshot",
			});
			const snapshot = await client.waitForType(
				"snapshot_result",
				(message) => message.replyTo === "large-snapshot",
			);
			expect(snapshot).toMatchObject({
				saved: expect.arrayContaining(["largeSnapshotAlias", "largeSnapshotValue"]),
				skipped: [],
			});
			expect(snapshot.bytes).toBeGreaterThanOrEqual(9 * 1024 * 1024);

			client.send({
				cellId: "large-snapshot-mutation",
				code: "largeSnapshotValue.fill(0);",
				id: "large-snapshot-mutation-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "large-snapshot-mutation-execute");
			client.send({
				id: "large-snapshot-restore",
				path,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "restore",
			});
			await expect(
				client.waitForType("restore_result", (message) => message.replyTo === "large-snapshot-restore"),
			).resolves.toMatchObject({ failed: [] });

			client.send({
				cellId: "large-snapshot-check",
				code: `[
					largeSnapshotValue[0],
					largeSnapshotValue[largeSnapshotValue.length - 1],
					largeSnapshotValue === largeSnapshotAlias,
					largeSnapshotValue.length,
				];`,
				id: "large-snapshot-check-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await expect(
				client.waitForType("result", (message) => message.replyTo === "large-snapshot-check-execute"),
			).resolves.toMatchObject({ status: "ok", value: "[ 17, 239, true, 9437184 ]" });
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("writes runtime recovery and runtime-free persistence from one snapshot request", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-mirrored-snapshot-"));
		const recoveryPath = join(directory, "recovery.bin");
		const recoveryManifestPath = join(directory, "recovery.json");
		const persistentPath = join(directory, "persistent.bin");
		const persistentManifestPath = join(directory, "persistent.json");
		try {
			client.send({
				cellId: "mirrored-snapshot-source",
				code: `const mirroredValue = { count: 42 }; process.env.PRIME_MIRROR_SECRET = "private";`,
				id: "mirrored-snapshot-source-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "mirrored-snapshot-source-execute");

			client.send({
				id: "mirrored-snapshot",
				includeRuntimeState: true,
				manifestPath: recoveryManifestPath,
				maxBytes: 1024 * 1024,
				path: recoveryPath,
				persistentMirror: { manifestPath: persistentManifestPath, path: persistentPath },
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "snapshot",
			} as HostToBunWorkerMessage);
			const snapshot = await client.waitForType(
				"snapshot_result",
				(message) => message.replyTo === "mirrored-snapshot",
			);
			const mirror = (
				snapshot as typeof snapshot & {
					persistentMirror?: { bytes: number; error?: string; path: string };
				}
			).persistentMirror;
			expect(mirror).toMatchObject({ path: persistentPath });
			expect(mirror?.error).toBeUndefined();
			expect(mirror?.bytes).toBeGreaterThan(0);

			const recoveryEntries = decodeSnapshotPayload(await readFile(recoveryPath));
			const persistentEntries = decodeSnapshotPayload(await readFile(persistentPath));
			expect(recoveryEntries.some((entry) => entry.kind === "runtime")).toBe(true);
			expect(persistentEntries.some((entry) => entry.kind === "runtime")).toBe(false);
			expect(recoveryEntries.some((entry) => entry.kind === "bindings")).toBe(true);
			expect(persistentEntries.some((entry) => entry.kind === "bindings")).toBe(true);
			expect(await readFile(persistentPath, "utf8")).not.toContain("PRIME_MIRROR_SECRET");
		} finally {
			delete process.env.PRIME_MIRROR_SECRET;
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("isolates an uncloneable binding and validates its aliases once", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-uncloneable-snapshot-"));
		const path = join(directory, "state.bin");
		const manifestPath = join(directory, "state.json");
		try {
			client.send({
				cellId: "uncloneable-snapshot-source",
				code: `
const proxyInspectionState = { count: 0 };
const safeSnapshotSibling = { count: 42 };
const sharedSnapshotProxy = new Proxy({}, {
	getPrototypeOf(target) {
		proxyInspectionState.count += 1;
		return Reflect.getPrototypeOf(target);
	}
});
const snapshotProxyAlias = sharedSnapshotProxy;
`,
				id: "uncloneable-snapshot-source-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "uncloneable-snapshot-source-execute");

			client.send({
				id: "uncloneable-snapshot",
				includeRuntimeState: false,
				manifestPath,
				maxBytes: 1024 * 1024,
				path,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "snapshot",
			});
			const snapshot = await client.waitForType(
				"snapshot_result",
				(message) => message.replyTo === "uncloneable-snapshot",
			);
			expect(snapshot.saved).toContain("safeSnapshotSibling");
			expect(snapshot.skipped).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "sharedSnapshotProxy" }),
					expect.objectContaining({ name: "snapshotProxyAlias" }),
				]),
			);

			client.send({
				cellId: "uncloneable-snapshot-mutate",
				code: "safeSnapshotSibling.count = 0;",
				id: "uncloneable-snapshot-mutate-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "uncloneable-snapshot-mutate-execute");
			client.send({
				id: "uncloneable-snapshot-restore",
				path,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "restore",
			});
			await expect(
				client.waitForType("restore_result", (message) => message.replyTo === "uncloneable-snapshot-restore"),
			).resolves.toMatchObject({ restored: expect.arrayContaining(["safeSnapshotSibling"]) });

			client.send({
				cellId: "uncloneable-snapshot-check",
				code: "safeSnapshotSibling.count === 42 && proxyInspectionState.count > 0 && proxyInspectionState.count < 20;",
				id: "uncloneable-snapshot-check-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await expect(
				client.waitForType("result", (message) => message.replyTo === "uncloneable-snapshot-check-execute"),
			).resolves.toMatchObject({ status: "ok", value: "true" });
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("skips every root into a cyclic graph with an unsafe descendant", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-unsafe-cycle-snapshot-"));
		const path = join(directory, "state.bin");
		const manifestPath = join(directory, "state.json");
		try {
			client.send({
				cellId: "unsafe-cycle-source",
				code: `
class UnsafeCycleValue { constructor() { this.value = 1; } }
const cycleA = {};
const cycleB = { back: cycleA };
cycleA.child = cycleB;
cycleA.unsafe = new UnsafeCycleValue();
`,
				id: "unsafe-cycle-source-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "unsafe-cycle-source-execute");

			client.send({
				id: "unsafe-cycle-snapshot",
				includeRuntimeState: false,
				manifestPath,
				maxBytes: 1024 * 1024,
				path,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "snapshot",
			});
			const snapshot = await client.waitForType(
				"snapshot_result",
				(message) => message.replyTo === "unsafe-cycle-snapshot",
			);
			expect(snapshot.skipped).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "cycleA" }),
					expect.objectContaining({ name: "cycleB" }),
				]),
			);
			expect(snapshot.saved).not.toContain("cycleA");
			expect(snapshot.saved).not.toContain("cycleB");
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("keeps small bindings when a larger binding exceeds the snapshot cap", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-mixed-cap-snapshot-"));
		const path = join(directory, "state.bin");
		const manifestPath = join(directory, "state.json");
		try {
			client.send({
				cellId: "mixed-cap-source",
				code: 'let overCapBinding = "x".repeat(16 * 1024); let underCapBinding = 42;',
				id: "mixed-cap-source-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "mixed-cap-source-execute");
			await writeFile(path, "previous persistent snapshot");

			client.send({
				id: "mixed-cap-snapshot",
				includeRuntimeState: false,
				manifestPath,
				maxBytes: 1024,
				path,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "snapshot",
			});
			const snapshot = await client.waitForType(
				"snapshot_result",
				(message) => message.replyTo === "mixed-cap-snapshot",
			);
			expect(snapshot.saved).toContain("underCapBinding");
			expect(snapshot.skipped).toEqual([
				expect.objectContaining({ name: "overCapBinding", reason: "exceeds snapshot size cap" }),
			]);
			expect(decodeSnapshotPayload(await readFile(path)).some((entry) => entry.kind === "bindings")).toBe(true);

			client.send({
				cellId: "mixed-cap-mutate",
				code: "underCapBinding = 0;",
				id: "mixed-cap-mutate-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "mixed-cap-mutate-execute");
			client.send({
				id: "mixed-cap-restore",
				path,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "restore",
			});
			await expect(
				client.waitForType("restore_result", (message) => message.replyTo === "mixed-cap-restore"),
			).resolves.toMatchObject({ restored: ["underCapBinding"] });
			client.send({
				cellId: "mixed-cap-check",
				code: "underCapBinding;",
				id: "mixed-cap-check-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await expect(
				client.waitForType("result", (message) => message.replyTo === "mixed-cap-check-execute"),
			).resolves.toMatchObject({ status: "ok", value: "42" });
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("restores namespace imports from a hand-built v2 snapshot", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-v2-snapshot-"));
		const path = join(directory, "state.bin");
		try {
			await writeFile(path, legacyV2ImportSnapshot("legacyPath", "node:path"));
			client.send({
				id: "legacy-v2-restore",
				path,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "restore",
			});
			const restore = await client.waitForType(
				"restore_result",
				(message) => message.replyTo === "legacy-v2-restore",
			);
			expect(restore).toMatchObject({ failed: [], restored: ["legacyPath"] });

			client.send({
				cellId: "legacy-v2-check-cell",
				code: 'legacyPath.basename("/legacy/file");',
				id: "legacy-v2-check-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			const result = await client.waitForType("result", (message) => message.replyTo === "legacy-v2-check-execute");
			expect(result).toMatchObject({ status: "ok", value: '"file"' });
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("restores ordinary bindings from a hand-built v3 snapshot", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-v3-snapshot-"));
		const path = join(directory, "state.bin");
		try {
			await writeFile(path, legacyV3ValueSnapshot(bunPath, "legacyV3State", "{ count: 42 }"));
			client.send({
				id: "legacy-v3-restore",
				path,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "restore",
			});
			await expect(
				client.waitForType("restore_result", (message) => message.replyTo === "legacy-v3-restore"),
			).resolves.toMatchObject({ failed: [], restored: ["legacyV3State"] });

			client.send({
				cellId: "legacy-v3-check-cell",
				code: "legacyV3State.count;",
				id: "legacy-v3-check-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await expect(
				client.waitForType("result", (message) => message.replyTo === "legacy-v3-check-execute"),
			).resolves.toMatchObject({ status: "ok", value: "42" });
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("reserves the snapshot cap for cwd and environment recovery before user bindings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-runtime-cap-"));
		const probePath = join(directory, "probe.bin");
		const probeManifestPath = join(directory, "probe.json");
		const boundaryPath = join(directory, "boundary.bin");
		const boundaryManifestPath = join(directory, "boundary.json");
		try {
			const canonicalDirectory = await realpath(directory);
			client.send({
				cellId: "runtime-cap-setup-cell",
				code: `process.chdir(${JSON.stringify(directory)}); process.env.PRIME_RUNTIME_CAP = "retained";`,
				id: "runtime-cap-setup-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "runtime-cap-setup-execute");
			client.send({
				id: "runtime-cap-probe",
				includeRuntimeState: true,
				manifestPath: probeManifestPath,
				maxBytes: 1024 * 1024,
				path: probePath,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "snapshot",
			});
			await client.waitForType("snapshot_result", (message) => message.replyTo === "runtime-cap-probe");
			const runtimeEntry = decodeSnapshotPayload(await readFile(probePath)).find(
				(entry) => entry.kind === "runtime",
			);
			expect(runtimeEntry).toBeDefined();
			if (!runtimeEntry) return;

			client.send({
				cellId: "runtime-cap-binding-cell",
				code: `const boundaryBinding = "x".repeat(${Math.max(1, Math.floor(runtimeEntry.data.byteLength / 2))});`,
				id: "runtime-cap-binding-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "runtime-cap-binding-execute");
			client.send({
				id: "runtime-cap-boundary",
				includeRuntimeState: true,
				manifestPath: boundaryManifestPath,
				maxBytes: runtimeEntry.data.byteLength,
				path: boundaryPath,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "snapshot",
			});
			const boundary = await client.waitForType(
				"snapshot_result",
				(message) => message.replyTo === "runtime-cap-boundary",
			);
			expect(boundary.error).toBeUndefined();
			expect(boundary.saved).not.toContain("boundaryBinding");
			expect(boundary.skipped).toEqual(
				expect.arrayContaining([expect.objectContaining({ name: "boundaryBinding" })]),
			);
			expect(boundary.skipped.map(({ name }) => name)).not.toContain("\0prime:runtime");

			client.send({
				cellId: "runtime-cap-mutate-cell",
				code: `process.chdir(${JSON.stringify(process.cwd())}); delete process.env.PRIME_RUNTIME_CAP;`,
				id: "runtime-cap-mutate-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "runtime-cap-mutate-execute");
			client.send({
				id: "runtime-cap-restore",
				path: boundaryPath,
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "restore",
			});
			await client.waitForType("restore_result", (message) => message.replyTo === "runtime-cap-restore");
			client.send({
				cellId: "runtime-cap-check-cell",
				code: `({ cwd: process.cwd(), retained: process.env.PRIME_RUNTIME_CAP });`,
				id: "runtime-cap-check-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			const restored = await client.waitForType(
				"result",
				(message) => message.replyTo === "runtime-cap-check-execute",
			);
			requireSuccess(restored);
			expect(restored.value).toContain(`cwd: ${JSON.stringify(canonicalDirectory)}`);
			expect(restored.value).toContain('retained: "retained"');
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("rejects overlapping executions", async () => {
		client.send({
			cellId: "slow-cell",
			code: "await new Promise((resolve) => setTimeout(resolve, 100)); 1;",
			id: "slow-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		client.send({
			cellId: "overlap-cell",
			code: "2;",
			id: "overlap-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const overlap = await client.waitForType("result", (message) => message.replyTo === "overlap-execute");
		expect(overlap).toMatchObject({
			error: { message: "Bun worker is already executing a cell", name: "BusyError" },
			status: "error",
		});
		const slow = await client.waitForType("result", (message) => message.replyTo === "slow-execute");
		expect(slow).toMatchObject({ status: "ok", value: "1" });
	});
});
