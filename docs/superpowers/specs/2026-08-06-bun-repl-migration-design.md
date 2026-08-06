# Bun REPL Migration Design

## Objective

Replace Prime Agent's Python/IPython control environment with a persistent Bun 1.3.14-or-newer JavaScript REPL. RLM recursion, host integrations, executable skills, structured displays, state continuity, cancellation, daemon reattachment, and terminal rendering must work through JavaScript without a Python compatibility layer.

## Decision

Use a long-lived Bun worker subprocess with a versioned JSON protocol over dedicated extra pipes. The worker evaluates JavaScript in a persistent global namespace, sends typed host requests while a cell is running, streams console output, and returns structured result/error/display records. This follows the proven process boundary in `/Users/sheing/temp/rlm-wiki/vendor/rlm-bun`, but adapts it to Prime Agent's existing kernel lifecycle and uses current Bun capabilities.

The model-facing tool is named `javascript` and labeled `Bun`. Python/IPython names are not retained as aliases because the requested migration is intentionally incompatible and the repository does not preserve backward compatibility unless explicitly requested.

## Alternatives Considered

### Native `bun repl` subprocess

The Bun 1.3.14 CLI has a native interactive REPL with correct lexical binding behavior. Its output is terminal-oriented, including prompts, cursor-control sequences, line editing, and character echo. It does not expose a supported programmatic request protocol. Scraping that stream would make multiline execution, host requests, structured displays, cancellation, and recovery dependent on terminal implementation details. Rejected.

### Node `vm` or `eval`

This would integrate easily with the TypeScript host, but evaluated code would run on V8 rather than Bun's JavaScriptCore runtime and would not expose Bun APIs. Rejected because it does not meet the runtime requirement.

### Bun worker with typed protocol

The reference `rlm-bun` implementation demonstrates the correct isolation and persistence boundary. Prime Agent needs a richer protocol than the reference: execution IDs, incremental stdout/stderr, host request/reply correlation, structured display events, interrupts, snapshots, restore, namespace listing, and graceful shutdown. Selected.

## Runtime and Provisioning

- Require Bun `>=1.3.14`. This is the current stable release on 2026-08-06. A live probe confirmed both `Bun.Image` and `serialize` from `bun:jsc` are present in this release.
- Resolve `PRIME_AGENT_KERNEL_BUN` first, then `bun` on `PATH`, then `~/.bun/bin/bun`.
- Validate the resolved runtime with `bun --version` and reject versions below 1.3.14 with an actionable error.
- First-use setup may install the latest stable Bun through the official `https://bun.sh/install` script. Interactive flows ask before installation; installer/postinstall flows can opt in non-interactively.
- Remove uv, Python 3.11, ipykernel, dill, Python package provisioning, virtual-environment state, the Linux Python forkserver, ZeroMQ, and `prime-agent-runtime` Python packaging.
- Rename user-facing environment variables and setup text from `*_PYTHON`/`*_VENV` to `PRIME_AGENT_KERNEL_BUN` and Bun language.
- Maintain a dedicated `~/.prime/agent/kernel-bun` package directory. The provisioner copies the bundled worker there and preserves its `package.json`/`node_modules`, so packages installed for notebook work never modify the target project. The runtime exposes an `installPackage(...names)` helper backed by `bun add --cwd <kernel-dir>` and the prompt documents it.

## Worker Protocol

The Node host spawns one Bun worker per session. Messages are newline-delimited JSON objects with a protocol version and correlation ID. Protocol traffic never shares stdout or stderr with user code: the host and worker use two dedicated extra pipes (host-to-worker and worker-to-host). Worker stdout/stderr remain ordinary user streams, so direct `process.stdout.write()` and `Bun.write(Bun.stdout, ...)` cannot corrupt framing.

Host-to-worker messages:

- `initialize`: working directory, shell settings, JavaScript skill entries, snapshot paths, and runtime metadata.
- `execute`: cell ID and JavaScript source.
- `snapshot`, `restore`, and `list_names`: explicit state operations that do not consume model-visible cell history.
- `host_response`: success/error reply for a worker-originated host request.
- `shutdown`: bounded graceful termination.

Worker-to-host messages:

- `ready` and `idle`: lifecycle state.
- `stream`: stdout or stderr tagged with the originating cell ID.
- `display`: typed diff, attachment, or sent-agent-message payload.
- `host_request`: typed host bridge request, including the active or last cell source for RLM attribution.
- `result`: inspected last expression, structured error, duration, and final status.
- `snapshot_result`, `restore_result`, and `list_names_result`.

