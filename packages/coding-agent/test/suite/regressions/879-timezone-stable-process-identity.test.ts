import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPsProcessStartId, processStartIdMatches } from "../../../src/core/session-lease.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import {
	acquireDaemonSupervisorOwnership,
	assertDaemonSupervisorOwnerCurrent,
} from "../../../src/modes/daemon/daemon-supervisor-ownership.js";
import { createHarness, type Harness } from "../harness.js";

describe("issue #879 stable daemon process identity across timezone changes", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("pins the portable process query to UTC across caller timezone changes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
		const query = (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
			calls.push({ command, args, env: options?.env });
			return options?.env?.TZ === "UTC" ? "Sat Aug 29 20:55:18 2026\n" : "Sat Aug 29 16:55:18 2026\n";
		};
		const originalTimezone = process.env.TZ;
		let before: string | undefined;
		let after: string | undefined;
		try {
			process.env.TZ = "America/Los_Angeles";
			before = getPsProcessStartId(42, query);
			process.env.TZ = "America/New_York";
			after = getPsProcessStartId(42, query);
		} finally {
			if (originalTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = originalTimezone;
		}

		expect(before).toBe("ps:Sat Aug 29 20:55:18 2026");
		expect(after).toBe(before);
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call).toMatchObject({
				command: "ps",
				args: ["-p", "42", "-o", "lstart="],
				env: { LC_ALL: "C", LC_TIME: "C", LANG: "C", TZ: "UTC" },
			});
		}
	});

	it("recognizes a legacy local-time ps identity during a rolling upgrade", () => {
		const calls: Array<{ env: NodeJS.ProcessEnv | undefined }> = [];
		const query = (_command: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
			calls.push({ env: options?.env });
			return options?.env?.TZ === "UTC" ? "Sun Sep  6 06:00:00 2026\n" : "Sun Sep  6 01:00:00 2026\n";
		};

		expect(processStartIdMatches(42, "ps:Sun Sep  6 01:00:00 2026", query)).toBe(true);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.env?.TZ).toBe("UTC");
		expect(calls[1]?.env).toBeUndefined();
	});

	it.skipIf(process.platform !== "darwin")("keeps supervisor ownership current after a timezone change", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-timezone-ownership-"));
		tempDirs.push(root);
		const registryDir = join(root, "registry");
		const socketPath = join(root, "daemon.sock");
		const originalTimezone = process.env.TZ;
		let ownership: Awaited<ReturnType<typeof acquireDaemonSupervisorOwnership>> | undefined;
		try {
			process.env.TZ = "America/Los_Angeles";
			ownership = await acquireDaemonSupervisorOwnership({
				agentDir: join(root, "agent"),
				appVersion: "test",
				descriptorDir: join(root, "workers"),
				generation: "timezone-regression",
				registryDir,
				socketPath,
			});
			const identity = {
				generation: ownership.record.generation,
				pid: ownership.record.pid,
				...(ownership.record.processStartId ? { processStartId: ownership.record.processStartId } : {}),
				socketPath: ownership.record.socketPath,
			};

			process.env.TZ = "America/New_York";
			await expect(assertDaemonSupervisorOwnerCurrent(identity, undefined, registryDir, undefined)).resolves.toEqual(
				expect.any(String),
			);
		} finally {
			await ownership?.release();
			if (originalTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = originalTimezone;
		}
	});

	it.skipIf(process.platform !== "darwin")("keeps a live worker descriptor current across a rolling upgrade", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-timezone-worker-"));
		tempDirs.push(root);
		const environmentKeys = ["LC_ALL", "LC_TIME", "LANG", "TZ"] as const;
		const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
		try {
			process.env.LC_ALL = "C";
			process.env.LC_TIME = "C";
			process.env.LANG = "C";
			process.env.TZ = "America/Chicago";
			const legacyStartId = `ps:${execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], {
				encoding: "utf8",
			}).trim()}`;
			const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
				defaultSessionConfig: { agentDir: root, cwd: root },
				descriptorDir: join(root, "workers"),
			}) as unknown as {
				processIdentity(pid: number, processStartId: string | undefined): string;
			};

			expect(supervisor.processIdentity(process.pid, legacyStartId)).toBe("current");
		} finally {
			for (const key of environmentKeys) {
				const original = originalEnvironment[key];
				if (original === undefined) delete process.env[key];
				else process.env[key] = original;
			}
		}
	});
});
