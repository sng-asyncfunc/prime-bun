# Bun REPL Performance Round 2 Design

## Objective

Eliminate cold-start tool and shell-API fumbles in weaker models, make runtime errors measurable, and release detached Bun session memory promptly without weakening session recovery.

## Live Evidence

Four isolated DeepSeek V4 Flash scenarios produced 57 tool calls. Exact fenced-file edits and computation completed with zero errors, but the first broad repository exploration produced two nonexistent `shell` tool calls and one `sh(...).nothrow()` `TypeError`: three visible errors in 17 calls. The same long session accumulated 188,043 tool-result characters while remaining responsive, with every individual result bounded to 24,576 characters.

Source-mode RSS was dominated by process lifetime rather than an individual Bun-cell leak. The active client, supervisor, catalog, session worker, and Bun kernel used about 937 MiB in aggregate. After the client detached, the supervisor retained the catalog plus the session worker and kernel for about 687 MiB; after another long turn it retained about 808 MiB. The catalog alone remained idle at about 169 MiB, and the detached worker/kernel tree remained eligible for eviction only after the current 30-minute default.

Runtime-error accounting is incorrect: JavaScript tool results already return `isError`, but the generic agent loop discards that flag for every non-throwing tool execution. Transcript metrics based only on the message flag therefore undercount visible failures.

Post-implementation dogfooding exposed three additional source-mode failures. The original read-only audit reached 32 error-free calls and 76,720 result characters without synthesizing, an exact fenced edit first attempted an unsupported structured `edit`, and a worker launched into another `--cwd` failed because a relative `TSX_TSCONFIG_PATH` was resolved after the cwd change. A repeated cold exploration also destructured `.text()` as an object and omitted otherwise unambiguous action `op` fields.

## Socratic Decisions

### Is raw JavaScript still the main problem?

No. The exact-write and computation scenarios were clean. The remaining cold-start failures came from strong model priors at the tool boundary: calling a conventional `shell` tool and applying Bun Shell's `.nothrow()` method to Prime's configured-shell promise.

### Should Prime expose a full read/search/bash/write/edit toolbox?

Not yet. It would add schemas and choice cost to every model request even though the structured `javascript.actions` path already handled difficult edits exactly. A hidden, deterministic compatibility alias on the existing tool preserves one advertised schema while converting safe, recognizable legacy calls before validation. Unsupported shapes remain errors instead of being guessed.

### Which aliases are safe?

Only operations already represented exactly by structured actions: `shell`/`bash`, `read`/`read_file`, `search`/`grep`, and `write`/`write_file`. A hidden top-level `edit` alias remains deliberately excluded because guessing its many provider-specific shapes could corrupt files. Instead, the advertised structured-action schema gains a native exact `edit` operation with unique-match enforcement.

### Should `sh()` mimic Bun Shell?

Only for harmless consumers. `sh()` already never throws for a non-zero exit, so `.nothrow()` is a semantic no-op returning the same promise. `.quiet()` is also a no-op because configured-shell output is already captured. Both remove common API-shape failures without changing execution semantics.

### Is supervisor loss currently an orphan leak?

Not by itself. A session worker already monitors its authenticated supervisor connection and elects a replacement supervisor after loss. The initial manual probe killed the worker before that recovery window completed, so it is not evidence for a new parent-liveness watchdog. Round 2 will live-test the existing election path. The separate Bun kernel still needs to exit immediately when its session worker closes protocol fd 3.

### Is prompt guidance enough to bound weak-model exploration?

Only when concrete. The existing 20-call prose did not stop a 32-call audit. An active-tool guideline sets a 12-call read-only inspection budget, while per-call output remains bounded. A hard global tool-call cutoff is rejected because it would prematurely stop legitimate coding work and autonomous tasks.

### Should malformed actions always fail schema validation?

No. When an action omits only `op`, its discriminating fields make the intent exact: `command` means shell, `oldStr`/`newStr` edit, `content` write, `pattern`/`glob` search, and path/offset/limit read. Conflicting shapes remain validation errors.

## Selected Design

1. Add optional `isError` to generic tool results and propagate it through the agent loop unless an `afterToolCall` hook overrides it.
2. Add non-advertised per-tool compatibility aliases to the generic tool runtime. Normalize recognized alias calls to canonical `javascript` tool calls before final assistant-message persistence and execution.
3. Configure the JavaScript tool with bounded alias mappers for safe structured actions only.
4. Add no-op `.nothrow()` and `.quiet()` consumers to `sh()` and shut down the Bun worker on protocol-input EOF.
5. Retire the catalog subprocess after 120 seconds without requests and restart it transparently on the next request.
6. Change the default detached whole-tree eviction policy from 30 minutes to 5 minutes. Attached, active, scheduled, heartbeat, and busy trees retain the existing exemptions.
7. Add a unique exact-match structured `edit`, infer only unambiguous missing action operations, and clarify that shell `.text()` consumers return strings rather than result objects.
8. Anchor a relative tsx config before any CLI cwd change so source-mode supervisors and workers can launch from arbitrary target projects.
9. Add a concrete 12-call budget for ordinary read-only repository audits.

The alias and tool-result additions are backward-compatible library API extensions. No daemon command, event, response shape, capability, schema revision, or protocol version changes. Bun EOF and `sh()` changes are internal implementation behavior and do not alter the private worker wire format.

## Acceptance Gates

- Generic agent tests prove encoded errors remain errors and absent flags remain successful.
- Alias tests prove canonical persistence/execution, strict shape rejection, and no additional advertised provider tools.
- Bun worker tests prove `sh("exit 7").nothrow()` resolves with exit code 7, `.quiet()` remains composable, and closing protocol input exits the kernel within one second.
- Catalog tests prove idle retirement is reset by activity and the next request starts a fresh process.
- Settings and eviction tests prove the five-minute default while preserving active/attached exemptions.
- The same DeepSeek cold exploration, exact fenced-write, computation, and long follow-up scenarios rerun with zero unknown-tool or `sh()` API errors and consistent visible/transcript error counts.
- Live fenced-edit dogfooding uses structured `edit`/`write` actions without generated JavaScript or retry, and missing action operations are repaired only when their shapes are unambiguous.
- A live detached session drops its worker/kernel after the five-minute policy window, the catalog disappears after two minutes, and supervisor termination results in replacement-supervisor adoption rather than duplicate or abandoned workers.

## Non-Goals

- No visible multi-tool toolbox.
- No top-level `edit` alias or heuristic repair of ambiguous edit shapes.
- No heuristic repair of arbitrary JavaScript source.
- No hard global tool-call cutoff or cumulative output refusal while individual calls remain bounded.
- No new supervisor watchdog unless the existing replacement election fails live verification.

## Fable5 Gate

Fable5 returned `BLOCKED_FIX_LIST`: telemetry, structural compatibility, kernel EOF cleanup, catalog retirement, and shorter worker eviction were required before another live gate. Its proposed extra worker parent-liveness watchdog was rejected after code verification found the existing replacement-supervisor election path; that path remains subject to a live failure/recovery test before ship.