The worker associates user output with the originating cell through asynchronous execution context and sends it over the framed protocol. The host accepts a stream record only while that exact cell is active, so delayed timers from a completed cell cannot leak into a later cell. Untagged process output is retained only as a bounded worker diagnostic.

## Persistent JavaScript Semantics

Each cell runs inside an async function so top-level `await` works. Bun's TypeScript transpiler first erases TypeScript syntax without type-checking, then Acorn parses the complete JavaScript program with current ECMAScript syntax and top-level-await support. An AST-guided source transform persists top-level declarations after their original statement:

- `const`, `let`, and `var`, including array/object destructuring;
- named function declarations;
- named class declarations.

Because transformations use parser ranges, strings, template literals, regular expressions, comments, defaults, aliases, and nested destructuring are not re-parsed with regular expressions. The original declaration still runs with normal same-cell scope and hoisting; generated statements then copy every bound identifier to `globalThis` and the private binding registry. The worker also reconciles new or deleted own properties on `globalThis` after every cell, so explicit global assignments participate in namespace inspection and recovery. The final top-level `ExpressionStatement` is changed to a return and formatted with `Bun.inspect({ colors: false })`, matching notebook-style result display. A cell may redefine a prior notebook binding because each cell has its own local async-function scope and then replaces the global value.

The runtime exposes `$` from Bun Shell, `Bun`, `console`, `fetch`, and normal JavaScript globals. It also exposes `sh(command)`, which spawns the configured `shellPath` and prepends the existing `commandPrefix`; this preserves sandbox/wrapper behavior for shell commands that Bun Shell cannot express. Awaiting it returns `{ exitCode, stdout, stderr }`; `.text()` and `.json()` provide concise stdout consumers. Project commands should run through `sh`, Bun Shell, or the project's documented command interface. Working-directory and environment changes made with `process.chdir()` and `process.env` persist across cells and successful-state recovery.

## RLM JavaScript API

The global `rlm` is a callable async function with JavaScript methods:

```js
const child = await rlm("review the parser", { name: "parser-reviewer" });
const models = await rlm.findModels("claude");
const children = await rlm.listSubagents();
await rlm.deleteSubagent(child);
```

`rlm()` preserves the current admission-only behavior: it returns a spawn handle immediately and never returns the child's answer. Handles and model records use camelCase JavaScript fields while the host wire payload remains explicit and validated.

`rlm.hostRequest(type, payload)` is the generic bridge used by executable skills. The existing host-side request handlers stay authoritative.

`rlm.harness` and `rlm.getHarnessState()` are ported to JavaScript with the same JSON store and local/global scope rules. CRUD methods use camelCase names and an options object such as `{ global: true }`. Harness skill references use `type: "javascript"`, a JavaScript global/import name, and a callable/call-pattern contract.

## JavaScript Skills

Executable skills are JavaScript packages, not Python packages.

- A skill with `SKILL.md` plus `package.json` metadata under `primeAgent` is classified as `javascript`.
- Metadata identifies a stable global name and a Bun-loadable entry file. Entries are loaded by the worker with Bun's synchronous module loader before the first cell.
- Package dependencies are installed automatically into a per-skill managed cache; user skill directories are never mutated. Successful cache paths are exposed to Bun through `NODE_PATH`.
- Runtime-reserved or duplicate globals disable only the conflicting executable form. The skill's Markdown instructions remain available and the worker continues starting with a diagnostic.
- Markdown-only skills remain unchanged.
- Built-in executable skills are ported to TypeScript/JavaScript and their Python packages and console scripts are removed.
- Skill prompt metadata changes from `python_import` to `javascript_import`.
- No Python skill fallback or compatibility shim remains.

Built-in behavior to preserve:

- `agentMessage`, `agentObserve`, `compact`, `goal`, `refine`, and `rlmHeartbeat` remain typed host-request wrappers.
- `edit` performs one exact replacement and emits the existing structured diff payload.
- `attachImage` validates and resizes with Bun 1.3.14 `Bun.Image`, then emits the existing structured attachment payload.
- `websearch` uses `fetch` and the existing auth-file resolution rules.
- `linear` and `notion` use a JavaScript `McpIntegration` with the MCP SDK and the existing host-resolved config/refresh flow.

## State Continuity

