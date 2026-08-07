import { describe, expect, it } from "vitest";
import { previewBashCommand, previewJavaScriptCode } from "../src/core/tools/code-preview.js";

describe("code preview", () => {
	it("skips bash setup and previews the real command", () => {
		expect(previewBashCommand("set -e\nnpm run check")).toEqual({ language: "bash", text: "npm check" });
	});

	it("simplifies common runner wrappers", () => {
		expect(
			previewBashCommand("npx tsx ../../node_modules/vitest/dist/cli.js --run test/code-preview.test.ts"),
		).toEqual({ language: "bash", text: "vitest --run test/code-preview.test.ts" });
	});

	it("unwraps Bun heredocs in bash", () => {
		const command = `set -e
bun <<'JS'
const path = "package.json";
await Bun.write(path, await Bun.file(path).text());
JS`;
		expect(previewBashCommand(command)).toEqual({
			language: "javascript",
			text: "await Bun.write(path, await Bun.file(path).text());",
		});
	});

	it("previews Bun shell templates as bash", () => {
		const code = `const cwd = "packages/coding-agent";
await \`\${cwd}\`;
await $\`npm run check\`;`;
		expect(previewJavaScriptCode(code)).toEqual({ language: "bash", text: "npm check" });
	});

	it("previews sh helper calls as bash", () => {
		expect(previewJavaScriptCode('await sh("git status --short")')).toEqual({
			language: "bash",
			text: "git status --short",
		});
	});

	it("prefers meaningful JavaScript effects over setup assignments", () => {
		const code = `const path = "packages/coding-agent/src/core/tools/javascript.ts";
const text = await Bun.file(path).text();
await Bun.write(path, text.replace("old", "new"));`;
		expect(previewJavaScriptCode(code)).toEqual({
			language: "javascript",
			text: 'await Bun.write(path, text.replace("old", "new"));',
		});
	});

	it("prefers repository inspection over cwd setup", () => {
		const code = `process.chdir('/Users/sheing/temp/sharenow');
const readme = await fs.promises.readFile('README.md','utf8');
console.log(readme);`;
		expect(previewJavaScriptCode(code)).toEqual({
			language: "javascript",
			text: "const readme = await fs.promises.readFile('README.md','utf8');",
		});
	});

	it("handles stronger bash heuristics", () => {
		expect(previewBashCommand("cd packages/coding-agent && npm --prefix ../.. run check")).toEqual({
			language: "bash",
			text: "npm check (../..)",
		});
		expect(previewBashCommand("echo setup\ngit add packages/foo.ts")).toEqual({
			language: "bash",
			text: "git add packages/foo.ts",
		});
		expect(previewBashCommand("cat > packages/foo.ts <<'EOF'\nhello\nEOF")).toEqual({
			language: "bash",
			text: "write packages/foo.ts",
		});
	});

	it("prefers executable calls over helper definitions", () => {
		const code = `function helper() {
  return 1;
}
await runCheck();`;
		expect(previewJavaScriptCode(code)).toEqual({ language: "javascript", text: "await runCheck();" });
	});

	it("redacts sensitive JavaScript preview values", () => {
		expect(previewJavaScriptCode('const password = "supersecretvalue";')).toEqual({
			language: "javascript",
			text: "const password=<redacted>;",
		});
		expect(previewJavaScriptCode('const client = createClient({ apiKey: "sk-testsecretvalue" });')).toEqual({
			language: "javascript",
			text: "const client = createClient({ apiKey=<redacted> });",
		});
	});

	it("falls back to bash when a heredoc has no useful JavaScript preview", () => {
		const command = `npm run check
bun <<'JS'
import "node:path";
JS`;
		expect(previewBashCommand(command)).toEqual({ language: "bash", text: "npm check" });
	});

	it("does not treat a .sh script path as an inline bash heredoc", () => {
		const command = `./script.sh <<'EOF'
hello world
EOF`;
		expect(previewBashCommand(command)).toEqual({ language: "bash", text: "hello world" });
	});
});
