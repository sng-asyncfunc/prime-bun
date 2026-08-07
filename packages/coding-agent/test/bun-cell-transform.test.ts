import { describe, expect, it } from "vitest";
import { type ModuleBindingRecipe, transformJavaScriptCell } from "../src/core/kernel/bun-cell-transform.js";

type CellFunction = (persist: (name: string, value: unknown, recipe?: ModuleBindingRecipe) => void) => Promise<unknown>;

function compileCell(source: string): {
	bindings: Map<string, unknown>;
	recipes: Map<string, ModuleBindingRecipe>;
	result: Promise<unknown>;
} {
	const transformed = transformJavaScriptCell(source);
	const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
		...args: string[]
	) => CellFunction;
	const execute = new AsyncFunction("__primePersist", transformed.code);
	const bindings = new Map<string, unknown>();
	const recipes = new Map<string, ModuleBindingRecipe>();
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

	it("persists the latest binding values before a final top-level return", async () => {
		const execution = compileCell(`
let count = 1;
count += 2;
return count;
throw new Error("unreachable");
`);

		expect(await execution.result).toBe(3);
		expect(execution.bindings.get("count")).toBe(3);
	});

	it("persists the latest binding values before a bare top-level return", async () => {
		const execution = compileCell("let completed = false; completed = true; return;");

		expect(await execution.result).toBeUndefined();
		expect(execution.bindings.get("completed")).toBe(true);
	});

	it("persists conditional return mutations without reading later declarations", async () => {
		const execution = compileCell(`
let count = 1;
count += 2;
if (count === 3) {
  return ++count;
}
const unreachable = 99;
`);

		expect(await execution.result).toBe(4);
		expect(execution.bindings.get("count")).toBe(4);
		expect(execution.bindings.has("unreachable")).toBe(false);
	});

	it("persists mutations made by user finally blocks after a return value is evaluated", async () => {
		const execution = compileCell(`
let count = 1;
try {
  count = 2;
  return count;
} finally {
  count = 3;
}
`);

		expect(await execution.result).toBe(2);
		expect(execution.bindings.get("count")).toBe(3);
	});

	it("does not persist return-path mutations when a finally block throws", async () => {
		const execution = compileCell(`
let count = 1;
try {
  count = 2;
  return count;
} finally {
  count = 3;
  throw new Error("return overridden");
}
`);

		await expect(execution.result).rejects.toThrow("return overridden");
		expect(execution.bindings.get("count")).toBe(1);
	});

	it("continues normally when a finally block cancels a return", async () => {
		const execution = compileCell(`
let count = 1;
returnAttempt: try {
  count = 2;
  return count;
} finally {
  count = 3;
  break returnAttempt;
}
count = 4;
count;
`);

		expect(await execution.result).toBe(4);
		expect(execution.bindings.get("count")).toBe(4);
	});

	it("lowers static imports in statement order with one load per declaration", () => {
		const transformed = transformJavaScriptCell(`
globalThis.__primeOrder = ["before"];
import pathDefault, { basename, join as combine } from "node:path";
globalThis.__primeOrder.push("middle");
import * as fsModule from "node:fs";
import "node:util";
globalThis.__primeOrder.push("after");
`);

		expect(transformed.bindingNames).toEqual(["pathDefault", "basename", "combine", "fsModule"]);
		expect(transformed.bindingRecipes).toEqual({
			pathDefault: {
				exportName: "default",
				loader: "import",
				specifier: "node:path",
				type: "module",
			},
			basename: {
				exportName: "basename",
				loader: "import",
				specifier: "node:path",
				type: "module",
			},
			combine: {
				exportName: "join",
				loader: "import",
				specifier: "node:path",
				type: "module",
			},
			fsModule: { loader: "import", specifier: "node:fs", type: "module" },
		});
		expect(transformed.code.match(/await import\("node:path"\)/g)).toHaveLength(1);
		expect(transformed.code).toContain('await import("node:util")');
		expect(transformed.code).not.toContain("import pathDefault");
		expect(transformed.code.indexOf('push("middle")')).toBeLessThan(
			transformed.code.indexOf('await import("node:fs")'),
		);
	});

	it("records selected exports from a destructured literal dynamic import", () => {
		const transformed = transformJavaScriptCell(
			'const { readFile, writeFile: write } = await import("node:fs/promises");',
		);

		expect(transformed.bindingRecipes).toEqual({
			readFile: {
				exportName: "readFile",
				loader: "import",
				specifier: "node:fs/promises",
				type: "module",
			},
			write: {
				exportName: "writeFile",
				loader: "import",
				specifier: "node:fs/promises",
				type: "module",
			},
		});
	});

	it("does not invent recipes for non-literal dynamic imports", () => {
		const transformed = transformJavaScriptCell(`
const specifier = "node:path";
const pathModule = await import(specifier);
`);

		expect(transformed.bindingRecipes).toEqual({});
	});

	it("records a literal require namespace recipe", () => {
		const transformed = transformJavaScriptCell('const library = require("node:path");');

		expect(transformed.bindingRecipes).toEqual({
			library: { loader: "require", specifier: "node:path", type: "module" },
		});
	});

	it("records selected exports from a destructured literal require", () => {
		const transformed = transformJavaScriptCell('const { basename, join: combine } = require("node:path");');

		expect(transformed.bindingRecipes).toEqual({
			basename: {
				exportName: "basename",
				loader: "require",
				specifier: "node:path",
				type: "module",
			},
			combine: {
				exportName: "join",
				loader: "require",
				specifier: "node:path",
				type: "module",
			},
		});
	});

	it("avoids collisions between user identifiers and lowered import namespaces", () => {
		const transformed = transformJavaScriptCell(`
const __primeImport0 = "user-value";
import * as pathModule from "node:path";
[__primeImport0, pathModule.basename("/a/b")];
`);
		const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
			...args: string[]
		) => CellFunction;

		expect(() => new AsyncFunction("__primePersist", transformed.code)).not.toThrow();
		expect(transformed.code).toContain("const __primeImport0_ = await import");
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

	it("continues to reject exports from notebook cells", () => {
		expect(() => transformJavaScriptCell("export const value = 1;")).toThrow(
			"Exports are not supported in Bun cells.",
		);
	});
});
