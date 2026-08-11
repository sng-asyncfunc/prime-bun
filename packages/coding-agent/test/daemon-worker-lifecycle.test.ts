import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { shouldShowAgentsViewSession } from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

type WorkerLike = {
	descriptor: {
		workerId: string;
		pid: number;
		processStartId?: string;
		rootActiveSessionId: string;
		lifecycle: "ready" | "recovering";
		stopRequestedAt?: string;
		archiveOnStop?: boolean;
	};
	client?: object;
	recovery?: Promise<void>;
	intentionalStop: boolean;
	stopRevision: number;
	stopFinalization?: Promise<void>;
	summaries: Map<string, SessionSummary>;
};

type SupervisorPrivate = {
	effectiveWorkerState(worker: WorkerLike): string;
	requireAvailableWorkerClient(worker: WorkerLike): object;
	handleList(
		client: object,
		command: { id: string; type: "list" },
	): Promise<{
		success: boolean;
		data?: { sessions: Array<{ activeSessionId?: string; id: string; workerState?: string }> };
	}>;
	adoptOrRecoverWorker(worker: WorkerLike): Promise<void>;
	reclaimStaleWorkerRegistration(worker: WorkerLike): Promise<boolean>;
	processIdentity(pid: number, processStartId: string | undefined): string;
	stopWorker(
		worker: object,
		removeDescriptor: boolean,
		force: boolean,
		archiveSession: boolean,
		recoveryCleanup: boolean,
		directChild: { child: object; closed: Promise<void> },
	): Promise<void>;
};