The worker tracks user-defined global bindings. Snapshotting serializes each binding independently with `serialize` from `bun:jsc`, enforces the existing aggregate size cap, writes an atomic binary payload and JSON manifest, and reports skipped values. Before serialization, a cycle-safe cloneability walk rejects promises, proxies that throw during inspection, symbol-keyed state, weak collections, and custom-prototype instances at any nesting depth. This prevents structured clone from silently restoring a class instance as a plain object without its methods. Plain function/class definitions and literal dynamic imports use explicit restore recipes instead of structured cloning.

State fidelity is explicit:

| Value | Snapshot behavior |
| --- | --- |
| Primitive, plain object, array | Preserved |
| `Date`, `RegExp`, `Map`, `Set`, `ArrayBuffer`, typed array | Preserved after a runtime characterization test proves Bun round-trips its type |
| Plain function or class definition | Restored best-effort from its source recipe; native/opaque functions are skipped and reported |
| Literal dynamic import binding | Restored by importing the same specifier in the replacement worker |
| Promise, weak collection, live handle, open resource | Skipped and reported |
| Custom class instance or nested custom prototype | Skipped and reported rather than degraded |
| Symbol-keyed object state | Skipped and reported |

Restore deserializes each entry independently and writes it back to `globalThis`. Runtime handles and loaded skills are initialized after restore and always replace restored names. Existing Python `.dill` snapshots are ignored; this is an intentional incompatible migration with no backward-compatibility requirement.

## Cancellation and Recovery

Live probes against Bun 1.3.14 establish the cancellation contract: a SIGINT handler runs for an async-waiting cell, but cannot run while synchronous JavaScript blocks the event loop. Leaving an async cell alive after returning an aborted result would allow invisible later mutations. Prime Agent therefore does not simulate Python `KeyboardInterrupt`.

- Executions remain sequential per worker.
- Before starting a cell, the provisioner flushes any dirty private recovery snapshot from the previous successful cell. That snapshot is the recovery point and includes cwd plus an environment delta.
- Abort terminates the Bun worker process group for both synchronous and asynchronous cells. The active result is `aborted`; no abandoned JavaScript or shell descendant keeps mutating state.
- The provisioner immediately starts a fresh worker, restores the last successful snapshot, reloads runtime handles and skills, and reports restored/skipped names. Completed serializable state, supported recipes, cwd, and environment changes survive; non-serializable handles and changes made by the aborted cell do not.
- Session snapshots remain separate from private recovery snapshots and never include cwd or environment variables.
- Unexpected exit follows the same restore path, rejects the active execution, captures a bounded stderr tail, and rejects every pending host request.
- Worker-level `unhandledRejection` and `uncaughtException` handlers report diagnostics over the protocol while an execution is active. Detached promise rejections do not terminate an otherwise healthy worker; uncaught exceptions still exit so the host can restore instead of keeping an unknown state.
- Dispose waits briefly for in-flight host requests and a final successful-state snapshot before terminating the worker.

## UI and Public Naming

The existing compact notebook renderer is retained but renamed to JavaScript/Bun terminology. JavaScript syntax highlighting replaces Python highlighting. `%%bash` parsing, magic-line styling, and IPython-specific traceback parsing are removed. Bun errors display the error name/message and relevant JavaScript stack lines.

Per the terminal UI's high-frequency interaction model, no entrance/exit animation is added. Cell status, streaming output, diffs, attachments, and sent-agent-message rendering remain immediate.

Public SDK exports, internal fields, events, feature hints, ACP metadata, daemon summaries, and transcript labels are renamed from IPython to JavaScript/Bun. No deprecated aliases are retained.

## Feature-Parity Contract

The migration is complete only when every current notebook capability has a JavaScript replacement and focused acceptance coverage.

