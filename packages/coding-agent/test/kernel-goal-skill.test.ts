import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BunKernelProvisioner } from "../src/core/tools/javascript.js";
import { bundledJavaScriptSkill } from "./bun-skill-test-utils.js";

const GOAL_SKILL = bundledJavaScriptSkill("goal", "goal");

describe("goal skill over the Bun host bridge", () => {
	let tempDir: string;
	let provisioner: BunKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-goal-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips goal.create and goal.complete through Bun", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new BunKernelProvisioner(tempDir, {
			javascriptSkills: [GOAL_SKILL],
			hostHandlers: {
				"goal.create": async (payload) => {
					requests.push({ type: "goal.create", payload });
					return {
						goal: { objective: payload.objective, status: "active", tokens_used: 0 },
						remaining_tokens: payload.token_budget ?? null,
						completion_budget_report: null,
					};
				},
				"goal.complete": async (payload) => {
					requests.push({ type: "goal.complete", payload });
					return {
						goal: { objective: "ship it", status: "complete", tokens_used: 7 },
						remaining_tokens: 3,
						completion_budget_report:
							"Goal achieved. Report final budget usage to the user: tokens used: 7 of 10.",
					};
				},
			},
		});

		const manager = await provisioner.ensure();
		const created = await manager.execute(`
const created = await goal.create("ship it", { tokenBudget: 10 });
console.log(JSON.stringify(created));
`);
		expect(created.status).toBe("ok");
		expect(JSON.parse(created.stdout.trim())).toEqual({
			goal: { objective: "ship it", status: "active", tokens_used: 0 },
			remaining_tokens: 10,
			completion_budget_report: null,
		});

		const completed = await manager.execute(`
const completed = await goal.complete();
console.log(completed.goal.status, completed.completion_budget_report);
`);
		expect(completed.status).toBe("ok");
		expect(completed.stdout.trim()).toBe(
			"complete Goal achieved. Report final budget usage to the user: tokens used: 7 of 10.",
		);

		expect(requests.map((request) => request.type)).toEqual(["goal.create", "goal.complete"]);
		expect(requests[0]?.payload).toMatchObject({
			type: "goal.create",
			objective: "ship it",
			token_budget: 10,
		});
	});

	it("surfaces host errors and missing handlers as JavaScript errors", async () => {
		provisioner = new BunKernelProvisioner(tempDir, {
			javascriptSkills: [GOAL_SKILL],
			hostHandlers: {
				"goal.complete": async () => {
					throw new Error("cannot complete goal because this task has no goal");
				},
			},
		});

		const manager = await provisioner.ensure();
		const completeError = await manager.execute(`
try {
  await goal.complete();
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
`);
		expect(completeError.status).toBe("ok");
		expect(completeError.stdout.trim()).toBe("cannot complete goal because this task has no goal");

		const unavailable = await manager.execute(`
try {
  await goal.get();
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
`);
		expect(unavailable.status).toBe("ok");
		expect(unavailable.stdout.trim()).toBe('host request type "goal.get" is not available in this session');
	});

	it("does not allow payload data to reroute a host request", async () => {
		let completeCalls = 0;
		provisioner = new BunKernelProvisioner(tempDir, {
			javascriptSkills: [GOAL_SKILL],
			hostHandlers: {
				"goal.complete": async () => {
					completeCalls += 1;
					return {};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try {
  await hostRequest("goal.get", { type: "goal.complete" });
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe('host request type "goal.get" is not available in this session');
		expect(completeCalls).toBe(0);
	});
});