function summary(activeSessionId: string): SessionSummary {
	return {
		id: activeSessionId,
		activeSessionId,
		sessionId: `${activeSessionId}-session`,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function worker(workerId: string, options: { stopped?: boolean; connected?: boolean; pid?: number } = {}): WorkerLike {
	const activeSessionId = `${workerId}-active`;
	return {
		descriptor: {
			workerId,
			pid: options.pid ?? process.pid,
			rootActiveSessionId: activeSessionId,
			lifecycle: "ready",
			...(options.stopped ? { stopRequestedAt: new Date().toISOString() } : {}),
		},
		...(options.connected === false ? {} : { client: {} }),
		intentionalStop: false,
		stopRevision: 0,
		summaries: new Map([[activeSessionId, summary(activeSessionId)]]),
	};
}

function privateSupervisor(fields: Record<string, unknown> = {}): SupervisorPrivate {
	return Object.assign(Object.create(DaemonSupervisor.prototype), fields) as SupervisorPrivate;
}

describe("daemon worker lifecycle", () => {
	afterEach(() => vi.useRealTimers());

	it("reports stop intent and disconnection honestly", () => {
		const supervisor = privateSupervisor();
		expect(supervisor.effectiveWorkerState(worker("stopping", { stopped: true }))).toBe("stopping");
		expect(supervisor.effectiveWorkerState(worker("disconnected", { connected: false }))).toBe("recovering");
		expect(supervisor.effectiveWorkerState(worker("ready"))).toBe("ready");
		expect(() => supervisor.requireAvailableWorkerClient(worker("blocked", { stopped: true }))).toThrow(
			"Session worker is stopping",
		);
	});

	it("hides unavailable workers from Agents View without hiding them from daemon safety checks", async () => {
		const liveWorker = worker("live");
		const stoppingWorker = worker("stopping", { stopped: true });
		const refreshWorkerSummaries = vi.fn(async () => {});
		const supervisor = privateSupervisor({
			workers: new Map([
				[liveWorker.descriptor.workerId, liveWorker],
				[stoppingWorker.descriptor.workerId, stoppingWorker],
			]),
			clients: new Set(),
			refreshWorkerSummaries,
			syncAgentPeers: vi.fn(async () => {}),
		});

		const response = await supervisor.handleList({}, { id: "list-1", type: "list" });
		expect(response.data?.sessions.map((entry) => entry.workerState).sort()).toEqual(["ready", "stopping"]);
		expect(refreshWorkerSummaries).toHaveBeenCalledTimes(1);
		expect(shouldShowAgentsViewSession({ ...summary("stopping-active"), workerState: "stopping" })).toBe(false);
		expect(shouldShowAgentsViewSession({ ...summary("ready-active"), workerState: "ready" })).toBe(true);
		expect(shouldShowAgentsViewSession(summary("old-daemon-active"))).toBe(true);
	});

	it("arms background finalization when a forced direct child stop exceeds its deadline", async () => {
		vi.useFakeTimers();
		const scheduleWorkerStopFinalization = vi.fn();
		const timedOutWorker = {
			descriptor: {
				workerId: "timed-out",
				pid: 2_147_483_647,
				rootActiveSessionId: "timed-out-active",
				lifecycle: "ready",
			},
			intentionalStop: false,
			stopRevision: 0,
			snapshotGenerations: new Map(),
			transcriptCaches: new Map(),
			snapshotCache: new Map(),
		};
		const child = {
			exitCode: null,
			signalCode: null,
			kill: vi.fn(() => true),
		};
		const supervisor = privateSupervisor({
			shuttingDown: false,
			persistWorkerStopTombstone: vi.fn(),
			scheduleWorkerStopFinalization,
		});

		const stopping = supervisor.stopWorker(timedOutWorker, true, true, false, false, {
			child,
			closed: new Promise<void>(() => {}),
		});
		const outcome = stopping.then(
			() => "stopped",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		await vi.advanceTimersByTimeAsync(2000);

		await expect(outcome).resolves.toContain("did not stop after SIGKILL");
		expect(scheduleWorkerStopFinalization).toHaveBeenCalledWith(timedOutWorker);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("captures a legacy worker identity only after its socket authenticates", async () => {
		const legacy = worker("legacy", { stopped: true });
		legacy.descriptor.processStartId = undefined;
		const order: string[] = [];
		const persistWorker = vi.fn(() => order.push("persist"));
		const stopWorker = vi.fn(async () => {
			order.push("stop");
		});
		const supervisor = privateSupervisor({
			assertRecoveryAllowed: vi.fn(async () => {}),
			connectWorker: vi.fn(async () => {
				order.push("connect");
			}),
			persistWorker,
			stopWorker,
			log: vi.fn(),
		});

		await supervisor.adoptOrRecoverWorker(legacy);
		expect(legacy.descriptor.processStartId).toBe(getProcessStartId(process.pid));
		expect(order).toEqual(["connect", "persist", "stop"]);
	});

	it("keeps an unauthenticated legacy pid untrusted", async () => {
		const legacy = worker("legacy-untrusted", { stopped: true });
		legacy.descriptor.processStartId = undefined;
		const persistWorker = vi.fn();
		const stopWorker = vi.fn(async () => {});
		const supervisor = privateSupervisor({
			assertRecoveryAllowed: vi.fn(async () => {}),
			connectWorker: vi.fn(async () => {
				throw new Error("socket unavailable");
			}),
			persistWorker,
			stopWorker,
			log: vi.fn(),
		});

		await supervisor.adoptOrRecoverWorker(legacy);
		expect(legacy.descriptor.processStartId).toBeUndefined();
		expect(persistWorker).not.toHaveBeenCalled();
		expect(stopWorker).toHaveBeenCalledWith(legacy, true, true, false);
	});

	it("single-flights cleanup when concurrent resumes find a confirmed-dead registration", async () => {
		const stale = worker("stale", { stopped: true, connected: false, pid: 2_147_483_647 });
		const workers = new Map([[stale.descriptor.workerId, stale]]);
		const stopWorker = vi.fn(async () => {
			workers.delete(stale.descriptor.workerId);
		});
		const supervisor = privateSupervisor({
			workers,
			shuttingDown: false,
			stopWorker,
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		});

		await expect(
			Promise.all([
				supervisor.reclaimStaleWorkerRegistration(stale),
				supervisor.reclaimStaleWorkerRegistration(stale),
			]),
		).resolves.toEqual([true, true]);
		expect(stopWorker).toHaveBeenCalledTimes(1);
	});

	it("never reclaims a live worker or mistakes a recycled pid for the registered process", async () => {
		const live = worker("live-stop", { stopped: true, connected: false });
		live.descriptor.processStartId = getProcessStartId(process.pid);
		const stopWorker = vi.fn(async () => {});
		const supervisor = privateSupervisor({
			workers: new Map([[live.descriptor.workerId, live]]),
			stopWorker,
			log: vi.fn(),
			reportCleanupFailure: vi.fn(),
		});

		await expect(supervisor.reclaimStaleWorkerRegistration(live)).resolves.toBe(false);
		expect(stopWorker).not.toHaveBeenCalled();
		const identity = supervisor.processIdentity(process.pid, "definitely-not-this-process");
		expect(identity === "replaced" || identity === "unknown").toBe(true);
	});
});
