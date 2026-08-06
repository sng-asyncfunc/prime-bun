import { join } from "node:path";
import { getBundledSkillsDir } from "../src/config.js";
import type { JavaScriptSkillRuntimeInfo } from "../src/core/skills.js";

export function bundledJavaScriptSkill(name: string, globalName: string): JavaScriptSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), name);
	return {
		entryPath: join(packagePath, "src", "index.ts"),
		globalName,
		name,
		packageJsonPath: join(packagePath, "package.json"),
		packagePath,
	};
}
