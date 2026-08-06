import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
	expect(message.status).toBe("ok");
	if (message.status !== "ok") throw new Error(message.error.message);
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

	async waitForOutput(stream: "stdout" | "stderr", text: string): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (!this[stream].join("").includes(text)) {
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${stream}: ${text}`);
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
			commandPrefix: "",
			cwd: process.cwd(),
			id: "initialize",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			shellPath: "/bin/sh",
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

	it("keeps protocol framing separate from direct stdout and stderr", async () => {
		client.send({
			cellId: "output-cell",
			code: `
console.log('{"type":"ready","replyTo":"fake"}');
process.stdout.write("direct-out\\n");
process.stderr.write("direct-error\\n");
42;
`,
			id: "output-execute",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			type: "execute",
		});
		const result = await client.waitForType("result", (message) => message.replyTo === "output-execute");
		await Promise.all([client.waitForOutput("stdout", "direct-out"), client.waitForOutput("stderr", "direct-error")]);

		expect(result).toMatchObject({ status: "ok", value: "42" });
		expect(client.stdout.join("")).toContain('{"type":"ready","replyTo":"fake"}');
		expect(client.messages.filter((message) => message.type === "ready")).toHaveLength(1);
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

		await client.waitForOutput("stdout", "before-wait");
		expect(client.messages.some((message) => message.type === "result" && message.replyTo === "stream-execute")).toBe(
			false,
		);
		const result = await client.waitForType("result", (message) => message.replyTo === "stream-execute");
		expect(result).toMatchObject({ status: "ok", value: "7" });
		await client.waitForOutput("stdout", "after-wait");
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
		client.send({
			commandPrefix: "export PRIME_PREFIX=applied",
			cwd: process.cwd(),
			id: "shell-initialize",
			protocolVersion: BUN_WORKER_PROTOCOL_VERSION,
			shellPath: "/bin/sh",
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
