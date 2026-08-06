import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KernelManager, type KernelSentAgentMessage } from "../src/core/kernel/index.js";
import { BunKernelProvisioner } from "../src/core/tools/javascript.js";
import { bundledJavaScriptSkill } from "./bun-skill-test-utils.js";

const AGENT_MESSAGE_SKILL = bundledJavaScriptSkill("agent-message", "agentMessage");

type LateHandlerRetentionHost = {
	lateSentAgentMessageHandlers: Map<string, (message: KernelSentAgentMessage) => void>;
	registerLateSentAgentMessageHandler: (
		requestMessageId: string,
		handler: (message: KernelSentAgentMessage) => void,
	) => void;
};

describe("agent-message skill over the Bun host bridge", () => {
	let tempDir: string;
	let provisioner: BunKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-agent-message-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists agents and sends without exposing a spoofable sender", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new BunKernelProvisioner(tempDir, {
			javascriptSkills: [AGENT_MESSAGE_SKILL],
			hostHandlers: {
				"agent_message.list_agents": async (payload) => {
					requests.push({ type: "agent_message.list_agents", payload });
					return {
						current: { name: "alpha", id: "session-alpha", depth: 0 },
						entries: [{ relationship: "sibling", name: "Beta", id: "session-beta", depth: 0, status: "idle" }],
					};
				},
				"agent_message.send": async (payload) => {
					requests.push({ type: "agent_message.send", payload });
					return {
						id: "agentmsg-test",
						source: "agent_message",
						target: { activeSessionId: payload.receiver_name, sessionId: "session-beta", sessionName: "Beta" },
						from: { activeSessionId: "alpha", sessionId: "session-alpha" },
						message: payload.message,
						deliveryStatus: "queued",
						queuedAt: "2026-06-16T00:00:00.000Z",
					};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
const agents = await agentMessage.listAgents();
const receipt = await agentMessage.send("hello beta", {
  receiverRole: "sibling",
  receiverName: "beta",
});
console.log(JSON.stringify({ agents, receipt }));
`);

		expect(result.status).toBe("ok");
		const output = JSON.parse(result.stdout.trim()) as {
			agents: { current: object; entries: object[] };
			receipt: Record<string, unknown>;
		};
		expect(output.agents).toMatchObject({
			current: { id: "session-alpha", depth: 0 },
			entries: [{ relationship: "sibling", id: "session-beta", status: "idle" }],
		});
		expect(output.receipt).toMatchObject({
			id: "agentmsg-test",
			source: "agent_message",
			message: "hello beta",
			deliveryStatus: "queued",
		});
		expect(result.sentAgentMessages).toEqual([
			{
				id: "agentmsg-test",
				message: "hello beta",
				deliveryStatus: "queued",
				receiverRole: "sibling",
				target: { activeSessionId: "beta", sessionId: "session-beta", sessionName: "Beta" },
			},
		]);
		expect(requests[0]).toMatchObject({
			type: "agent_message.list_agents",
			payload: { type: "agent_message.list_agents" },
		});
		expect(requests[1]).toMatchObject({
			type: "agent_message.send",
			payload: {
				type: "agent_message.send",
				message: "hello beta",
				receiver_role: "sibling",
				receiver_name: "beta",
			},
		});
		expect(requests[1]?.payload).not.toHaveProperty("from");
	});

	it("emits successful broadcast receipts and preserves short errors", async () => {
		provisioner = new BunKernelProvisioner(tempDir, {
			javascriptSkills: [AGENT_MESSAGE_SKILL],
			hostHandlers: {
				"agent_message.send": async (payload) => ({
					receipts: [
						{
							id: "agentmsg-root",
							source: "agent_message",
							target: { activeSessionId: "root", sessionId: "session-root" },
							message: payload.message,
							deliveryStatus: "delivered",
							deliveredAt: "2026-08-03T00:00:00.000Z",
						},
						{ target: "sibling", error: "rate limited" },
					],
				}),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
const receipt = await agentMessage.broadcast("status");
console.log(JSON.stringify(receipt));
`);

		expect(result.status).toBe("ok");
		expect(JSON.parse(result.stdout.trim())).toMatchObject({
			receipts: [
				{ id: "agentmsg-root", deliveryStatus: "delivered" },
				{ target: "sibling", error: "rate limited" },
			],
		});
		expect(result.sentAgentMessages).toEqual([
			{
				id: "agentmsg-root",
				message: "status",
				deliveryStatus: "delivered",
				target: { activeSessionId: "root", sessionId: "session-root" },
			},
		]);
	});

	it("rejects invalid role selectors before reaching the host", async () => {
		let hostRequestCount = 0;
		provisioner = new BunKernelProvisioner(tempDir, {
			javascriptSkills: [AGENT_MESSAGE_SKILL],
			hostHandlers: {
				"agent_message.send": async () => {
					hostRequestCount += 1;
					return {};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
for (const options of [
  { receiverRole: "sibling" },
  { receiverRole: "parent", receiverName: "root" },
  { receiverRole: "invalid", receiverName: "beta" },
]) {
  try {
    await agentMessage.send("secret", options);
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
  }
}
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim().split("\n")).toEqual([
			"receiverName is required for sibling and child messages",
			"receiverName must be omitted for parent messages",
			'receiverRole must be "parent", "sibling", or "child"',
		]);
		expect(hostRequestCount).toBe(0);
	});

	it("captures sent messages from detached tasks after the cell is idle", async () => {
		provisioner = new BunKernelProvisioner(tempDir, {
			javascriptSkills: [AGENT_MESSAGE_SKILL],
			hostHandlers: {
				"agent_message.send": async (payload) => ({
					id: "agentmsg-background",
					source: "agent_message",
					target: { activeSessionId: payload.receiver_name, sessionId: "session-beta", sessionName: "Beta" },
					message: payload.message,
					deliveryStatus: "delivered",
					deliveredAt: "2026-07-10T00:00:00.000Z",
				}),
			},
		});

		const manager = await provisioner.ensure();
		let resolveLateMessage!: (message: KernelSentAgentMessage) => void;
		const lateMessage = new Promise<KernelSentAgentMessage>((resolve) => {
			resolveLateMessage = resolve;
		});
		const result = await manager.execute(
			`setTimeout(() => void agentMessage.send("background hello", {
  receiverRole: "sibling",
  receiverName: "beta",
}), 50);`,
			{ onLateSentAgentMessage: resolveLateMessage },
		);

		expect(result.status).toBe("ok");
		expect(result.sentAgentMessages).toBeUndefined();
		await expect(lateMessage).resolves.toEqual({
			id: "agentmsg-background",
			message: "background hello",
			deliveryStatus: "delivered",
			receiverRole: "sibling",
			target: { activeSessionId: "beta", sessionId: "session-beta", sessionName: "Beta" },
		});
	});

	it("bounds retained handlers for late sent messages", async () => {
		const manager = new KernelManager({ cwd: tempDir });
		const host = manager as unknown as LateHandlerRetentionHost;
		const handler = () => {};

		for (let index = 0; index < 300; index += 1) {
			host.registerLateSentAgentMessageHandler(`request-${index}`, handler);
		}

		expect(host.lateSentAgentMessageHandlers.size).toBe(256);
		expect(host.lateSentAgentMessageHandlers.has("request-0")).toBe(false);
		expect(host.lateSentAgentMessageHandlers.has("request-299")).toBe(true);
		await manager.dispose();
	});
});
