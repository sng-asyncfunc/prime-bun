import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
	let client: BunWorkerTestClient;

	beforeEach(async () => {
		const runtime = await resolveBunRuntime();
		client = BunWorkerTestClient.start(runtime.path);
		client.send({
			bunPath: runtime.path,
			commandPrefix: "",
			cwd: process.cwd(),
			id: "initialize",
			kernelDirectory: process.cwd(),
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			shellPath: "/bin/sh",
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
		expect(first).toMatchObject({ status: "ok", value: "2" });

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

	it("executes erasable TypeScript syntax", async () => {
		client.send({
			cellId: "typescript-cell",
			code: "const typedValue: number = 42; typedValue;",
			id: "typescript-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});

		const result = await client.waitForType("result", (message) => message.replyTo === "typescript-execute");
		expect(result).toMatchObject({ status: "ok", value: "42" });
	});

	it("exposes the JavaScript RLM and package installation APIs", async () => {
		client.send({
			cellId: "runtime-api-cell",
			code: "({ rlm: typeof rlm, harness: typeof rlm.harness.createMemory, installPackage: typeof installPackage, hostRequest: typeof hostRequest });",
			id: "runtime-api-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const result = await client.waitForType("result", (message) => message.replyTo === "runtime-api-execute");
		requireSuccess(result);
		expect(result.value).toContain('rlm: "function"');
		expect(result.value).toContain('harness: "function"');
		expect(result.value).toContain('installPackage: "function"');
		expect(result.value).toContain('hostRequest: "function"');
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
			shellPath: "/bin/sh",
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
			shellPath: "/bin/sh",
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
			code: 'throw new TypeError("broken cell");',
			id: "error-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const failed = await client.waitForType("result", (message) => message.replyTo === "error-execute");
		expect(failed).toMatchObject({
			error: { message: "broken cell", name: "TypeError" },
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
		expect(recovered).toMatchObject({ status: "ok", value: "42" });
	});

	it("snapshots supported bindings independently and restores them", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prime-bun-snapshot-"));
		const path = join(directory, "state.bin");
		const manifestPath = join(directory, "state.json");
		try {
			client.send({
				cellId: "snapshot-source",
				code: `
const plain = { count: 1, nested: new Map([["key", new Set([2, 3])]]) };
class Custom { constructor() { this.value = 4; } }
const custom = new Custom();
const callable = () => 5;
const pathModule = await import("node:path");
globalThis.explicitValue = 40;
plain.count;
`,
				id: "snapshot-source-execute",
				protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
				type: "execute",
			});
			await client.waitForType("result", (message) => message.replyTo === "snapshot-source-execute");

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
				saved: expect.arrayContaining(["Custom", "callable", "explicitValue", "pathModule", "plain"]),
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
			expect(manifest.version).toBe(2);

			client.send({
				cellId: "snapshot-mutation",
				code: "plain.count = 99; delete globalThis.explicitValue; plain.count;",
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
				code: `({ count: plain.count, called: callable(), custom: new Custom().value, explicitValue, basename: pathModule.basename("/a/b") });`,
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
