import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
	assertSupportedBunVersion,
	characterizeBunSerialization,
	MINIMUM_BUN_VERSION,
	resolveBunRuntime,
} from "../src/core/kernel/bun-runtime.js";

describe("Bun runtime contract", () => {
	it("requires Bun 1.3.14 or newer", () => {
		expect(MINIMUM_BUN_VERSION).toBe("1.3.14");
		expect(() => assertSupportedBunVersion("1.3.13")).toThrow(/requires Bun 1\.3\.14 or newer/);
		expect(() => assertSupportedBunVersion("1.3.14")).not.toThrow();
		expect(() => assertSupportedBunVersion("1.4.0")).not.toThrow();
		expect(() => assertSupportedBunVersion("not-a-version")).toThrow(/invalid Bun version/i);
	});

	it("prefers PRIME_AGENT_KERNEL_BUN over PATH and the home install", async () => {
		const findOnPath = vi.fn(async () => "/path/bun");
		const readVersion = vi.fn(async () => "1.3.14");

		const runtime = await resolveBunRuntime({
			env: { PRIME_AGENT_KERNEL_BUN: "/override/bun" },
			findOnPath,
			homeDirectory: "/home/tester",
			readVersion,
		});

		expect(runtime).toEqual({ path: "/override/bun", version: "1.3.14" });
		expect(findOnPath).not.toHaveBeenCalled();
		expect(readVersion).toHaveBeenCalledWith("/override/bun");
	});

	it("uses Bun from PATH before the home install", async () => {
		const readVersion = vi.fn(async () => "1.3.14");

		const runtime = await resolveBunRuntime({
			env: {},
			findOnPath: async () => "/path/bun",
			homeDirectory: "/home/tester",
			readVersion,
		});

		expect(runtime.path).toBe("/path/bun");
		expect(readVersion).toHaveBeenCalledWith("/path/bun");
	});

	it("falls back to ~/.bun/bin/bun", async () => {
		const readVersion = vi.fn(async () => "1.3.14");

		const runtime = await resolveBunRuntime({
			env: {},
			findOnPath: async () => undefined,
			homeDirectory: "/home/tester",
			readVersion,
		});

		expect(runtime.path).toBe("/home/tester/.bun/bin/bun");
		expect(readVersion).toHaveBeenCalledWith("/home/tester/.bun/bin/bun");
	});

	it("reports an actionable error when no Bun runtime exists", async () => {
		await expect(
			resolveBunRuntime({
				env: {},
				findOnPath: async () => undefined,
				homeDirectory: "/missing",
				readVersion: async () => {
					throw new Error("ENOENT");
				},
			}),
		).rejects.toThrow(/install Bun 1\.3\.14 or newer/i);
	});

	it("characterizes bun:jsc snapshot fidelity", { tags: ["kernel-heavy"], timeout: 30_000 }, async () => {
		const runtime = await resolveBunRuntime({
			homeDirectory: homedir(),
		});
		const matrix = await characterizeBunSerialization(runtime.path);

		expect(matrix).toMatchObject({
			primitive: "preserved",
			plainObject: "preserved",
			cycle: "preserved",
			date: "preserved",
			regexp: "preserved",
			map: "preserved",
			set: "preserved",
			arrayBuffer: "preserved",
			typedArray: "preserved",
			function: "rejected",
			promise: "rejected",
			weakCollection: "rejected",
			customClass: "degraded",
		});
	});
});
