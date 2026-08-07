# Bun REPL Imports and Startup Prelude Design

## Objective

Make Prime Agent's persistent Bun notebook behave like Bun's native REPL for module loading. Common standard modules must be available without import ceremony, uncommon modules must be importable with normal JavaScript syntax once per session, and every supported module binding must survive worker recovery without repeated model-generated setup.

The change targets three observed costs:

- repeated `await import(...)` lines consume model tokens and attention even when the module is already cached;
- static imports currently fail and force a full model retry; and
- destructured dynamic-import bindings work in the live worker but are not recoverable after abort or restart.

## Decision

Implement both native-looking static imports and a small startup prelude.

Static-import support is the primary fix because it removes a failure mode for every module. The startup prelude is the common-case optimization because it removes even the first import for the four Node standard modules most useful in notebook orchestration.

Do not add a custom filesystem or search API. Prime Agent will expose standard Bun, Web, and Node interfaces instead of creating another vocabulary the model must learn.

## User-Facing Contract

The first cell starts with these module namespaces available:

| Binding | Module | Semantics |
| --- | --- | --- |
| `fs` | `node:fs` | Exact Node namespace; use `fs.promises` for asynchronous operations |
| `path` | `node:path` | Exact Node path namespace |
| `os` | `node:os` | Exact Node operating-system namespace |
| `util` | `node:util` | Exact Node utility namespace |

The existing `fetch`, `Bun`, `$`, `sh`, `process`, `Buffer`, `URL`, and WebCrypto globals remain available. Node `crypto` is not preloaded because `globalThis.crypto` already provides WebCrypto; replacing it would silently change standard global semantics.

Common code therefore needs no setup cell:

```javascript
const packageJson = JSON.parse(await fs.promises.readFile("package.json", "utf8"));
const sourcePath = path.join(process.cwd(), "src");
```

Uncommon modules use normal Bun REPL syntax once and remain available in later cells:

```javascript
import { parse as parseYaml } from "yaml";
const config = parseYaml(await fs.promises.readFile("config.yaml", "utf8"));
```

```javascript
config.services.length;
```

Supported cell forms are:

- namespace imports: `import * as moduleName from "package"`;
- named and aliased imports: `import { value, other as alias } from "package"`;
- default imports and mixed default/named imports;
- side-effect imports: `import "package/register"`;
- existing top-level dynamic imports;
- CommonJS `require("package")`; and
- redeclaration of imports and variables in a later cell, matching Bun REPL iteration semantics.

Exports remain invalid in notebook cells because a cell is an evaluation unit rather than an importable module.

## Startup Prelude

The worker owns a declarative preload table containing the four binding names and canonical `node:` specifiers. Initialization imports each namespace before the first cell and seeds it through the same binding mechanism used for notebook declarations.

Preloads are ordinary configurable notebook bindings with module recipes, not immutable runtime globals. This preserves three properties:

1. a later cell can intentionally redefine `fs`, `path`, `os`, or `util`;
2. the redefinition is captured by normal snapshot behavior; and
3. an old session snapshot containing one of those names can override the default during restore.

The preload names are nevertheless reserved from JavaScript skill registration. A skill requesting one of those globals becomes markdown-only with a diagnostic instead of replacing the standard module.

Core host globals such as `rlm`, `$`, `sh`, `installPackage`, `hostRequest`, and prepared skill globals remain runtime-reserved. A cell that declares one of those names fails before execution with a clear collision error. This prevents a live shadow from silently reverting after recovery.

## Static Import Lowering

Cells still execute through the existing async-function evaluator so top-level `await`, output capture, cancellation, and host requests keep their current behavior. The AST transform will lower `ImportDeclaration` nodes into awaited module loads and persistence calls instead of rejecting them.

For example:

```javascript
import defaultValue, { readFile as read } from "package";
```

is conceptually lowered to one hidden namespace load followed by bindings for `defaultValue` and `read`. Hidden transform variables use runtime-private names and never enter user namespace listings or snapshots.

Each public binding receives an explicit module recipe:

```typescript
interface ModuleBindingRecipe {
	type: "module";
	loader: "import" | "require";
	specifier: string;
	exportName?: string;
}
```

An absent `exportName` denotes the complete namespace. `"default"` denotes the default export. Named imports store their original exported name, not their local alias.

The lowering preserves statement order within a cell. It does not attempt to reproduce ESM live bindings or declaration hoisting across notebook evaluations. Imported values are REPL bindings captured when the cell executes, which matches the product's existing persistent-value model.

Bun's TypeScript transpiler continues to run before the JavaScript AST transform. Type-only imports erased by Bun produce no runtime binding or module load.

## Dynamic Imports and `require`

The current transform records a recovery recipe only for an identifier assigned directly from a literal dynamic import. Extend recipe collection to cover named/default aliases from ordinary object destructuring:

```javascript
const { readFile, writeFile: write } = await import("node:fs/promises");
```

Both `readFile` and `write` receive per-binding module recipes and survive worker replacement. Complex computed keys and rest destructuring continue to execute normally in the live session but are not promised module-recipe recovery; if their values cannot be serialized, snapshot diagnostics identify them explicitly.

Expose the worker's existing `createRequire(import.meta.url)` function as the runtime-reserved global `require`. Literal top-level bindings such as `const library = require("library")` receive `loader: "require"` recipes. Non-literal or nested calls work in the live cell but use ordinary serialization rules because their source module cannot be identified safely.

