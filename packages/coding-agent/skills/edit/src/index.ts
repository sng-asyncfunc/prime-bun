import { readFile, stat, writeFile } from "node:fs/promises";
import { expandPath, requireString, type SkillContext } from "../../_shared/context.ts";

const DIFF_DISPLAY_MIME = "application/vnd.prime-agent.diff+json";

interface EditRequest {
	path: string;
	oldStr: string;
	newStr: string;
}

export function createSkill(context: SkillContext) {
	return async ({ path, oldStr, newStr }: EditRequest): Promise<string> => {
		requireString(path, "path");
		requireString(oldStr, "oldStr");
		requireString(newStr, "newStr");
		const filepath = expandPath(path, context.cwd);
		try {
			await stat(filepath);
		} catch {
			throw new Error(`${path} not found`);
		}
		const content = await readFile(filepath, "utf8");
		const occurrences = content.split(oldStr).length - 1;
		if (occurrences === 0) throw new Error(`string not found in ${path}`);
		if (occurrences > 1) {
			throw new Error(
				`found ${occurrences} occurrences in ${path}, need exactly 1 — widen the snippet to make it unique`,
			);
		}
		const matchIndex = content.indexOf(oldStr);
		const startLine = content.slice(0, matchIndex).split("\n").length;
		await writeFile(filepath, content.slice(0, matchIndex) + newStr + content.slice(matchIndex + oldStr.length));
		context.display(DIFF_DISPLAY_MIME, {
			path: filepath,
			old_str: oldStr,
			new_str: newStr,
			start_line: startLine,
		});
		return `Edited ${filepath}`;
	};
}
