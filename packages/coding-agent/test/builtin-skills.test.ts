import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { loadSkillsFromDir } from "../src/core/skills.js";

function writeSkill(dir: string, name: string, description = `Description for ${name}`): void {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---
name: ${name}
description: ${description}
---
Content for ${name}.`,
	);
}

describe("builtin skills", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let bundledDir: string;
	let settingsManager: SettingsManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `builtin-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		bundledDir = join(tempDir, "bundled-skills");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		mkdirSync(bundledDir, { recursive: true });
		settingsManager = SettingsManager.inMemory();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("DefaultPackageManager", () => {
		it("resolves bundled skills with builtin source at lowest precedence", async () => {
			writeSkill(bundledDir, "builtin-skill");

			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: bundledDir,
			});
			const result = await packageManager.resolve();

			const builtin = result.skills.find((r) => r.path === join(bundledDir, "builtin-skill", "SKILL.md"));
			expect(builtin).toBeDefined();
			expect(builtin?.enabled).toBe(true);
			expect(builtin?.metadata.source).toBe("builtin");
			expect(builtin?.metadata.scope).toBe("user");
			expect(builtin?.metadata.baseDir).toBe(bundledDir);
		});

		it("sorts builtin skills after user and project skills so collisions favor local skills", async () => {
			writeSkill(bundledDir, "shared-skill");
			writeSkill(join(agentDir, "skills"), "shared-skill");

			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: bundledDir,
			});
			const result = await packageManager.resolve();

			const paths = result.skills.map((r) => r.path);
			const userIndex = paths.indexOf(join(agentDir, "skills", "shared-skill", "SKILL.md"));
			const builtinIndex = paths.indexOf(join(bundledDir, "shared-skill", "SKILL.md"));
			expect(userIndex).toBeGreaterThanOrEqual(0);
			expect(builtinIndex).toBeGreaterThanOrEqual(0);
			expect(userIndex).toBeLessThan(builtinIndex);
		});

		it("excludes bundled skills when enableBuiltinSkills is false", async () => {
			writeSkill(bundledDir, "builtin-skill");
			settingsManager.setEnableBuiltinSkills(false);

			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: bundledDir,
			});
			const result = await packageManager.resolve();

			expect(result.skills.some((r) => r.metadata.source === "builtin")).toBe(false);
		});

		it("warns when the bundled skills directory is missing (packaging slip)", async () => {
			const missingDir = join(tempDir, "does-not-exist");
			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: missingDir,
			});
			const result = await packageManager.resolve();

			const warning = result.diagnostics.find((d) => d.path === missingDir && d.type === "warning");
			expect(warning).toBeDefined();
			expect(warning?.message).toContain("built-in skills");
		});

		it("warns when the bundled skills directory exists but is empty", async () => {
			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: bundledDir,
			});
			const result = await packageManager.resolve();

			const warning = result.diagnostics.find((d) => d.path === bundledDir && d.type === "warning");
			expect(warning).toBeDefined();
		});

		it("does not warn when bundled skills are present", async () => {
			writeSkill(bundledDir, "builtin-skill");
			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: bundledDir,
			});
			const result = await packageManager.resolve();

			expect(result.diagnostics.some((d) => d.path === bundledDir)).toBe(false);
		});

		it("does not warn when built-in skills are disabled", async () => {
			const missingDir = join(tempDir, "does-not-exist");
			settingsManager.setEnableBuiltinSkills(false);
			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: missingDir,
			});
			const result = await packageManager.resolve();

			expect(result.diagnostics.some((d) => d.path === missingDir)).toBe(false);
		});

		it("disables individual bundled skills via settings override patterns", async () => {
			writeSkill(bundledDir, "builtin-skill");
			writeSkill(bundledDir, "other-skill");
			settingsManager.setSkillPaths(["-builtin-skill/SKILL.md"]);

			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: bundledDir,
			});
			const result = await packageManager.resolve();

			const disabled = result.skills.find((r) => r.path === join(bundledDir, "builtin-skill", "SKILL.md"));
			const enabled = result.skills.find((r) => r.path === join(bundledDir, "other-skill", "SKILL.md"));
			expect(disabled?.enabled).toBe(false);
			expect(enabled?.enabled).toBe(true);
		});
	});

	describe("DefaultResourceLoader", () => {
		it("loads bundled skills with builtin source info", async () => {
			writeSkill(bundledDir, "builtin-skill");

			const loader = new DefaultResourceLoader({ cwd, agentDir, bundledSkillsDir: bundledDir });
			await loader.reload();

			const { skills } = loader.getSkills();
			const builtin = skills.find((s) => s.name === "builtin-skill");
			expect(builtin).toBeDefined();
			expect(builtin?.sourceInfo.source).toBe("builtin");
		});

		it("prefers user skills over bundled skills with the same name", async () => {
			writeSkill(bundledDir, "shared-skill", "Bundled variant");
			writeSkill(join(agentDir, "skills"), "shared-skill", "User variant");

			const loader = new DefaultResourceLoader({ cwd, agentDir, bundledSkillsDir: bundledDir });
			await loader.reload();

			const { skills } = loader.getSkills();
			const winner = skills.find((s) => s.name === "shared-skill");
			expect(winner?.description).toBe("User variant");
		});

		it("excludes bundled skills with --no-skills", async () => {
			writeSkill(bundledDir, "builtin-skill");

			const loader = new DefaultResourceLoader({ cwd, agentDir, bundledSkillsDir: bundledDir, noSkills: true });
			await loader.reload();

			expect(loader.getSkills().skills).toEqual([]);
		});

		it("surfaces a skill diagnostic when the bundled skills dir is missing", async () => {
			const missingDir = join(tempDir, "does-not-exist");
			const loader = new DefaultResourceLoader({ cwd, agentDir, bundledSkillsDir: missingDir });
			await loader.reload();

			const { diagnostics } = loader.getSkills();
			expect(diagnostics.some((d) => d.path === missingDir && d.type === "warning")).toBe(true);
		});
	});

	describe("shipped skill content", () => {
		it("loads all bundled skills without diagnostics", () => {
			const { skills, diagnostics } = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });

			expect(diagnostics).toEqual([]);
			expect(skills.length).toBeGreaterThan(0);
			expect(skills.map((s) => s.name)).toContain("prime-intellect");
			expect(skills.map((s) => s.name)).toContain("skill-creator");
		});

		it("loads the bundled goal skill as a JavaScript skill", () => {
			const { skills } = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });

			const goal = skills.find((s) => s.name === "goal");
			expect(goal).toBeDefined();
			expect(goal?.kind).toBe("javascript");
			expect(goal?.kind === "javascript" && goal.javascript.globalName).toBe("goal");
		});

		it("loads the bundled compact skill as a JavaScript skill", () => {
			const { skills } = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });

			const compact = skills.find((s) => s.name === "compact");
			expect(compact).toBeDefined();
			expect(compact?.kind).toBe("javascript");
			expect(compact?.kind === "javascript" && compact.javascript.globalName).toBe("compact");
		});

		it("loads the bundled RLM heartbeat skill as a JavaScript skill", () => {
			const { skills } = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });

			const rlmHeartbeat = skills.find((s) => s.name === "rlm-heartbeat");
			expect(rlmHeartbeat).toBeDefined();
			expect(rlmHeartbeat?.kind).toBe("javascript");
			expect(rlmHeartbeat?.kind === "javascript" && rlmHeartbeat.javascript.globalName).toBe("rlmHeartbeat");
		});

		it("does not ship orchestration heartbeat as a built-in skill", () => {
			const { skills } = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });

			expect(skills.map((skill) => skill.name)).not.toContain("orchestration-heartbeat");
		});

		it("ships the edit skill as a JavaScript skill exposed as `edit`", () => {
			const { skills } = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });

			const edit = skills.find((s) => s.name === "edit");
			expect(edit).toBeDefined();
			expect(edit?.kind).toBe("javascript");
			expect(edit?.kind === "javascript" && edit.javascript.globalName).toBe("edit");
		});

		it("loads the skill-creator JavaScript template as a valid JavaScript skill", () => {
			const referencePath = join(getBundledSkillsDir(), "skill-creator", "references", "javascript-skills.md");
			const reference = readFileSync(referencePath, "utf-8");
			const packageJson = reference.match(/`package\.json`:\s*\n+```json\n([\s\S]*?)\n```/)?.[1];
			const entrySource = reference.match(/`src\/index\.ts`:\s*\n+```typescript\n([\s\S]*?)\n```/)?.[1];
			expect(packageJson).toBeDefined();
			expect(entrySource).toBeDefined();

			const templateRoot = join(tempDir, "template-skills");
			const skillRoot = join(templateRoot, "word-count");
			mkdirSync(join(skillRoot, "src"), { recursive: true });
			writeFileSync(
				join(skillRoot, "SKILL.md"),
				"---\nname: word-count\ndescription: Count words in JavaScript.\n---\nUse `wordCount(text)`.\n",
			);
			writeFileSync(join(skillRoot, "package.json"), packageJson as string);
			writeFileSync(join(skillRoot, "src", "index.ts"), entrySource as string);

			const { skills, diagnostics } = loadSkillsFromDir({ dir: templateRoot, source: "test" });
			expect(diagnostics).toEqual([]);
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("word-count");
			expect(skills[0].kind).toBe("javascript");
			expect(skills[0].kind === "javascript" && skills[0].javascript.globalName).toBe("wordCount");
		});
	});

	// The bundled skills only reach a deployed agent if the build/release scripts
	// copy skills/ into the shipped layout. A regression here resolves zero
	// built-in skills at runtime even though the source tree looks correct
	// (ENG-4220), so assert each shipping path still copies skills.
	describe("packaging ships bundled skills", () => {
		const packageRoot = join(__dirname, "..");
		const repoRoot = join(packageRoot, "..", "..");

		it("npm build (copy-assets) copies skills into dist", () => {
			const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
				files?: string[];
				scripts?: Record<string, string>;
			};
			expect(pkg.scripts?.["copy-assets"]).toContain("skills dist/skills");
			// npm publish ships the source skills/ dir via the files allowlist too.
			expect(pkg.files).toContain("skills");
		});

		it("binary release script copies skills next to the executable", () => {
			const script = readFileSync(join(repoRoot, "scripts", "build-binaries.sh"), "utf-8");
			expect(script).toMatch(/cp -r skills binaries\/\$platform\//);
		});

		it("release packer includes skills in the packed package", () => {
			const script = readFileSync(join(repoRoot, "scripts", "pack-prime-agent-release.mjs"), "utf-8");
			expect(script).toContain('"skills"');
		});
	});
});