## State and Recovery Format

Module recipes must retain the loader, specifier, and selected export. Snapshot format version 3 stores module-recipe entries as validated JSON rather than a raw specifier.

The version-3 decoder also accepts version-2 snapshots. A version-2 `kind: "import"` entry is interpreted as the previous namespace dynamic-import recipe. This permits sessions created before the feature to recover after the update. Version-3 encoding is the only write path after migration.

Recipe restoration is isolated per binding:

1. load the module with `import()` or the prepared `require` function;
2. select the namespace, default export, or named export;
3. fail that binding if the selected export is absent; and
4. persist the restored value with the same recipe for the next checkpoint.

A malformed recipe or unavailable module is reported in the existing restore diagnostics and does not discard unrelated state. Package upgrades between snapshot and restore resolve the current package version, matching existing dynamic-import recovery behavior.

Preloaded defaults are recreated for every worker before session restore. A restored user binding with the same name then replaces the default.

## Prompt and Documentation

Replace the negative instruction that static imports are unsupported with one concise positive contract:

> `fs`, `path`, `os`, and `util` are preloaded Node module namespaces (`fs.promises` for async file operations). `fetch`, `Bun`, `$`, `sh`, `process`, and `Buffer` are already global. Static imports, dynamic imports, and `require` are supported; named top-level bindings persist across cells and recovery, so import a module once and reuse it.

Remove examples that teach repeated `await import("node:fs/promises")`. Documentation examples should use preloaded modules for common file/path work and a static import for an uncommon package.

The prompt must not enumerate additional Node built-ins. Keeping the preload vocabulary to four names limits collisions and avoids replacing one form of context overhead with another.

## Error Handling

- A static import with a non-string source fails during parsing under normal JavaScript rules.
- A declaration colliding with a core runtime or prepared skill global fails before any statement in the cell runs.
- A preload collision from a skill disables only the executable skill global and emits the existing diagnostic.
- A missing package reports the original Bun module-resolution error.
- A missing named/default export fails the cell or restore entry with the binding and specifier identified.
- Side-effect imports are session-local effects. They rerun only when their cell is rerun and are not independently replayed during recovery because no durable binding describes their intended effect.

## Compatibility

This changes notebook syntax and private snapshot encoding but does not change daemon commands, events, or response shapes. No daemon protocol or schema bump is required.

Snapshot format 3 is backward-readable for version 2. Older binaries are not required to read a new version-3 snapshot. The worker asset content hash already forces prepared-runtime refresh when the transform or worker changes.

The new behavior intentionally removes the old static-import SyntaxError. Dynamic-import code remains valid.

## Testing

Implementation follows red-green TDD in focused package tests.

### Cell transform tests

- static namespace, named, aliased, default, mixed, and side-effect imports lower correctly;
- one source declaration results in one module load;
- import bindings expose the correct recipes;
- exports remain rejected;
- type-only imports disappear without a runtime recipe;
- destructured literal dynamic imports receive named recipes; and
- complex non-literal cases execute without receiving an incorrect recipe.

### Worker integration tests

- `fs`, `path`, `os`, and `util` work in the first cell without imports;
- `fetch`, WebCrypto, `$`, and `sh` retain their current identities;
- a static import is usable in a later cell;
- a later cell can redeclare an import and a preload;
- `require("node:path")` works and persists;
- core-runtime and skill-global declarations fail before execution;
- preload/skill collisions degrade only the skill; and
- namespace listing and snapshots contain no transform-private names.

### Recovery tests

- namespace, named, aliased, default, destructured dynamic-import, and literal-require bindings restore after worker replacement;
- a redefined preload restores instead of reverting to the default;
- a version-2 raw import recipe restores under the version-3 decoder;
- one invalid recipe fails independently; and
- side-effect-only imports are not falsely reported as restored state.

### Prompt, docs, and performance tests

- system-prompt assertions verify the preload inventory and import-once guidance;
- old static-import prohibition and repeated-fs-import guidance are absent;
- focused startup measurements compare the worker before and after preloading; and
- the existing Bun startup, recovery, heavy-output, and snapshot benchmarks must not regress beyond normal run-to-run variance.

After focused tests pass, run the repository-mandated `npm run check`. Perform a live `prompt-bun` smoke test from a project with its own `tsconfig.json`: use `fs` without importing it, statically import an uncommon module once, reuse both in another cell, force worker recovery, and verify both bindings remain available.

## Documentation and Changelog

Update:

- `packages/coding-agent/src/core/prompts/rlm.ts`;
- `packages/coding-agent/docs/rlm.md`;
- `packages/coding-agent/docs/rlm-runtime.md`; and
- `packages/coding-agent/CHANGELOG.md` under `## [Unreleased]`.

The changelog entry describes the user-visible result: common Node modules are preloaded and Bun cells now support persistent static imports across recovery.

## Non-Goals

- Creating Prime-specific `readFile`, `writeFile`, `glob`, `rg`, or CSV helper APIs.
- Preloading third-party packages or every Node built-in.
- Replacing WebCrypto with `node:crypto`.
- Simulating ESM live bindings or cross-cell import hoisting.
- Replaying side-effect-only imports automatically after a crash.
- Turning the Bun worker into a filesystem or process sandbox.
