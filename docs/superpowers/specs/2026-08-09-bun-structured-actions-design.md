# Bun Structured Actions Design

## Objective

Make Prime Bun reliable for weaker tool-calling models on routine repository work without giving up the persistent JavaScript notebook that makes complex composition efficient.

The first release adds a bounded structured-action mode to the existing `javascript` tool. Raw `{ code }` remains the first-class escape hatch; `{ actions }` handles routine reads, searches, shell commands, and exact file writes without requiring the model to author JavaScript syntax for each operation.

## Dogfood Evidence

The exact user audit prompt was run with DeepSeek V4 Flash on current `main` in an isolated daemon and session directory:

> Find anything redundant, outdated, conflicting, or irrelevant to this project. First give me a KEEP / REMOVE list with one sentence per item. Do not edit any files.

The run was manually aborted after 228 seconds with no final answer. It had produced:

- 34 assistant turns;
- 53 JavaScript calls;
- 31,150 generated JavaScript characters;
- 309,042 tool-result characters;
- a 1.43 MiB session transcript; and
- five execution errors.

The errors were all routine interface failures: one expected search miss threw a `ShellError`, one Bun Shell result was treated as a string, and `.nothrow()` was attached after awaiting the shell promise three times. The third `.nothrow()` error repeated at the end of the session after an earlier correction, showing that prompt-only recovery was not durable.

Across 52 recent Prime sessions, 744 JavaScript calls produced 57 error results (7.7%). The largest preventable clusters were runtime-global redeclarations and shell/filesystem API-shape mistakes. The individual Bun cells generally completed in milliseconds, so the user-visible slowdown came from repeated model turns and large observations rather than JavaScript execution time.

## Research Basis

