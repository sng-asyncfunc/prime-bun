import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import {
	_resetDegradeHintsForTest,
	_setYieldAfterSecondsForTest,
	activityRequest,
	bash,
	killLiveHandles,
	persistentShells,
	setCompletionNoticesWired,
	sh,
} from "../src/bash.ts";

const RUNTIME_DIR = path.resolve(import.meta.dir, "..");
const REPL_ENTRY = path.join(RUNTIME_DIR, "src", "repl.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix = "prime-bash-test-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	killLiveHandles();
	setCompletionNoticesWired(false);
	_setYieldAfterSecondsForTest(1.0);
	_resetDegradeHintsForTest();
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("bash() & sh()", () => {
	test("await bash() returns BashResult with exitCode, output, duration, running=false", async () => {
		const res = await bash("printf 'hello world\\n'");
		expect(res.running).toBe(false);
		expect(res.exitCode).toBe(0);
		expect(res.output).toBe("hello world\n");
		expect(res.duration).toBeGreaterThanOrEqual(0);
	});

	test("applies non-interactive child environment variables", async () => {
		const res = await bash('printf "%s|%s|%s|%s|%s" "$NO_COLOR" "$TERM" "$GIT_TERMINAL_PROMPTS" "$PAGER" "$DEBIAN_FRONTEND"');
		expect(res.running).toBe(false);
		expect(res.output).toBe("1|dumb|0|cat|noninteractive");
	});

	test("background handle supports pid, running, output, tail, poll, kill, and activityRequest", async () => {
		const h = bash("echo line1; echo line2; echo line3; sleep 5");
		expect(h.pid).toBeGreaterThan(0);
		expect(h.running).toBe(true);

		// Wait until output appears
		const deadline = Date.now() + 3000;
		while (!h.output().includes("line3") && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(h.tail(2)).toBe("line2\nline3");
		expect(h.poll()).toBeNull();

		// activityRequest list + tail + kill
		const listed = activityRequest("list") as { activities: Array<Record<string, unknown>> };
		const row = listed.activities.find((a) => a.pid === h.pid);
		expect(row).toBeDefined();
		expect(row!.status).toBe("running");

		const tailed = activityRequest("tail", String(row!.id), 2) as { tail: string };
		expect(tailed.tail).toBe("line2\nline3");

		const killed = activityRequest("kill", String(row!.id)) as { killed: boolean };
		expect(killed.killed).toBe(true);

		const finalRes = await h;
		expect(finalRes.running).toBe(false);
		expect(h.poll()).not.toBeNull();
	});

	test("degrades after yield window when completion notices are wired and sends bash.completed in REPL", async () => {
		const proc = spawn(process.execPath, ["run", REPL_ENTRY], {
			cwd: RUNTIME_DIR,
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		const events: Array<Record<string, unknown>> = [];
		const waiters: Array<{ p: (e: Record<string, unknown>) => boolean; r: (e: Record<string, unknown>) => void }> = [];
		const rl = createInterface({ input: proc.stdout!, crlfDelay: Number.POSITIVE_INFINITY });
		rl.on("line", (line) => {
			if (!line.trim()) return;
			const parsed = JSON.parse(line) as Record<string, unknown>;
			events.push(parsed);
			for (let i = waiters.length - 1; i >= 0; i -= 1) {
				if (waiters[i]!.p(parsed)) {
					waiters.splice(i, 1)[0]!.r(parsed);
				}
			}
		});
		const waitFor = (p: (e: Record<string, unknown>) => boolean, ms = 10_000) => {
			const hit = events.find(p);
			if (hit) return Promise.resolve(hit);
			return new Promise<Record<string, unknown>>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timeout")), ms);
				waiters.push({
					p,
					r: (e) => {
						clearTimeout(timer);
						resolve(e);
					},
				});
			});
		};
		const send = (obj: Record<string, unknown>) => proc.stdin!.write(`${JSON.stringify(obj)}\n`);

		try {
			await waitFor((e) => e.event === "ready");
			send({ type: "execute", id: "boot", code: "__primeSetCompletionNoticesWired(true);" });
			await waitFor((e) => e.event === "done" && e.id === "boot");

			// Start a 1.6s command: degrades after 1.0s into BashSnapshot
			send({ type: "execute", id: "b1", code: 'const r = await bash("echo starting; sleep 1.6; echo finished"); ({ running: r.running, exitCode: r.exitCode })' });
			const done1 = await waitFor((e) => e.event === "done" && e.id === "b1", 5000);
			expect(done1.status).toBe("ok");
			const res1 = events.find((e) => e.event === "result" && e.id === "b1");
			expect(String(res1?.text)).toContain("running: true");
			expect(String(res1?.text)).toContain("exitCode: null");

			// Degrade hint written to stderr
			const stderr1 = events
				.filter((e) => e.event === "stderr" && e.id === "b1")
				.map((e) => String(e.text))
				.join("");
			expect(stderr1).toContain("still running after 1s");

			// Check bash_activity out-of-band sees it
			send({ type: "bash_activity", id: "ba1", action: "list" });
			const ba1 = await waitFor((e) => e.event === "done" && e.id === "ba1");
			expect(ba1.status).toBe("ok");
			expect((ba1.activities as unknown[]).length).toBeGreaterThanOrEqual(1);

			// Host receives bash.completed when background process finishes
			const completedHr = await waitFor(
				(e) => e.event === "host_request" && (e.data as Record<string, unknown>).type === "bash.completed",
				6000,
			);
			expect((completedHr.data as Record<string, unknown>).exitCode).toBe(0);
			send({ type: "host_reply", id: completedHr.id, data: { status: "ok", result: {} } });

			// Reading r.handle.output() in a live cell fires bash.consumed
			await new Promise((r) => setTimeout(r, 30));
			send({ type: "execute", id: "b2", code: "r.handle.output()" });
			const consumedHr = await waitFor(
				(e) => e.event === "host_request" && (e.data as Record<string, unknown>).type === "bash.consumed",
				5000,
			);
			expect((consumedHr.data as Record<string, unknown>).pid).toBe((completedHr.data as Record<string, unknown>).pid);
			await waitFor((e) => e.event === "done" && e.id === "b2");
		} finally {
			send({ type: "shutdown", id: "sd" });
			await Promise.race([
				new Promise<void>((r) => proc.once("exit", () => r())),
				new Promise<void>((r) =>
					setTimeout(() => {
						proc.kill("SIGKILL");
						r();
					}, 2000),
				),
			]);
			rl.close();
		}
	});

	test("persistent shell writes pa-daemon record format and cleans up after exit", async () => {
		const agentDir = makeTempDir("prime-agent-dir-");
		const prevAgent = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		const prevSess = process.env.RLM_SESSION_ID;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
		process.env.RLM_SESSION_ID = "sess-test-123";
		try {
			const h = bash("echo persist-hi; sleep 0.2", { persistent: true });
			expect(persistentShells().some((s) => s.pid === h.pid)).toBe(true);
			const home = path.join(agentDir, "persistent-shells");
			const jsonFiles = fs.readdirSync(home).filter((f) => f.endsWith(".json"));
			expect(jsonFiles.length).toBe(1);
			const record = JSON.parse(fs.readFileSync(path.join(home, jsonFiles[0]!), "utf8")) as Record<string, unknown>;
			expect(record.sessionId).toBe("sess-test-123");
			expect(record.pid).toBe(h.pid);
			expect(typeof record.startId).toBe("string");
			expect(typeof record.startedAt).toBe("string");

			const result = await h;
			expect(result.running).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("persist-hi");
		} finally {
			if (prevAgent === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			else process.env.PRIME_AGENT_CODING_AGENT_DIR = prevAgent;
			if (prevSess === undefined) delete process.env.RLM_SESSION_ID;
			else process.env.RLM_SESSION_ID = prevSess;
		}
	});

	test("enrolls pid into orphan journal when configured", async () => {
		const dir = makeTempDir("prime-journal-");
		const journalPath = path.join(dir, "journal.jsonl");
		const prevJ = process.env.PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL;
		const prevO = process.env.PRIME_AGENT_KERNEL_OWNER_PID;
		process.env.PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL = journalPath;
		process.env.PRIME_AGENT_KERNEL_OWNER_PID = String(process.pid);
		try {
			const res = await bash("echo journaled");
			expect(res.exitCode).toBe(0);
			await new Promise((r) => setTimeout(r, 80));
			const lines = fs
				.readFileSync(journalPath, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			expect(lines.some((l) => l.active === true && l.ownerPid === process.pid)).toBe(true);
			expect(lines.some((l) => l.active === false && l.ownerPid === process.pid)).toBe(true);
		} finally {
			if (prevJ === undefined) delete process.env.PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL;
			else process.env.PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL = prevJ;
			if (prevO === undefined) delete process.env.PRIME_AGENT_KERNEL_OWNER_PID;
			else process.env.PRIME_AGENT_KERNEL_OWNER_PID = prevO;
		}
	});

	test("sh() provides text() and json() helpers", async () => {
		expect((await sh('printf "abc"').text())).toBe("abc");
		expect(await sh('printf \'{"ok":true,"n":7}\'').json()).toEqual({ ok: true, n: 7 });
	});
});
