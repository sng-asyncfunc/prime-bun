import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

const RUNTIME_DIR = path.resolve(import.meta.dir, "..");
const REPL_ENTRY = path.join(RUNTIME_DIR, "src", "repl.ts");

interface ReplClient {
	proc: ChildProcess;
	events: Array<Record<string, unknown>>;
	send(req: Record<string, unknown>): void;
	waitForEvent(
		predicate: (event: Record<string, unknown>) => boolean,
		timeoutMs?: number,
	): Promise<Record<string, unknown>>;
	exec(id: string, code: string, timeoutMs?: number): Promise<Array<Record<string, unknown>>>;
	close(): Promise<void>;
}

const activeClients: ReplClient[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix = "prime-repl-test-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function startRepl(extraEnv: Record<string, string> = {}): Promise<{ client: ReplClient; ready: Record<string, unknown> }> {
	const proc = spawn(process.execPath, ["run", REPL_ENTRY], {
		cwd: RUNTIME_DIR,
		env: { ...process.env, ...extraEnv },
		stdio: ["pipe", "pipe", "pipe"],
	});

	const events: Array<Record<string, unknown>> = [];
	const waiters: Array<{
		predicate: (e: Record<string, unknown>) => boolean;
		resolve: (e: Record<string, unknown>) => void;
	}> = [];

	const rl = createInterface({ input: proc.stdout!, crlfDelay: Number.POSITIVE_INFINITY });
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		events.push(parsed);
		for (let i = waiters.length - 1; i >= 0; i -= 1) {
			if (waiters[i]!.predicate(parsed)) {
				const w = waiters.splice(i, 1)[0]!;
				w.resolve(parsed);
			}
		}
	});

	const waitForEvent = (
		predicate: (e: Record<string, unknown>) => boolean,
		timeoutMs = 10_000,
	): Promise<Record<string, unknown>> => {
		const existing = events.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = waiters.findIndex((w) => w.resolve === onMatch);
				if (idx >= 0) waiters.splice(idx, 1);
				reject(new Error(`Timed out waiting for event after ${timeoutMs}ms; seen=${JSON.stringify(events.slice(-10))}`));
			}, timeoutMs);
			const onMatch = (e: Record<string, unknown>) => {
				clearTimeout(timer);
				resolve(e);
			};
			waiters.push({ predicate, resolve: onMatch });
		});
	};

	const send = (req: Record<string, unknown>): void => {
		proc.stdin!.write(`${JSON.stringify(req)}\n`);
	};

	const exec = async (id: string, code: string, timeoutMs = 10_000): Promise<Array<Record<string, unknown>>> => {
		const startIdx = events.length;
		send({ type: "execute", id, code });
		await waitForEvent((e) => e.event === "done" && e.id === id, timeoutMs);
		return events.slice(startIdx);
	};

	const close = async (): Promise<void> => {
		if (proc.exitCode === null) {
			try {
				send({ type: "shutdown", id: `shutdown-${Date.now()}` });
			} catch {
				// ignore
			}
			await Promise.race([
				new Promise<void>((resolve) => proc.once("exit", () => resolve())),
				new Promise<void>((resolve) =>
					setTimeout(() => {
						proc.kill("SIGKILL");
						resolve();
					}, 3000),
				),
			]);
		}
		rl.close();
	};

	const client: ReplClient = { proc, events, send, waitForEvent, exec, close };
	activeClients.push(client);
	const ready = await waitForEvent((e) => e.event === "ready");
	return { client, ready };
}

