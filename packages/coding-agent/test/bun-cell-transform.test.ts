import { describe, expect, it } from "vitest";
import { transformJavaScriptCell } from "../src/core/kernel/bun-cell-transform.js";

type CellFunction = (
	persist: (name: string, value: unknown, recipe?: { type: "import"; specifier: string }) => void,
) => Promise<unknown>;

function compileCell(source: string): {
	bindings: Map<string, unknown>;
	recipes: Map<string, { type: "import"; specifier: string }>;
	result: Promise<unknown>;
} {
	const transformed = transformJavaScriptCell(source);
	const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
		...args: string[]
	) => CellFunction;
	const execute = new AsyncFunction("__primePersist", transformed.code);
	const bindings = new Map<string, unknown>();
	const recipes = new Map<string, { type: "import"; specifier: string }>();
	return {
		bindings,
		recipes,
		result: execute((name, value, recipe) => {
			bindings.set(name, value);
			if (recipe) recipes.set(name, recipe);
		}),
	};
}

describe("transformJavaScriptCell", () => {
	it("persists every top-level variable binding, including nested destructuring", async () => {
		const source = `
const plain = 1;
let { alias: renamed = 2, nested: { value }, ...rest } = {
  alias: 3,
  nested: { value: 5 },
  extra: 8,
};
var [first, , ...tail] = [13, 21, 34, 55];
plain + renamed + value + rest.extra + first + tail[1];
`;
		const transformed = transformJavaScriptCell(source);
		const execution = compileCell(source);

		expect(transformed.bindingNames).toEqual(["plain", "renamed", "value", "rest", "first", "tail"]);
		expect(await execution.result).toBe(85);
		expect(Object.fromEntries(execution.bindings)).toMatchObject({
			plain: 1,
			renamed: 3,
			value: 5,
			rest: { extra: 8 },
			first: 13,
			tail: [34, 55],
		});
	});

	it("persists named function and class declarations", async () => {
		const execution = compileCell(`
function double(value) { return value * 2; }
class Counter {
  constructor(value) { this.value = value; }
  next() { return this.value + 1; }
}
double(new Counter(10).next());
`);

		expect(await execution.result).toBe(22);
		expect(execution.bindings.has("double")).toBe(true);
		expect(execution.bindings.has("Counter")).toBe(true);
	});

	it("does not reinterpret comments, templates, or regular expressions", async () => {
		const execution = compileCell(`
// const decoy = "not a binding";
const template = \`let fake = \${"inside"}\`;
const matcher = /const\\s+fake/u;
({ template, matches: matcher.test("const fake") });
`);

		expect(await execution.result).toEqual({ template: "let fake = inside", matches: true });
		expect([...execution.bindings.keys()]).toEqual(["template", "matcher"]);
	});

	it("supports top-level await and returns only the final expression", async () => {
		const execution = compileCell(`
const value = await Promise.resolve(42);
value + 1;
`);

		expect(await execution.result).toBe(43);
	});

	it("records a restore recipe for a literal dynamic import", () => {
		const transformed = transformJavaScriptCell(`
const pathModule = await import("node:path");
pathModule.basename("/a/b");
`);

		expect(transformed.bindingRecipes).toEqual({
			pathModule: { type: "import", specifier: "node:path" },
		});
	});

	it("persists the final value when a new binding is mutated later in the cell", async () => {
		const execution = compileCell(`
let count = 1;
count += 2;
count;
`);

		expect(await execution.result).toBe(3);
		expect(execution.bindings.get("count")).toBe(3);
	});

	it("returns undefined when the final statement is not an expression", async () => {
		const execution = compileCell("const value = 42;");

		expect(await execution.result).toBeUndefined();
		expect(execution.bindings.get("value")).toBe(42);
	});

	it("preserves useful syntax errors", () => {
		expect(() => transformJavaScriptCell("const value = ;")).toThrow(/Unexpected token/);
	});

	it("rejects static imports with an actionable alternative", () => {
		expect(() => transformJavaScriptCell('import { readFile } from "node:fs/promises";')).toThrow(
			/use await import\(\) or require\(\)/i,
		);
	});
});
