import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import type { BashOperations } from "../../../src/core/tools/bash.js";
import { createHarness, getAssistantTexts } from "../harness.js";

test("idle waiting yields to IO while bash blocks queued prompts", async () => {
	const harness = await createHarness();
	let releaseBash = () => {};
	const gate = new Promise<{ exitCode: number | null }>((resolve) => {
		releaseBash = () => resolve({ exitCode: 0 });
	});
	try {
		const session = harness.session;
		const operations: BashOperations = { exec: async () => await gate };
		const bash = session.executeBash("blocked", undefined, { operations });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(session.isBashRunning).toBe(true);
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
		const first = session.prompt("queued while bash runs");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const internals = session as unknown as { _scheduleSessionInputPump(): void };
		const schedule = internals._scheduleSessionInputPump.bind(session);
		let schedules = 0;
		internals._scheduleSessionInputPump = () => {
			if (++schedules === 200) releaseBash();
			schedule();
		};
		let second: Promise<void> | undefined;
		const idle = session.waitForIdle();
		setImmediate(() => {
			second = session.prompt("queued during park");
			second.catch(() => undefined);
			releaseBash();
		});
		await idle;
		await bash;
		await first;
		await second;
		expect(schedules).toBeLessThan(200);
		expect(getAssistantTexts(harness)).toEqual(["first done", "second done"]);
	} finally {
		releaseBash();
		harness.cleanup();
	}
});

test.each([false, true])("direct bash completion resumes a parked prompt (failure: %s)", async (fail) => {
	const harness = await createHarness();
	let releaseBash = () => {};
	const gate = new Promise<{ exitCode: number | null }>((resolve) => {
		releaseBash = () => resolve({ exitCode: 0 });
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const session = harness.session;
		const bash = session
			.executeBash("blocked", undefined, {
				operations: {
					exec: async () => {
						const result = await gate;
						if (fail) throw new Error("shell failed");
						return result;
					},
				},
			})
			.catch(() => undefined);
		harness.setResponses([fauxAssistantMessage("resumed")]);
		const prompt = session.prompt("queued");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const idle = session.waitForIdle();
		setImmediate(releaseBash);
		const finished = Promise.all([bash, prompt, idle]).then(() => true);
		const deadline = new Promise<boolean>((resolve) => {
			timeout = setTimeout(() => resolve(false), 500);
		});
		expect(await Promise.race([finished, deadline])).toBe(true);
		expect(getAssistantTexts(harness)).toEqual(["resumed"]);
	} finally {
		clearTimeout(timeout);
		releaseBash();
		harness.cleanup();
	}
});

test("extension bash dispatch failure wakes queued work", async () => {
	const harness = await createHarness();
	let rejectDispatch = () => {};
	const dispatch = new Promise<never>((_resolve, reject) => {
		rejectDispatch = () => reject(new Error("dispatch failed"));
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const intercepted = vi.spyOn(harness.session.extensionRunner, "emitUserBash").mockImplementation(() => dispatch);
	try {
		const session = harness.session;
		const bash = session.runUserBash("blocked").catch(() => undefined);
		harness.setResponses([fauxAssistantMessage("recovered")]);
		const prompt = session.prompt("queued");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const idle = session.waitForIdle();
		setImmediate(rejectDispatch);
		const deadline = new Promise<boolean>((resolve) => {
			timeout = setTimeout(() => resolve(false), 500);
		});
		expect(await Promise.race([Promise.all([bash, prompt, idle]).then(() => true), deadline])).toBe(true);
		expect(getAssistantTexts(harness)).toEqual(["recovered"]);
	} finally {
		clearTimeout(timeout);
		rejectDispatch();
		intercepted.mockRestore();
		harness.cleanup();
	}
});