afterEach(async () => {
	while (activeClients.length > 0) {
		await activeClients.pop()!.close();
	}
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("Protocol v3 REPL E2E", () => {
	test("emits ready handshake with protocol 3 and bun version first", async () => {
		const { client, ready } = await startRepl();
		expect(client.events[0]).toEqual(ready);
		expect(ready.event).toBe("ready");
		expect(ready.protocol).toBe(3);
		expect(ready.bun).toBe(Bun.version);
	});

	test("executes JS/TS, persists bindings, static imports, top-level return, and preloaded globals", async () => {
		const { client } = await startRepl();

		// TypeScript annotation + persistent binding + trailing expression
		const ev1 = await client.exec("c1", "const answer: number = 40 + 2;\nanswer");
		expect(ev1.find((e) => e.event === "result")?.text).toBe("42");
		expect(ev1.find((e) => e.event === "done")?.status).toBe("ok");

		// Persistent binding across cells + `_` binding
		const ev2 = await client.exec("c2", "answer + _");
		expect(ev2.find((e) => e.event === "result")?.text).toBe("84");

		// Static import persists across cells
		const ev3 = await client.exec("c3", 'import { basename } from "node:path";\nbasename("/a/b/c.txt")');
		expect(ev3.find((e) => e.event === "result")?.text).toContain("c.txt");
		const ev4 = await client.exec("c4", 'basename("/x/y.js")');
		expect(ev4.find((e) => e.event === "result")?.text).toContain("y.js");

		// Top-level return persists earlier bindings
		const ev5 = await client.exec("c5", "const early = 123;\nif (true) return early + 1;\n999");
		expect(ev5.find((e) => e.event === "result")?.text).toBe("124");
		const ev6 = await client.exec("c6", "early");
		expect(ev6.find((e) => e.event === "result")?.text).toBe("123");

		// Preloaded globals: fs, path, os, util, $, rlm, mcp, bash, sh
		const ev7 = await client.exec(
			"c7",
			'({ hasFs: typeof fs.readFile === "function" && typeof fs.readFileSync === "function", hasPath: typeof path.join === "function", hasOs: typeof os.homedir === "function", hasUtil: typeof util.inspect === "function", hasDollar: typeof $ === "function", hasBash: typeof bash === "function", hasSh: typeof sh === "function", hasRlm: typeof rlm.spawn === "function", hasMcp: typeof mcp.listTools === "function" })',
		);
		const res7 = String(ev7.find((e) => e.event === "result")?.text ?? "");
		expect(res7).toContain("hasFs: true");
		expect(res7).toContain("hasPath: true");
		expect(res7).toContain("hasOs: true");
		expect(res7).toContain("hasUtil: true");
		expect(res7).toContain("hasDollar: true");
		expect(res7).toContain("hasBash: true");
		expect(res7).toContain("hasSh: true");
		expect(res7).toContain("hasRlm: true");
		expect(res7).toContain("hasMcp: true");

		// list_names returns sorted user bindings only
		client.send({ type: "list_names", id: "ln1" });
		const lnDone = await client.waitForEvent((e) => e.event === "done" && e.id === "ln1");
		expect(lnDone.status).toBe("ok");
		expect(lnDone.names).toEqual(["answer", "basename", "early"]);
	});

	test("attributes stdout/stderr from console, process.stdout, Bun.write, and detached async tasks", async () => {
		const { client } = await startRepl();
		const ev = await client.exec(
			"stream1",
			'console.log("hello console");\n' +
				'console.error("err console");\n' +
				'process.stdout.write("raw proc\\n");\n' +
				'await Bun.write(Bun.stdout, "bun stdout\\n");\n' +
				'setTimeout(() => console.log("detached from stream1"), 20);\n',
		);
		const stdout = ev
			.filter((e) => e.event === "stdout" && e.id === "stream1")
			.map((e) => String(e.text))
			.join("");
		const stderr = ev
			.filter((e) => e.event === "stderr" && e.id === "stream1")
			.map((e) => String(e.text))
			.join("");
		expect(stdout).toContain("hello console");
		expect(stdout).toContain("raw proc");
		expect(stdout).toContain("bun stdout");
		expect(stderr).toContain("err console");

		// Detached task keeps originating cellId!
		const late = await client.waitForEvent(
			(e) => e.event === "stdout" && e.id === "stream1" && String(e.text).includes("detached from stream1"),
		);
		expect(late.id).toBe("stream1");
	});

	test("handles interrupt of active awaited cell and continues serving", async () => {
		const { client } = await startRepl();
		client.send({ type: "execute", id: "slow1", code: "await new Promise((r) => setTimeout(r, 10_000));" });
		await new Promise((r) => setTimeout(r, 50));
		client.send({ type: "interrupt", id: "slow1" });

		const errEvt = await client.waitForEvent((e) => e.event === "error" && e.id === "slow1");
		expect(errEvt.ename).toBe("InterruptError");
		const doneEvt = await client.waitForEvent((e) => e.event === "done" && e.id === "slow1");
		expect(doneEvt.status).toBe("error");

		// Runtime keeps serving after interrupt
		const ev2 = await client.exec("after1", "2 + 3");
		expect(ev2.find((e) => e.event === "result")?.text).toBe("5");
	});

	test("snapshot, prune_oversized, and restore across fresh worker", async () => {
		const dir = makeTempDir();
		const snapPath = path.join(dir, "kernel-state.bin");
		const manifestPath = path.join(dir, "kernel-state.json");

		const { client: c1 } = await startRepl();
		await c1.exec(
			"s1",
			'import { join } from "node:path";\n' +
				"const small = { a: 1, b: [2, 3] };\n" +
				"const big = 'x'.repeat(2000);\n" +
				"function doubleIt(n) { return n * 2; }\n" +
				'process.env.PRIME_TEST_SNAP_VAR = "persisted";\n',
		);

		c1.send({
			type: "snapshot",
			id: "snap1",
			path: snapPath,
			manifest_path: manifestPath,
			max_bytes: 1024 * 1024,
			max_variable_bytes: 512,
			prune_oversized: true,
		});
		const snapDone = await c1.waitForEvent((e) => e.event === "done" && e.id === "snap1");
		expect(snapDone.status).toBe("ok");
		expect(snapDone.saved).toEqual(["doubleIt", "join", "small"]);
		expect(snapDone.pruned).toEqual(["big"]);
		expect((snapDone.skipped as Array<{ name: string; reason: string }>).some((s) => s.name === "big" && s.reason === "exceeds per-variable snapshot size cap")).toBe(true);
		expect(Number(snapDone.bytes)).toBeGreaterThan(0);

		// Confirm big was pruned from live namespace
		c1.send({ type: "list_names", id: "ln-after-prune" });
		const lnAfter = await c1.waitForEvent((e) => e.event === "done" && e.id === "ln-after-prune");
		expect(lnAfter.names).toEqual(["doubleIt", "join", "small"]);

		// Verify manifest JSON
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		expect(manifest.savedNames).toEqual(["doubleIt", "join", "small"]);
		expect(manifest.pruned).toEqual(["big"]);
		expect(manifest.bunVersion).toBe(Bun.version);

		await c1.close();

		// Start fresh worker & test missing snapshot first
		const { client: c2 } = await startRepl();
		c2.send({ type: "restore", id: "rest-missing", path: path.join(dir, "nope.bin") });
		const missingDone = await c2.waitForEvent((e) => e.event === "done" && e.id === "rest-missing");
		expect(missingDone.status).toBe("ok");
		expect(missingDone.restored).toEqual([]);
		expect(missingDone.reason).toBe("snapshot not found");

		// Now restore real snapshot
		c2.send({ type: "restore", id: "rest1", path: snapPath });
		const restDone = await c2.waitForEvent((e) => e.event === "done" && e.id === "rest1");
		expect(restDone.status).toBe("ok");
		expect(restDone.restored).toEqual(["doubleIt", "join", "small"]);
		expect(restDone.failed).toEqual([]);

		const checkEv = await c2.exec(
			"check1",
			'({ sum: small.a + small.b[1], fn: doubleIt(7), joined: join("a", "b"), env: process.env.PRIME_TEST_SNAP_VAR })',
		);
		const checkText = String(checkEv.find((e) => e.event === "result")?.text ?? "");
		expect(checkText).toContain("sum: 4");
		expect(checkText).toContain("fn: 14");
		expect(checkText).toContain('joined: "a/b"');
		expect(checkText).toContain('env: "persisted"');
	});

	test("supports host_request/host_reply, rlm APIs, display emit, and __primeLoadSkills", async () => {
		const dir = makeTempDir();
		const okSkillPath = path.join(dir, "ok-skill.ts");
		fs.writeFileSync(
			okSkillPath,
			`export function createSkill(ctx) {
  return {
    async ping(msg) {
      ctx.display("application/vnd.prime-agent.test+json", { msg });
      return await ctx.hostRequest("test.ping", { msg });
    },
  };
}\n`,
		);

		const { client } = await startRepl();

		// Load skills (one valid, one unavailable, one runtime-collision)
		const loadEv = await client.exec(
			"load1",
			`await __primeLoadSkills([
				{ name: "ok-skill", globalName: "okSkill", entryPath: ${JSON.stringify(okSkillPath)} },
				{ name: "bad-skill", globalName: "badSkill", entryPath: "/nonexistent", unavailableReason: "missing deps" },
				{ name: "clash", globalName: "fs", entryPath: ${JSON.stringify(okSkillPath)} },
			])`,
		);
		const loadStdout = loadEv
			.filter((e) => e.event === "stdout")
			.map((e) => String(e.text))
			.join("");
		expect(loadStdout).toContain("__PRIME_AGENT_JAVASCRIPT_SKILL_IMPORT_ERRORS__");
		expect(loadStdout).toContain("badSkill");
		expect(loadStdout).toContain("conflicts with runtime global fs");

		// Call okSkill.ping which emits display + sends host_request
		client.send({ type: "execute", id: "ping1", code: 'await okSkill.ping("hello")' });
		const hr = await client.waitForEvent((e) => e.event === "host_request");
		expect((hr.data as Record<string, unknown>).type).toBe("test.ping");
		expect((hr.data as Record<string, unknown>).msg).toBe("hello");
		client.send({ type: "host_reply", id: hr.id, data: { status: "ok", result: { pong: "hello!" } } });

		const pingDone = await client.waitForEvent((e) => e.event === "done" && e.id === "ping1");
		expect(pingDone.status).toBe("ok");
		const dispEvt = client.events.find(
			(e) =>
				e.event === "display" &&
				e.id === "ping1" &&
				Boolean((e.data as Record<string, unknown>)["application/vnd.prime-agent.test+json"]),
		);
		expect(dispEvt).toBeDefined();
		const resEvt = client.events.find((e) => e.event === "result" && e.id === "ping1");
		expect(String(resEvt?.text)).toContain("hello!");

		// Unavailable skill throws descriptive Error
		const badEv = await client.exec("bad1", "await badSkill()");
		expect(badEv.find((e) => e.event === "done")?.status).toBe("error");
		expect(String(badEv.find((e) => e.event === "error")?.evalue)).toContain("missing deps");

		// rlm.run throws rename message
		const runErrEv = await client.exec("runerr1", "rlm.run");
		expect(runErrEv.find((e) => e.event === "done")?.status).toBe("error");
		expect(String(runErrEv.find((e) => e.event === "error")?.evalue)).toContain("rlm.spawn");

		// Malformed line produces ProtocolError and runtime keeps serving
		client.proc.stdin!.write("{bad json\n");
		const protoErr = await client.waitForEvent((e) => e.event === "error" && e.ename === "ProtocolError");
		expect(protoErr.id).toBeNull();
		const aliveEv = await client.exec("alive1", "1 + 1");
		expect(aliveEv.find((e) => e.event === "result")?.text).toBe("2");
	});

	test("flushes last snapshot target on stdin EOF and supports out-of-band mcp_status & factory_activity", async () => {
		const dir = makeTempDir();
		const agentDir = makeTempDir("agent-");
		const snapPath = path.join(dir, "eof-state.bin");
		const manifestPath = path.join(dir, "eof-state.json");

		const { client } = await startRepl({ PRIME_AGENT_CODING_AGENT_DIR: agentDir });

		// Out-of-band factory_activity while disabled returns clean error reason
		client.send({ type: "factory_activity", id: "fa1", action: "graph" });
		const faDone = await client.waitForEvent((e) => e.event === "done" && e.id === "fa1");
		expect(faDone.status).toBe("error");
		expect(String(faDone.reason)).toContain("/factory on");

		// Out-of-band mcp_status with empty server list answers immediately
		client.send({ type: "mcp_status", id: "ms1", servers: [], timeout_ms: 2000 });
		const msDone = await client.waitForEvent((e) => e.event === "done" && e.id === "ms1");
		expect(msDone.status).toBe("ok");
		expect(msDone.connections).toEqual([]);

		// Commit an initial snapshot, then mutate namespace and close stdin (EOF)
		await client.exec("e1", "let counter = 1;");
		client.send({ type: "snapshot", id: "s-eof-1", path: snapPath, manifest_path: manifestPath });
		const s1 = await client.waitForEvent((e) => e.event === "done" && e.id === "s-eof-1");
		expect(s1.status).toBe("ok");

		await client.exec("e2", "const afterSnap = 99;");
		client.proc.stdin!.end();
		await new Promise<void>((resolve) => client.proc.once("exit", () => resolve()));

		// Fresh worker restores and sees afterSnap flushed on EOF!
		const { client: c2 } = await startRepl({ PRIME_AGENT_CODING_AGENT_DIR: agentDir });
		c2.send({ type: "restore", id: "r-eof", path: snapPath });
		const rDone = await c2.waitForEvent((e) => e.event === "done" && e.id === "r-eof");
		expect(rDone.status).toBe("ok");
		expect(rDone.restored).toEqual(["afterSnap", "counter"]);
	});
});
