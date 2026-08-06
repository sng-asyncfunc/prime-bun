import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { KernelManager } from "../src/core/kernel/index.js";
import type { JavaScriptSkillRuntimeInfo } from "../src/core/skills.js";
import { BunKernelProvisioner } from "../src/core/tools/javascript.js";
import { acpUpdatesForSessionEvent } from "../src/modes/acp/acp-events.js";
import { PRIME_AGENT_META_NAMESPACE } from "../src/modes/acp/acp-meta.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/types.js";

function why(result: { status: string; stderr: string; error?: { traceback: string[] } }): string {
	return [result.stderr, result.error?.traceback?.join("\n")].filter(Boolean).join("\n");
}

function bundledSkill(name: string, globalName: string): JavaScriptSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), name);
	return {
		entryPath: join(packagePath, "src", "index.ts"),
		globalName,
		name,
		packageJsonPath: join(packagePath, "package.json"),
		packagePath,
	};
}

const AGENT_MESSAGE_SKILL = bundledSkill("agent-message", "agentMessage");

function toolEndEvent(toolCallId: string, output: string, isError = false): AgentConnectionSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "javascript",
		result: { output },
		isError,
	} as AgentConnectionSessionEvent;
}

describe("ACP mode over a real Bun notebook", () => {
	let tempDir: string;
	let provisioner: BunKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-acp-bun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it(
		"keeps JavaScript state across cells and represents each cell as an ACP execute call",
		{ tags: ["kernel-heavy"], timeout: 180_000 },
		async () => {
			provisioner = new BunKernelProvisioner(tempDir, { javascriptSkills: [AGENT_MESSAGE_SKILL] });
			const manager: KernelManager = await provisioner.ensure();

			const first = await manager.execute("const acpState = 41; console.log('set');");
			expect(first.status).toBe("ok");
			const second = await manager.execute("console.log(acpState + 1);");
			expect(second.status).toBe("ok");
			expect(second.stdout.trim()).toBe("42");

			const updates = acpUpdatesForSessionEvent(toolEndEvent("cell-2", second.stdout));
			expect(updates[0]).toMatchObject({
				sessionUpdate: "tool_call_update",
				toolCallId: "cell-2",
				status: "completed",
			});
			expect(JSON.stringify(updates[0]?.content)).toContain("42");
		},
	);

	it(
		"runs continual-harness CRUD in Bun and represents the result over ACP",
		{ tags: ["kernel-heavy"], timeout: 180_000 },
		async () => {
			provisioner = new BunKernelProvisioner(tempDir, {
				javascriptSkills: [AGENT_MESSAGE_SKILL],
				env: { RLM_GLOBAL_HARNESS_STATE_DIR: join(tempDir, "harness") },
			});
			const manager = await provisioner.ensure();

			const allKinds = await manager.execute(`
const mem = await rlm.harness.createMemory("m", "memory content", { global: true });
const note = await rlm.harness.createPromptNote("n", "prompt note content", { global: true });
const spec = await rlm.harness.createSubagent("s", "subagent spec content", { global: true });
const skill = await rlm.harness.createSkill("k", "skill content", {
  global: true,
  reference: { type: "javascript", global: "pkgMod", callPattern: "await pkgMod(...)" },
  arguments: { x: { type: "string", required: true, description: "input" } },
});
console.log(JSON.stringify({
  kinds: [mem.kind, note.kind, spec.kind, skill.kind].sort(),
  skillRef: skill.reference.global,
}));
`);
			expect(allKinds.status, why(allKinds)).toBe("ok");
			expect(JSON.parse(allKinds.stdout.trim())).toMatchObject({
				kinds: ["memory", "prompt", "skill", "subagent"],
				skillRef: "pkgMod",
			});

			const result = await manager.execute(`
const entry = await rlm.harness.createMemory(
  "ACP verification memory",
  "ACP mode preserves continual harness CRUD.",
  { global: true },
);
const found = await rlm.harness.get("memory", entry.id, { global: true });
const listed = (await rlm.harness.list("memory", { global: true })).map((item) => item.id);
const deleted = await rlm.harness.delete("memory", entry.id, { global: true });
const after = await rlm.harness.get("memory", entry.id, { global: true });
console.log(JSON.stringify({
  created: entry.id,
  found: found?.title ?? null,
  listed,
  deleted,
  after: after?.title ?? null,
}));
`);
			expect(result.status, why(result)).toBe("ok");
			const payload = JSON.parse(result.stdout.trim()) as {
				after: string | null;
				created: string;
				deleted: boolean;
				found: string;
				listed: string[];
			};
			expect(payload.found).toBe("ACP verification memory");
			expect(payload.listed).toContain(payload.created);
			expect(payload.deleted).toBe(true);
			expect(payload.after).toBeNull();

			const refined = acpUpdatesForSessionEvent({
				type: "refine_complete",
				result: {
					summary: "persisted ACP verification memory",
					appliedEdits: [{ applied: true, action: "create", kind: "memory", id: payload.created }],
				},
			} as AgentConnectionSessionEvent);
			expect(refined[0]?._meta).toMatchObject({
				[PRIME_AGENT_META_NAMESPACE]: { refinement: { status: "complete" } },
			});
		},
	);

	it(
		"exposes RLM depth and subagent APIs behind the ACP front end",
		{ tags: ["kernel-heavy"], timeout: 180_000 },
		async () => {
			provisioner = new BunKernelProvisioner(tempDir, {
				javascriptSkills: [AGENT_MESSAGE_SKILL],
				env: { RLM_DEPTH: "0", RLM_MAX_DEPTH: "1" },
				hostHandlers: {
					"rlm.list_subagents": async () => ({
						subagents: [
							{
								rlm_child_id: "child-1",
								active_session_id: "active-1",
								session_id: "session-1",
								session_name: "reviewer",
								session_dir: tempDir,
								status: "completed",
							},
						],
					}),
					"rlm.delete_subagent": async (payload) => ({
						subagent: {
							rlm_child_id: String(payload.target),
							active_session_id: null,
							session_id: "session-1",
							session_name: "reviewer",
							session_dir: tempDir,
							status: "completed",
						},
					}),
				},
			});
			const manager = await provisioner.ensure();

			const result = await manager.execute(`
const children = await rlm.listSubagents();
const removed = await rlm.deleteSubagent(children[0]);
console.log(JSON.stringify({
  depth: process.env.RLM_DEPTH,
  maxDepth: process.env.RLM_MAX_DEPTH,
  names: children.map((child) => child.sessionName),
  removed: removed.sessionName,
}));
`);
			expect(result.status, why(result)).toBe("ok");
			const payload = JSON.parse(result.stdout.trim()) as {
				depth: string;
				maxDepth: string;
				names: string[];
				removed: string;
			};
			expect(payload.names).toEqual(["reviewer"]);
			expect(payload.removed).toBe("reviewer");
			expect(payload.depth).toBe("0");
			expect(payload.maxDepth).toBe("1");
		},
	);

	it(
		"sends an agent-to-agent message from Bun and surfaces it over ACP",
		{ tags: ["kernel-heavy"], timeout: 180_000 },
		async () => {
			provisioner = new BunKernelProvisioner(tempDir, {
				javascriptSkills: [AGENT_MESSAGE_SKILL],
				hostHandlers: {
					"agent_message.list_agents": async () => ({
						current: { name: "root", id: "session-alpha", depth: 0 },
						entries: [{ relationship: "child", name: "reviewer", id: "session-beta", depth: 1, status: "idle" }],
					}),
					"agent_message.send": async (payload) => ({
						id: "agentmsg-acp",
						source: "agent_message",
						target: { activeSessionId: "beta", sessionId: "session-beta", sessionName: "reviewer" },
						message: payload.message,
						deliveryStatus: "queued",
						queuedAt: "2026-08-04T00:00:00.000Z",
						deliveryMode: payload.mode ?? "auto",
					}),
				},
			});
			const manager = await provisioner.ensure();

			const result = await manager.execute(`
const roster = await agentMessage.listAgents();
const receipt = await agentMessage.send("status update", {
  receiverRole: "child",
  receiverName: "reviewer",
});
console.log(JSON.stringify({
  roster: roster.entries.map((entry) => entry.name),
  status: receipt.deliveryStatus,
}));
`);
			expect(result.status, why(result)).toBe("ok");
			const payload = JSON.parse(result.stdout.trim()) as { roster: string[]; status: string };
			expect(payload.roster).toEqual(["reviewer"]);
			expect(payload.status).toBe("queued");

			const sent = result.sentAgentMessages?.[0];
			expect(sent).toBeDefined();
			const updates = acpUpdatesForSessionEvent({
				type: "javascript_sent_agent_message",
				toolCallId: "cell-msg",
				message: sent,
			} as AgentConnectionSessionEvent);
			expect(updates[0]?._meta).toMatchObject({
				[PRIME_AGENT_META_NAMESPACE]: { agentMessage: { toolCallId: "cell-msg", deliveryStatus: "queued" } },
			});
		},
	);
});
