import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";

describe("spawn ledger replay cache", () => {
	it("reuses reads, isolates returned edges, and observes local and rival writes", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-ledger-cache-"));
		try {
			const ledger = new RlmSpawnLedger(root, join(root, "sessions"));
			const input = {
				childId: "child-a",
				parent: join(root, "parent.jsonl"),
				child: join(root, "a.jsonl"),
				depth: 1,
				name: "A",
			};
			await ledger.appendSpawn(input);
			const replay = vi.spyOn(ledger as unknown as { replaySync(): unknown }, "replaySync");
			const first = await ledger.edges();
			first[0].name = "mutated";
			expect((await ledger.edges())[0].name).toBe("A");
			expect(replay).toHaveBeenCalledTimes(1);
			appendFileSync(
				ledger.ledgerPath,
				`${JSON.stringify({
					...input,
					v: 1,
					op: "spawn",
					at: new Date().toISOString(),
					childId: "child-b",
					child: join(root, "b.jsonl"),
				})}\n`,
			);
			expect(await ledger.edges()).toHaveLength(2);
			expect(replay).toHaveBeenCalledTimes(2);
			await ledger.appendRename({ childId: input.childId, child: input.child, name: "renamed" });
			expect((await ledger.edges())[0].name).toBe("renamed");
			rmSync(ledger.ledgerPath);
			expect(await ledger.edges()).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
