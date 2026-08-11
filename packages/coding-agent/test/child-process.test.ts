import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { isProcessAlive, isZombieProcess, processIdExists, waitForChildProcess } from "../src/utils/child-process.js";

describe("process liveness", () => {
	it("treats the current process as alive and not a zombie", () => {
		expect(processIdExists(process.pid)).toBe(true);
		expect(isZombieProcess(process.pid)).toBe(false);
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it("treats an exited process as dead", async () => {
		const child = spawn(process.execPath, ["--eval", "process.exit(0)"], { stdio: "ignore" });
		const pid = child.pid;
		if (pid === undefined) throw new Error("Test child did not start");
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		expect(isProcessAlive(pid)).toBe(false);
	});
});

describe("waitForChildProcess", () => {
	it("reports signaled already-exited children as failures", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: null,
			stderr: null,
			exitCode: null,
			signalCode: "SIGTERM" as NodeJS.Signals,
		});

		await expect(waitForChildProcess(child as unknown as ChildProcess)).resolves.toBe(143);
	});
});
