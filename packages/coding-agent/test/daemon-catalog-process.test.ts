import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import { DaemonCatalogClient, resolveCatalogSessionMatch } from "../src/modes/daemon/daemon-catalog-process.js";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for catalog state");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
function session(id: string, name: string | undefined, path: string): SessionInfo {
	return {
		id,
		name,
		path,
		cwd: "/tmp/project",
		rlmDepth: 0,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

describe("daemon catalog selector resolution", () => {
	it("treats an exact name colliding with another session id prefix as ambiguous", () => {
		const sessions = [
			session("named-session-id", "target", "/tmp/by-name.jsonl"),
			session("target-prefix-id", "other", "/tmp/by-prefix.jsonl"),
		];

		expect(() => resolveCatalogSessionMatch(sessions, "target")).toThrow('Ambiguous session selector "target"');
	});

	it("retires after idle and transparently starts a fresh catalog for the next request", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-idle-"));
		const sessionDir = join(root, "sessions");
		const originalEntrypoint = process.argv[1];
		const originalExecArgv = process.execArgv;
		process.argv[1] = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		process.execArgv = ["--import", "tsx"];
		const client = new DaemonCatalogClient(() => undefined, 100);
		const internals = client as unknown as { child?: { pid?: number } };
		try {
			await expect(client.list(root, sessionDir)).resolves.toEqual([]);
			const firstPid = internals.child?.pid;
			expect(firstPid).toBeTypeOf("number");

			await waitFor(() => internals.child === undefined);
			await expect(client.list(root, sessionDir)).resolves.toEqual([]);
			expect(internals.child?.pid).toBeTypeOf("number");
			expect(internals.child?.pid).not.toBe(firstPid);
		} finally {
			await client.stop();
			process.argv[1] = originalEntrypoint;
			process.execArgv = originalExecArgv;
			rmSync(root, { force: true, recursive: true });
		}
	});
});
