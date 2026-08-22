import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";

type Harness = {
	_goalState: { status: string; objective?: string; continuationsUsed: number };
	_goalContinuationAwaitsRlmWork: boolean;
	_disposed: boolean;
	_disposing: boolean;
	_queuedWorkPauses: Set<symbol>;
	_sessionInputPumpSuspended: boolean;
	hasRunningRlmChildren: () => boolean;
	_stopGoalContinuationForTerminalMessage: () => boolean;
	_ensureGoalRuntimeActive: () => void;
	_setGoalState: (goal: unknown) => void;
	_createPreparedTurnAction: ReturnType<typeof vi.fn>;
	_admitSessionInput: ReturnType<typeof vi.fn>;
};

const getGoalContinuation = Reflect.get(AgentSession.prototype, "_getGoalContinuationMessages") as (
	this: Harness,
	context: { message: unknown; context: unknown },
) => Promise<unknown[]>;
const maybeResume = Reflect.get(AgentSession.prototype, "_maybeResumeGoalContinuationAfterRlmWork") as (
	this: Harness,
) => void;

function harness(overrides: Partial<Harness> = {}): Harness {
	return {
		_goalState: { status: "active", objective: "ship it", continuationsUsed: 0 },
		_goalContinuationAwaitsRlmWork: false,
		_disposed: false,
		_disposing: false,
		_queuedWorkPauses: new Set(),
		_sessionInputPumpSuspended: false,
		hasRunningRlmChildren: () => false,
		_stopGoalContinuationForTerminalMessage: () => false,
		_ensureGoalRuntimeActive: () => {},
		_setGoalState: function (this: Harness, goal: unknown) {
			this._goalState = goal as Harness["_goalState"];
		},
		_createPreparedTurnAction: vi.fn((schedule: string, _text: string, _images: unknown, options: unknown) => ({
			schedule,
			options,
		})),
		_admitSessionInput: vi.fn(),
		...overrides,
	};
}

const context = { message: { role: "assistant", stopReason: "stop" }, context: {} };

describe("goal continuation vs running Bun subagents", () => {
	it("defers without counting while a descendant is running", async () => {
		const mode = harness({ hasRunningRlmChildren: () => true });
		await expect(getGoalContinuation.call(mode, context)).resolves.toEqual([]);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
		expect(mode._goalState.continuationsUsed).toBe(0);
	});

	it("resumes exactly once after descendants finish", () => {
		const mode = harness({ _goalContinuationAwaitsRlmWork: true });
		maybeResume.call(mode);
		maybeResume.call(mode);
		expect(mode._admitSessionInput).toHaveBeenCalledTimes(1);
		const [action] = mode._admitSessionInput.mock.calls[0]!;
		expect((action as { options: { resumeIfIdle: boolean } }).options.resumeIfIdle).toBe(true);
		expect(mode._goalState.continuationsUsed).toBe(1);
	});

	it("waits through scheduler pauses and abort suspension", () => {
		const paused = harness({
			_goalContinuationAwaitsRlmWork: true,
			_queuedWorkPauses: new Set([Symbol("pause")]),
		});
		maybeResume.call(paused);
		expect(paused._admitSessionInput).not.toHaveBeenCalled();
		expect(paused._goalContinuationAwaitsRlmWork).toBe(true);

		const suspended = harness({ _goalContinuationAwaitsRlmWork: true, _sessionInputPumpSuspended: true });
		maybeResume.call(suspended);
		expect(suspended._admitSessionInput).not.toHaveBeenCalled();
		expect(suspended._goalContinuationAwaitsRlmWork).toBe(true);
	});

	it("keeps the deferral and count when admission races a pause", () => {
		const mode = harness({
			_goalContinuationAwaitsRlmWork: true,
			_admitSessionInput: vi.fn(() => {
				throw new Error("admission race");
			}),
		});
		maybeResume.call(mode);
		expect(mode._goalContinuationAwaitsRlmWork).toBe(true);
		expect(mode._goalState.continuationsUsed).toBe(0);
	});

	it("drops stale deferrals for inactive goals", () => {
		const mode = harness({ _goalContinuationAwaitsRlmWork: true });
		mode._goalState = { status: "paused", objective: "ship it", continuationsUsed: 0 };
		maybeResume.call(mode);
		expect(mode._admitSessionInput).not.toHaveBeenCalled();
		expect(mode._goalContinuationAwaitsRlmWork).toBe(false);
	});
});
