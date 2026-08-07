import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureKernelBun } from "../src/core/kernel/bootstrap.js";
import { KernelManager } from "../src/core/kernel/index.js";
import type { JavaScriptSkillRuntimeInfo } from "../src/core/skills.js";

let tempDir = "";
let originalKernelDirectory: string | undefined;

function writePackageJson(packagePath: string, dependencies: Record<string, string>): void {
	writeFileSync(
		join(packagePath, "package.json"),
		`${JSON.stringify({ dependencies, private: true, type: "module" })}\n`,
	);
}

function runtimeInfo(packagePath: string, name: string): JavaScriptSkillRuntimeInfo {
	return {
		entryPath: join(packagePath, "src", "index.ts"),
		globalName: name.replaceAll("-", "_"),
		name,
		packageJsonPath: join(packagePath, "package.json"),
		packagePath,
	};
}

function writeLocalDependency(packagePath: string, name: string, value: string): void {
	const dependencyPath = join(packagePath, "vendor", name);
	mkdirSync(dependencyPath, { recursive: true });
	writeFileSync(
		join(dependencyPath, "package.json"),
		`${JSON.stringify({ exports: "./index.js", name, type: "module", version: "1.0.0" })}\n`,
	);
	writeFileSync(join(dependencyPath, "index.js"), `export default ${JSON.stringify(value)};\n`);
}

describe("JavaScript skill dependency isolation", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-skill-isolation-"));
		originalKernelDirectory = process.env.PRIME_AGENT_KERNEL_BUN_DIR;
		process.env.PRIME_AGENT_KERNEL_BUN_DIR = join(tempDir, "kernel-bun");
	});

	afterEach(() => {
		if (originalKernelDirectory === undefined) delete process.env.PRIME_AGENT_KERNEL_BUN_DIR;
		else process.env.PRIME_AGENT_KERNEL_BUN_DIR = originalKernelDirectory;
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = "";
	});

	it("keeps a failed dependency skill unavailable even when an ancestor module could satisfy it", async () => {
		const skillsRoot = join(tempDir, "skills");
		const brokenPath = join(skillsRoot, "broken-skill");
		const healthyPath = join(skillsRoot, "healthy-skill");
		const ancestorDependency = join(skillsRoot, "node_modules", "broken-dependency");
		mkdirSync(join(brokenPath, "src"), { recursive: true });
		mkdirSync(join(healthyPath, "src"), { recursive: true });
		mkdirSync(ancestorDependency, { recursive: true });
		writePackageJson(brokenPath, { "broken-dependency": "file:./missing-dependency" });
		writePackageJson(healthyPath, {});
		writeFileSync(
			join(ancestorDependency, "package.json"),
			`${JSON.stringify({ exports: "./index.js", name: "broken-dependency", type: "module" })}\n`,
		);
		writeFileSync(join(ancestorDependency, "index.js"), 'export default "ancestor-loaded";\n');
		writeFileSync(
			join(brokenPath, "src", "index.ts"),
			'import value from "broken-dependency";\nexport default async () => value;\n',
		);
		writeFileSync(join(healthyPath, "src", "index.ts"), 'export default async () => "healthy-loaded";\n');
		const manager = new KernelManager({
			cwd: tempDir,
			env: { BUN_CONFIG_NO_INSTALL: "1" },
			javascriptSkills: [runtimeInfo(brokenPath, "broken-skill"), runtimeInfo(healthyPath, "healthy-skill")],
		});

		try {
			const result = await manager.execute(`
try { console.log(await broken_skill()); } catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
console.log(await healthy_skill());
`);

			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("dependencies are unavailable");
			expect(result.stdout).toContain("healthy-loaded");
			expect(result.stdout).not.toContain("ancestor-loaded");
			expect(manager.status.diagnostics).toContain("broken-skill dependencies are unavailable");
		} finally {
			await manager.dispose();
		}
	}, 30_000);

	it("dereferences a symlinked skill package into its managed cache", async () => {
		const actualPath = join(tempDir, "actual", "linked-skill");
		const linkedPath = join(tempDir, "linked", "linked-skill");
		mkdirSync(join(actualPath, "src"), { recursive: true });
		mkdirSync(join(tempDir, "linked"), { recursive: true });
		writeLocalDependency(actualPath, "linked-dependency", "linked-loaded");
		writePackageJson(actualPath, { "linked-dependency": "file:./vendor/linked-dependency" });
		writeFileSync(
			join(actualPath, "src", "index.ts"),
			'import value from "linked-dependency";\nexport default { value: () => value };\n',
		);
		symlinkSync(actualPath, linkedPath, "dir");
		const skill = runtimeInfo(linkedPath, "linked-skill");
		const prepared = await ensureKernelBun({ javascriptSkills: [skill] });
		const preparedSkill = prepared.preparedSkills[0];
		expect(preparedSkill).toBeDefined();
		const preparedPackagePath = realpathSync(preparedSkill?.packagePath ?? "");
		const kernelDirectory = realpathSync(prepared.kernelDirectory);
		expect(preparedPackagePath.startsWith(`${kernelDirectory}${sep}`)).toBe(true);
		expect(preparedPackagePath).not.toBe(realpathSync(actualPath));
		expect(existsSync(join(linkedPath, "node_modules"))).toBe(false);

		const manager = new KernelManager({
			cwd: tempDir,
			env: { BUN_CONFIG_NO_INSTALL: "1" },
			javascriptSkills: [skill],
		});
		try {
			const result = await manager.execute("linked_skill.value();");
			expect(result).toMatchObject({ result: '"linked-loaded"', status: "ok" });
		} finally {
			await manager.dispose();
		}
	}, 30_000);

	it("keeps running managers on immutable source generations", async () => {
		const packagePath = join(tempDir, "skills", "mutable-skill");
		mkdirSync(join(packagePath, "src"), { recursive: true });
		writeLocalDependency(packagePath, "generation-dependency", "installed");
		writePackageJson(packagePath, { "generation-dependency": "file:./vendor/generation-dependency" });
		writeFileSync(
			join(packagePath, "src", "index.ts"),
			[
				'import { readFile } from "node:fs/promises";',
				"export default { value: async () => (await readFile(new URL('../value.txt', import.meta.url), 'utf8')).trim() };",
				"",
			].join("\n"),
		);
		writeFileSync(join(packagePath, "value.txt"), "generation-a\n");
		const skill = runtimeInfo(packagePath, "mutable-skill");
		const first = new KernelManager({ cwd: tempDir, javascriptSkills: [skill] });
		const second = new KernelManager({ cwd: tempDir, javascriptSkills: [skill] });

		try {
			expect(await first.execute("await mutable_skill.value();")).toMatchObject({
				result: '"generation-a"',
				status: "ok",
			});
			writeFileSync(join(packagePath, "value.txt"), "generation-b\n");
			const dependencyCaches = readdirSync(join(tempDir, "kernel-bun", "skill-deps"), {
				withFileTypes: true,
			}).filter((entry) => entry.isDirectory() && !entry.name.endsWith(".bootstrap.lock"));
			expect(dependencyCaches).toHaveLength(1);
			rmSync(join(tempDir, "kernel-bun", "skill-deps", dependencyCaches[0]?.name ?? "", ".skill-dependencies.json"));
			expect(await second.execute("await mutable_skill.value();")).toMatchObject({
				result: '"generation-b"',
				status: "ok",
			});
			expect(await first.execute("await mutable_skill.value();")).toMatchObject({
				result: '"generation-a"',
				status: "ok",
			});
		} finally {
			await Promise.all([first.dispose(), second.dispose()]);
		}
	}, 30_000);
});