| Current capability | Bun replacement | Acceptance target |
| --- | --- | --- |
| Persistent variables and imports | AST-persisted globals, explicit global reconciliation, and Bun module loading | A later cell reuses declarations, explicit globals, destructuring bindings, helper functions, and a loaded module |
| TypeScript syntax | Bun-native syntax lowering before JavaScript parsing | Type annotations and other erasable syntax execute without advertising type-checking |
| Top-level async execution | Async cell wrapper | `await` works and the final expression is rendered |
| Incremental stdout/stderr | Cell-tagged worker stream messages | Interleaved output appears before cell completion, obeys truncation limits, and never crosses cells |
| `%%bash`, shell prefix, and shell path | `sh(command)` plus Bun Shell `$` | Configured `commandPrefix` and `shellPath` are used exactly once; structured, `.text()`, and `.json()` forms work |
| Working-directory and environment persistence | `process.chdir()` and `process.env` | Changes remain visible in a subsequent cell |
| RLM spawn/find/list/delete | Callable `rlm` JavaScript API | Valid requests round-trip and invalid payloads fail locally |
| Generic host bridge | `rlm.hostRequest()` | Agent messages, observation, compaction, goals, refinement, and heartbeat retain typed payloads |
| Executable skills | Bun-loadable JavaScript skill packages with managed dependencies | Every built-in Python skill has a JavaScript behavioral regression test; a bad third-party skill cannot block the REPL |
| MCP-backed skills | JavaScript MCP integration | Linear and Notion initialization, refresh, tool calls, and result normalization match current behavior |
| Diffs, attachments, and sent-message displays | Existing structured display records | Terminal renderer receives unchanged MIME payloads from JavaScript skills |
| Namespace inspection | Worker binding registry | Listing excludes runtime-private names and includes user bindings |
| State snapshots and compaction continuity | Per-binding `bun:jsc` snapshots | Serializable values restore; unsupported values are skipped and reported |
| Abort and crash recovery | Worker termination and private last-successful restore | Infinite synchronous code aborts, delayed async mutations stop, and prior values/cwd/environment return without entering session snapshots |
| Session resume and daemon passivation | Bun provisioner lifecycle | Reattachment restores state and incompatible daemon versions reject cleanly |
| Prewarm and boot gate | Bun validation/setup gate | Missing, old, concurrent, and successful setup paths report deterministic progress |
| TUI, ACP, SDK, and transcript exposure | JavaScript/Bun public names | No Python/IPython public symbols, labels, events, or feature hints remain |
| Permission model | Bun worker inherits user permissions | File, network, subprocess, and host-tool access remain available under existing policy checks |

The implementation also includes a repository-wide residual-name audit. Python may remain only where it serves an unrelated project purpose, such as logo rendering; no Python REPL runtime, executable skill, installer path, state file, protocol event, prompt, or user-facing label may remain.

## Protocol Compatibility

Renaming the agent-connection event `ipython_sent_agent_message` and changing startup from an IPython requirement to Bun are incompatible wire/startup changes. The daemon protocol version is bumped. The schema revision and compatibility maps are updated, with both new-client/old-daemon and old-client/new-daemon tests proving clean rejection rather than partial startup.

Structured display MIME identifiers remain unchanged because they describe Prime Agent payloads, not Python.

## Packaging

- The published package includes the Bun worker, JavaScript runtime modules, and JavaScript skill sources.
- Build/copy scripts stop shipping `prime-agent-runtime` Python sources and pyproject files.
- `zeromq` is removed when no remaining source imports it.
- Bun is an external runtime prerequisite installed/validated by the setup path; the Node CLI remains Node-based.
- The binary build still embeds the Node host but launches the external Bun worker for JavaScript cells.

## Testing

All behavior changes follow red-green TDD with focused Vitest files run from `packages/coding-agent`.

Required coverage:

- Bun version resolution, missing/old runtime errors, install opt-in, concurrent setup, and startup progress.
- Worker framing, persistent declarations, destructuring, functions/classes, top-level await, inspected final expressions, output truncation, errors, host requests, displays, aborts, crashes, restart, and cleanup.
- JavaScript state snapshot/restore/list behavior and per-binding skip handling.
- RLM spawn/model/list/delete validation and cell-source attribution from JavaScript.
- Every ported built-in executable skill, including image compression through `Bun.Image` and MCP result normalization.
- JavaScript skill discovery, collisions, packaging, prompt metadata, and removal of Python classification.
- JavaScript cell rendering and event propagation in TUI, ACP, daemon, and session replay paths.
- Installer rendering and package asset checks.
- Daemon compatibility tests for the incompatible protocol bump.

After focused regressions pass, run the repository-mandated `npm run check`, then a live Bun smoke flow that executes JavaScript, reuses a binding, calls an RLM host stub, snapshots, restarts, and restores.

## Documentation and Changelog

Update the root README, coding-agent README, RLM/runtime/skills/terminal setup docs, installer copy, environment-variable docs, examples, and built-in SKILL.md files to JavaScript. Add one user-visible past-tense bullet under `packages/coding-agent/CHANGELOG.md` `## [Unreleased]`. Released changelog sections remain immutable.

## Non-goals

- Preserving Python REPL or Python executable-skill compatibility.
- Running target projects inside the Bun worker when their native interface should be used.
- Turning the worker into a security sandbox; it retains the user's permissions, matching the current product model.
- Changing RLM child lifecycle, admission, messaging, or daemon passivation semantics beyond language/API naming.
