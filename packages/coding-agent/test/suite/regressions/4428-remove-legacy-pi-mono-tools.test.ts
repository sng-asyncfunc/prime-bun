import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.js";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { allToolNames, createAllToolDefinitions } from "../../../src/core/tools/index.js";

describe("regression #4428: remove legacy pi-mono built-in tools", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-remove-legacy-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers only javascript as a built-in tool", () => {
		expect([...allToolNames]).toEqual(["javascript"]);
		expect(Object.keys(createAllToolDefinitions(process.cwd()))).toEqual(["javascript"]);
	});

	it("keeps legacy names available for extension and custom tool allowlists", () => {
		const result = parseArgs(["--tools", "bash,edit,javascript"]);

		expect(result.tools).toEqual(["bash", "edit", "javascript"]);
		expect(result.diagnostics).toEqual([]);
	});

	it("does not expose removed built-in tool names when only they are requested", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["bash", "edit"],
		});
		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toEqual([]);
		expect(session.getActiveToolNames()).toEqual([]);
		session.dispose();
	});

	it("allowlists an extension tool that reuses a legacy built-in name", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "bash",
							label: "Custom Bash",
							description: "Tool registered from session_start",
							promptSnippet: "Run custom shell behavior",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["bash"],
		});
		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toEqual(["bash"]);
		expect(session.getActiveToolNames()).toEqual(["bash"]);
		session.dispose();
	});

	it("applies configured shell settings from Bun cells", async () => {
		const shellPath = join(tempDir, "custom-shell.sh");
		writeFileSync(shellPath, "#!/bin/sh\nprintf 'custom-shell\\n'\nexec /bin/sh \"$@\"\n");
		chmodSync(shellPath, 0o755);

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setShellCommandPrefix("echo prefix-from-settings");
		settingsManager.setShellPath(shellPath);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["javascript"],
		});

		try {
			expect(session.getActiveToolNames()).toEqual(["javascript"]);
			const javascriptTool = session.agent.state.tools.find((tool) => tool.name === "javascript");
			expect(javascriptTool).toBeTruthy();

			const result = await javascriptTool!.execute("tool-1", {
				code: 'const shellResult = await sh("echo body"); console.log(shellResult.stdout.trimEnd())',
			});
			const output = result.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text)
				.join("");

			expect(output).toContain("custom-shell\nprefix-from-settings\nbody");
		} finally {
			await session.disposeAsync();
		}
	});
});
