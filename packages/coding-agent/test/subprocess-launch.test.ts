import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorCliSubprocessTsconfig, createCliSubprocessEnv } from "../src/cli/subprocess-launch.js";

describe("CLI subprocess environment", () => {
	it("anchors a relative tsx config before a worker changes cwd", () => {
		const environment = createCliSubprocessEnv(
			{ TSX_TSCONFIG_PATH: "tsconfig.json" },
			"packages/coding-agent/src/cli.ts",
			["--import", "tsx"],
		);

		expect(environment.TSX_TSCONFIG_PATH).toBe(resolve("tsconfig.json"));
	});

	it("preserves an absolute tsx config", () => {
		const tsconfigPath = resolve("tsconfig.json");
		const environment = createCliSubprocessEnv(
			{ TSX_TSCONFIG_PATH: tsconfigPath },
			"packages/coding-agent/src/cli.ts",
			["--import", "tsx"],
		);

		expect(environment.TSX_TSCONFIG_PATH).toBe(tsconfigPath);
	});

	it("anchors the parent environment before the CLI changes cwd", () => {
		const environment = { TSX_TSCONFIG_PATH: "tsconfig.json" };
		anchorCliSubprocessTsconfig(environment, "/repo");

		expect(environment.TSX_TSCONFIG_PATH).toBe("/repo/tsconfig.json");
	});
});
