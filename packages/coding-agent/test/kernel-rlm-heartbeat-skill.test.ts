import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BunKernelProvisioner } from "../src/core/tools/javascript.js";
import { bundledJavaScriptSkill } from "./bun-skill-test-utils.js";

const RLM_HEARTBEAT_SKILL = bundledJavaScriptSkill("rlm-heartbeat", "rlmHeartbeat");

describe("RLM heartbeat skill over the Bun host bridge", () => {
	let tempDir: string;
	let provisioner: BunKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-rlm-heartbeat-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips create, list, update, and delete through Bun", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new BunKernelProvisioner(tempDir, {
			javascriptSkills: [RLM_HEARTBEAT_SKILL],
			hostHandlers: {
				"rlm_heartbeat.create": async (payload) => {
					requests.push({ type: "rlm_heartbeat.create", payload });
					return {
						heartbeat: {
							id: "job-1",
							status: "active",
							label: payload.label ?? null,
							instruction: payload.instruction,
							schedule: { kind: "interval", expression: payload.interval ?? "every 5m" },
							next_run_at: "2026-01-01T12:39:00.000Z",
							run_count: 0,
						},
					};
				},
				"rlm_heartbeat.list": async (payload) => {
					requests.push({ type: "rlm_heartbeat.list", payload });
					return {
						heartbeats: [{ id: "job-1", status: "active", label: "tests", instruction: "check tests" }],
					};
				},
				"rlm_heartbeat.update": async (payload) => {
					requests.push({ type: "rlm_heartbeat.update", payload });
					return {
						heartbeat: {
							id: payload.id,
							status: "paused",
							label: "tests",
							instruction: "check tests",
						},
					};
				},
				"rlm_heartbeat.delete": async (payload) => {
					requests.push({ type: "rlm_heartbeat.delete", payload });
					return {
						heartbeat: {
							id: payload.id,
							status: "cancelled",
							label: "tests",
							instruction: "check tests",
						},
					};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
const created = await rlmHeartbeat.create("check tests", {
  interval: "5m",
  label: "tests",
  deliveryMode: "follow_up",
});
const listed = await rlmHeartbeat.list({ includeInactive: true });
const updated = await rlmHeartbeat.update(created.heartbeat.id, { status: "pause" });
const deleted = await rlmHeartbeat.delete(created.heartbeat.id);
console.log(JSON.stringify({
  created: created.heartbeat,
  listed: listed.heartbeats,
  updated: updated.heartbeat,
  deleted: deleted.heartbeat,
}));
`);

		expect(result.status).toBe("ok");
		expect(JSON.parse(result.stdout.trim())).toMatchObject({
			created: { id: "job-1", status: "active", label: "tests", instruction: "check tests" },
			listed: [{ id: "job-1", status: "active", label: "tests", instruction: "check tests" }],
			updated: { id: "job-1", status: "paused" },
			deleted: { id: "job-1", status: "cancelled" },
		});
		expect(requests.map((request) => request.type)).toEqual([
			"rlm_heartbeat.create",
			"rlm_heartbeat.list",
			"rlm_heartbeat.update",
			"rlm_heartbeat.delete",
		]);
		expect(requests[0]?.payload).toMatchObject({
			type: "rlm_heartbeat.create",
			instruction: "check tests",
			interval: "5m",
			label: "tests",
			delivery_mode: "follow_up",
		});
		expect(requests[1]?.payload).toMatchObject({
			type: "rlm_heartbeat.list",
			include_inactive: true,
		});
		expect(requests[2]?.payload).toMatchObject({
			type: "rlm_heartbeat.update",
			id: "job-1",
			status: "pause",
		});
		expect(requests[3]?.payload).toMatchObject({ type: "rlm_heartbeat.delete", id: "job-1" });
	});

	it("surfaces missing host handlers as JavaScript errors", async () => {
		provisioner = new BunKernelProvisioner(tempDir, {
			javascriptSkills: [RLM_HEARTBEAT_SKILL],
			hostHandlers: {},
		});

		const manager = await provisioner.ensure();
		const unavailable = await manager.execute(`
try {
  await rlmHeartbeat.list();
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
`);
		expect(unavailable.status).toBe("ok");
		expect(unavailable.stdout.trim()).toBe('host request type "rlm_heartbeat.list" is not available in this session');
	});

	it("rejects invalid delivery modes before calling the host", async () => {
		let hostRequestCount = 0;
		provisioner = new BunKernelProvisioner(tempDir, {
			javascriptSkills: [RLM_HEARTBEAT_SKILL],
			hostHandlers: {
				"rlm_heartbeat.create": async () => {
					hostRequestCount += 1;
					return {};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
for (const deliveryMode of [[], {}]) {
  try {
    await rlmHeartbeat.create("check tests", { deliveryMode });
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
  }
}
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim().split("\n")).toEqual([
			'deliveryMode must be "steer", "follow_up", or undefined',
			'deliveryMode must be "steer", "follow_up", or undefined',
		]);
		expect(hostRequestCount).toBe(0);
	});
});