- [CodeAct](https://arxiv.org/abs/2402.01030) found that executable code actions improve composition and tool use, so the design keeps raw JavaScript instead of replacing it.
- [SWE-agent's Agent-Computer Interface](https://swe-agent.com/0.7/background/aci/) emphasizes LM-centric, bounded file and search commands, motivating a small reliable path for common operations.
- [TypeChat](https://microsoft.github.io/TypeChat/docs/techniques/) recommends regular, shallow JSON schemas with an escape hatch, motivating a flat action record rather than nested provider-specific unions.
- [OpenAI Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/) demonstrates the value of schema-constrained calls, but Prime supports providers that do not guarantee strict decoding, so every semantic constraint is also enforced locally.

## Socratic Decisions

### Is freeform JavaScript itself the problem?

Only partly. Raw code remains the best representation for parsing, filtering, aggregation, branching, and stateful computation. The reproduced failures occurred in routine plumbing where JavaScript added API recall and quoting requirements without adding useful expressiveness.

### Can more prompt guidance fix the issue?

No. The current tool and system prompts already explain `.nothrow()`, runtime globals, bounded output, qualified filesystem calls, and quoted-line Markdown writes. The dogfood model repeated a specifically documented `.nothrow()` mistake three times. Prompt guidance remains useful as a fallback, but it cannot structurally prevent the failure.

### Should Prime restore separate read, search, shell, and write tools?

No. The one-notebook architecture is intentional and supports persistent state, composition, one execution surface, and one transcript model. Structured actions stay inside the existing `javascript` tool and the existing Bun worker.

### Should the action format be a generic dataflow language?

No. None of the 53 dogfood calls required references between structured operations. A call/reference AST would add a second programming language before evidence shows a need for it. Real dependent computation continues to use `{ code }`.

### Should actions be generated into JavaScript source?

No. Code generation would reintroduce the quoting and injection layer the feature exists to remove. Actions are validated by the host and executed by dedicated handlers in the Bun worker.

### Which operations belong in the MVP?

Only `read`, `search`, `shell`, and `write`:

- `read` supplies a bounded line window without loading an unbounded observation into the transcript.
- `search` covers both pattern search and file listing, including the `rg --files` calls that caused repeated dogfood errors.
- `shell` provides the target project's native interface and always reports an exit code instead of throwing a cell error.
- `write` accepts raw content as a tool argument, so Markdown fences and backticks never enter JavaScript syntax.

There is no separate `list` action because `search` without a pattern lists files. There is no `edit`, delete, move, or arbitrary reference operation in this phase.

## Selected Interface

The existing tool accepts exactly one mode per call:

```ts
interface JavaScriptToolInput {
	code?: string;
	actions?: JavaScriptAction[];
}

interface JavaScriptAction {
	op: "read" | "search" | "shell" | "write";
	path?: string;
	offset?: number;
	limit?: number;
	pattern?: string;
	glob?: string;
	command?: string;
	content?: string;
}
```

The schema is deliberately flat. Runtime validation enforces the operation-specific contract:

- exactly one of `code` or `actions` is present;
- one through eight actions are allowed;
- multiple independent `write` actions may share a call;
- `read` requires `path`; `offset` and `limit` are positive integers;
- `search` accepts an optional scope `path`, optional `pattern`, and optional `glob`; an omitted pattern means file listing;
- `shell` requires a non-empty `command`;
- `write` requires a non-empty `path` and string `content`; and
- invalid input returns one precise error and recommends `{ code }` for work outside the structured surface.

Existing `{ code: string }` callers remain valid. The tool name and active-tool configuration do not change.

## Execution Semantics

### Kernel locality

Actions use a private `execute_actions` Bun worker request. They run under the same worker process, current working directory, environment, configured shell, output stream, abort/recovery boundary, and diff display channel as code cells.

Actions do not create global bindings, do not participate in namespace snapshots, and do not mutate notebook state. File and subprocess effects remain real, just as they are from raw JavaScript. The worker protocol version increases because the host and bundled worker must agree on the new request shape. There is no daemon command, event, capability, or response-shape change.

Classification: the public tool input extension is backward-compatible; the private Bun host/worker protocol change is incompatible and lockstep-versioned; the daemon protocol is unchanged.

### Per-operation behavior

- `read` streams a numbered line window from `offset` (default 1) for `limit` lines (default 200, maximum 2,000).
- `search` invokes ripgrep with argument arrays rather than interpolated shell source. Exit code 1 is a successful zero-match or zero-file result. If ripgrep is unavailable, Git-backed repositories fall back to `git grep` or `git ls-files`.
- `shell` uses the existing configured-shell runner and always returns `exitCode`, `stdout`, and `stderr`. A non-zero exit is reported normally and stops later actions without turning the cell into an error.
- `write` creates missing parent directories, reads bounded prior content, writes UTF-8 bytes directly, and emits the existing `KernelDiffDisplay` when the combined old and new content is at most 64 KiB. Larger replacements emit only a byte-delta summary so session history does not duplicate the file. A failed write stops later actions.

Read and search failures are reported per action and do not stop independent later probes. Validation failures stop before the kernel starts. Abort kills and recovers the worker through the existing execution boundary, including active child processes.

### Bounds

- Maximum eight actions per call.
- Multiple independent writes may share a batch, up to the eight-action limit; each write emits its own diff and the batch stops on the first write failure.
- Maximum 8 KiB displayed output per action using a head/tail truncation marker.
- Maximum 24 KiB model-visible output per call across action bodies or ordinary code output; action headers are preserved and later bodies are elided when the batch budget is exhausted.
- Maximum 1 MiB structured write content; larger generated files use `{ code }` or a project-native command.
- Maximum 64 KiB combined old and new content in persisted structured-write diff details; larger replacements retain only the normal tool arguments and a byte-delta result summary.
- The existing 64 KiB worker capture, 1 MiB protocol result, and 16 KiB structured-detail duplication limits remain in force behind the tighter display bound. Error tracebacks remain intact after bounded code output.
- Structured actions retain no raw write content after the call completes beyond the normal session tool arguments.

Each output section begins with a stable action header containing its index, operation, and compact target. This lets the model and TUI associate bounded output with the action without duplicating it in result metadata.

## TUI Design

Structured calls use the existing JavaScript cell component and do not add animation. This is a keyboard-heavy, high-frequency surface where motion would make the interface feel slower.

Collapsed state:

```text
✓ js · read×2 search shell · ↓ 38 lines · 320ms
```

Expanded state shows at most eight action rows. Each row includes the operation and a width-bounded target: path and line window for `read`, pattern/glob/scope for `search`, exact command for `shell`, and path plus byte count for `write`. Write content is shown only while expanded, and completed writes continue to use the existing diff rendering and compact file-change summary.

The summary line stays structurally identical between collapsed and expanded states, preserving the current no-layout-shift behavior. Long paths, patterns, and commands are truncated at render time, never copied into extra unbounded UI state.

## Prompt Policy

The system and tool descriptions lead with a short mode choice:

- batch independent routine file/search/shell/write work in `actions`;
- use `code` for computation, branching, dependent operations, prepared JavaScript skills, and persistent state; and
- prefer structured `shell` over Bun Shell `$` when no JavaScript composition is needed.

The fallback guidance explicitly rejects `child_process` and `execSync`, whose throw-on-nonzero behavior recreates the expected-search-miss failure that structured `search` avoids.

One concise example covers each mode. The duplicated long code-field guidance is shortened; detailed raw-code rules remain in the system prompt for fallback use.

## Verification and Acceptance

Test-first coverage must prove:

- exactly-one-mode and per-operation validation;
- action-count, offset/limit, write-size, and persisted-diff caps;
- search no-match returns a successful `0 matches` result;
- shell non-zero returns a structured exit result and stops later actions without a cell error;
- a Markdown file containing triple backticks, quotes, and `${...}` round-trips byte-for-byte and emits a diff;
- read windows are numbered and bounded;
- action output uses head/tail truncation;
- whole action batches and ordinary code output stay within the 24 KiB display budget while preserving action headers and error tracebacks;
- abort during a batch recovers the worker;
- action calls leave `list_names` unchanged;
- old `{ code }` execution remains unchanged; and
- collapsed/expanded action rendering remains bounded and stable.

Live acceptance reruns the exact audit prompt three times with DeepSeek V4 Flash. The feature passes only if:

1. all three runs produce a final answer;
2. the known ShellError, Buffer-shape, `.nothrow()` placement, fenced-write, runtime-global, and `child_process` expected-search-miss classes occur zero times;
3. each run has at most one cell error overall;
4. at least half of routine read/search/list probes use structured actions;
5. each run stays at or below 25 assistant turns; and
6. no single model-visible call exceeds 25,000 characters; 120,000 cumulative tool-result characters remains an advisory observation target because model-chosen call count is stochastic and hidden refusal would interrupt valid work.

If adoption stays below 50%, refine the schema description and examples but do not add more operations. If the threshold still fails, park the structured surface rather than expanding it.

## Non-Goals

- No deprecation of raw JavaScript, Bun Shell `$`, or `sh`.
- No inter-action values, references, variables, loops, or conditional DSL.
- No edit, delete, rename, copy, network, package-install, skill, or subagent action.
- No hidden model call, syntax repair, source rewrite, or retry.
- No provider-specific strict-schema dependency.
- No host-side execution outside the Bun worker.
- No automatic migration of historical tool calls.

## Fable5 Gate

Fable5 returned `SATISFIED_PROCEED` and ranked the designs `hybrid > prompt-only > generic dataflow`. It approved the four-operation flat schema, direct in-kernel execution, eight-action and initial one-write caps, bounded per-action output, action-aware TUI, and three-run DeepSeek acceptance gate. It explicitly rejected a general reference DSL and restoring a multi-tool toolbox. Mixed-workflow dogfooding later showed that the one-write cap itself created an avoidable validation error when DeepSeek batched two independent files, so the cap was removed while retaining sequential writes, per-file diffs, and stop-on-write-failure behavior.

After the first post-implementation run, Fable5 returned `BLOCKED_FIX_LIST`. Transcript verification showed the 57.7 KiB spike came from freeform `execSync` code rather than an action batch, so it rejected a second tool and heuristic code rejection. It required one 24 KiB display budget across both modes, preserved action headers and error tracebacks, and a targeted `child_process` prohibition before rerunning live acceptance.

The final varied DeepSeek V4 Flash matrix covered repository auditing, fenced Markdown creation, exact multi-file edits, mixed read/search/shell/write work, and redundant runtime-global destructuring. It completed 55 tool calls with zero execution errors; the final audit used only the `javascript` tool name, produced no `child_process` calls, stayed below 13.6 KiB for every result, and returned a KEEP/REMOVE answer without editing files. That audit reached 139,521 cumulative result characters rather than the 120,000 advisory target; Fable5 ruled this a measured follow-up because the enforced per-call invariant held with 47% headroom, while a hidden cumulative refusal would terminate otherwise-valid work.
