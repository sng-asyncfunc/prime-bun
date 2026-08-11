import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import type { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";

function makeState(activeSessionId: string): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set(),
		pendingAttaches: 0,
		lastEventSequence: 0,
		runtime: { metadata: { kind: "subagent", createdAt: 1 } },
	} as unknown as ActiveSessionState;
}

function makeClient(id: string, activeSessionId: string): DaemonSocketClient {
	return {
		id,
		socket: { destroyed: false } as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		detachInput: vi.fn(),
		supportsExtensionUi: false,
		capabilities: new Set(),
	};
}

function makeDaemonClient(supported: boolean) {
	const request = vi.fn(async () => ({
		type: "response" as const,
		command: "mutate_queued_message",
		success: true as const,
		data: { status: "applied" as const },
	}));
	const client = {
		request,
		supportsServerCapability: (capability: string) => supported && capability === "queue_message_mutation",
		onMessage: () => () => {},
		onClose: () => () => {},
	} as unknown as DaemonClient;
	return { client, request };
}

describe("queued message mutation daemon bridge", () => {
	it("does not send the command to an older daemon", async () => {
		const { client, request } = makeDaemonClient(false);
		const connection = new DaemonAgentConnection(client, "active-1");

		await expect(connection.mutateQueuedMessage("steering", 0, "original", { type: "delete" })).resolves.toBe(
			"unsupported",
		);
		expect(request).not.toHaveBeenCalled();
	});

	it("sends capability-gated mutations to a supporting daemon", async () => {
		const { client, request } = makeDaemonClient(true);
		const connection = new DaemonAgentConnection(client, "active-1");
		const mutation = { type: "replace", text: "edited", lane: "followUp" } as const;

		await expect(connection.mutateQueuedMessage("followUp", 1, "original", mutation)).resolves.toBe("applied");
		expect(request).toHaveBeenCalledWith(
			{
				type: "mutate_queued_message",
				activeSessionId: "active-1",
				lane: "followUp",
				index: 1,
				expectedText: "original",
				mutation,
			},
			undefined,
			undefined,
		);
	});

	it("routes mutations from the daemon socket to the active session", async () => {
		const daemon = new AgentDaemon("/tmp/prime-bun-queue-mutation-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-bun-queue-mutation-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const mutateQueuedMessage = vi.fn(() => "applied" as const);
		const state = makeState("active-1");
		(state.runtime as { session: unknown }).session = { mutateQueuedMessage };
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);
		const mutation = { type: "replace", text: "edited", lane: "followUp" } as const;

		await expect(
			internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				type: "mutate_queued_message",
				activeSessionId: state.activeSessionId,
				lane: "followUp",
				index: 0,
				expectedText: "original",
				mutation,
			}),
		).resolves.toMatchObject({ success: true, data: { status: "applied" } });
		expect(mutateQueuedMessage).toHaveBeenCalledWith("followUp", 0, "original", mutation);
	});
});
