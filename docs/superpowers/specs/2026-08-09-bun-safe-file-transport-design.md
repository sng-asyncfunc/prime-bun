# Bun Safe File Transport Design

## Objective

Make authored file writes and exact edits reliable for weak and strong models by keeping literal content out of JavaScript source, while preserving the persistent Bun notebook for computation, branching, and computed writes.

## Reproduced Failure

Session `019fe7fa-51c8-7263-b871-15e53f3241e8` provides a direct A/B reproduction with `deepseek/deepseek-v4-flash`:

- The model generated a 13,404-character JavaScript cell containing `mkdir`, a report assembled as an array of quoted lines, and `fs.writeFile`.
- Fourteen consecutive RACI rows omitted their closing quote and comma.
- Bun correctly rejected the cell before execution with `SyntaxError: Unterminated string literal at line 137, column 1`.
- The model then spent a long reasoning turn investigating apostrophes and backticks instead of the missing delimiters.
- The identical 12,807-byte Markdown document succeeded immediately through a structured `write` action.

The action implementation was already safe: content travelled as a JSON string, parent directories were created automatically, and bytes were written without reparsing the content as JavaScript. The failure was routing. The prompt simultaneously preferred structured writes, recommended quoted-line arrays inside code, advertised `fs.writeFile`, and did not state that structured writes create parent directories.

## Socratic Decisions

### Is this a Bun parser defect?

No. The source was invalid JavaScript and the parser returned the exact failing location before any side effect occurred.

### Can automatic source repair make exact writes safe?

No. Recovering intended document boundaries from malformed JavaScript requires guessing. A guessed repair can silently publish corrupted content, which is worse than a loud failure.

### Is prompt correction sufficient?

No. Prompt correction is necessary, but prior prompt-only guidance already failed on the target model class. Exact text needs a structural transport that models can select directly.

### Does this require another runtime or file engine?

No. Provider-facing tools can share the existing `BunKernelProvisioner`, worker, structured-action validator, diff renderer, abort behavior, output bounds, and snapshot lifecycle.

### Should all writes from JavaScript be forbidden?

No. Computed writes remain legitimate. Code may write a value held in a variable after computation or transformation. The prohibited pattern is authoring a document by embedding its literal prose in JavaScript syntax.

## Selected Contract

Prime Bun advertises three built-in tool names by default:

1. `javascript` keeps both existing input modes: `code` for computation and `actions` for bounded batching and compatibility.
2. `write_file` accepts `{ path, content }` and executes one existing structured `write` action.
3. `edit_file` accepts `{ path, oldStr, newStr }` and executes one existing structured `edit` action.

`write_file` and `edit_file` are thin provider-facing adapters. They do not execute on the host and do not introduce a second filesystem implementation. Each delegates to `KernelManager.executeActions` through the same provisioner used by `javascript`.

### Exact-text guarantee

Literal content is exact only when it travels in the JSON tool argument fields `content`, `oldStr`, and `newStr`. Those values are decoded once as JSON and passed to the existing action engine; they are never parsed as JavaScript source.

`write_file`:

- creates missing parent directories;
- writes exact UTF-8 content, including empty files;
- retains the existing 1 MiB content limit;
- emits the existing bounded diff or byte summary; and
- uses the existing abort and worker-recovery boundary.

`edit_file`:

- requires one exact, unique `oldStr` match;
- allows an empty `newStr` for deletion;
- preserves all unmatched bytes; and
- emits the existing bounded diff.

### Computed writes

JavaScript code may continue to call `await fs.writeFile(path, computedValue)` or equivalent when `computedValue` was produced by actual computation. Prompt guidance must state that authored prose belongs in `write_file`; code must not rebuild authored documents as large string literals or quoted-line arrays.

## Prompt and Recovery Policy

The system prompt and tool descriptions will:

- name `write_file` as the default for creating or replacing exact file content;
- name `edit_file` as the default for exact unique replacements;
- state that `write_file` creates parent directories;
- remove the quoted-line-array fallback;
- remove authored-content examples using `fs.writeFile`;
- retain JavaScript filesystem guidance only for computed values; and
- avoid referencing dedicated tools when they are not active through an explicit allowlist.

When JavaScript parsing fails and the cell appears to attempt a file write, the worker returns a deterministic recovery hint: do not debug or repair string escaping; retry with `write_file` or a structured `write` action so content is carried outside JavaScript syntax. The worker never rewrites, extracts, or executes malformed source.

## Tool Activation and Compatibility

New sessions enable `javascript`, `write_file`, and `edit_file` by default. Explicit `--tools` and SDK allowlists continue to select exactly the requested names. `--no-builtin-tools` disables all three built-ins. Existing `javascript` action calls and compatibility aliases remain valid.

The public tool-surface addition is backward-compatible for callers that use explicit allowlists. Changing the default set is intentional product behavior. No daemon command, event, response shape, capability, schema revision, or protocol version changes. No Bun host/worker request shape changes.

## TUI

The dedicated calls use their own labels and existing generic tool-call rendering. Completed mutations reuse the same `KernelDiffDisplay` details returned by structured JavaScript actions. No animation or new retained content is introduced.

## Acceptance Gates

### Automated

- Default tool registration exposes exactly `javascript`, `write_file`, and `edit_file`.
- Explicit allowlists can select each tool independently.
- Both dedicated tools share the supplied Bun provisioner and delegate through `executeActions`.
- A Markdown fixture containing triple fences, apostrophes, double quotes, backticks, `${...}`, Unicode, and pipe-table rows round-trips byte-for-byte through `write_file` while creating parents.
- `edit_file` replaces one exact match, rejects missing and duplicate matches, permits empty replacement, and preserves surrounding content.
- Prompt tests prove quoted-line-array guidance is absent, parent creation is documented, and dedicated names appear only when active.
- Parse-error tests prove write-intent failures recommend structured transport and never recommend quoted-line arrays or automatic repair.
- Existing JavaScript `code` and `actions` behavior remains covered.
- `npm run check` passes with no errors, warnings, or infos.

### Live DeepSeek V4 Flash

Run three isolated document-authoring scenarios, including the reproduced report plus RACI task. Pass only when all runs satisfy:

1. zero parse-rejected cells;
2. every authored literal write uses `write_file` or a structured `write` action;
3. zero reasoning turns diagnose string-literal escaping;
4. written content is byte-exact;
5. no call exceeds 25,000 model-visible characters; and
6. the run remains responsive and reaches a final answer.

## Non-Goals

- No automatic repair, extraction, or retry of malformed JavaScript.
- No separate worker, runtime, process, or host-side file implementation.
- No dedicated read, search, or shell tools in this change.
- No document templating language or dataflow DSL.
- No provider-specific strict-schema dependency.
- No larger write, output, or transcript limits.

## Fable5 Design Gate

Fable5 returned `SATISFIED_PROCEED` and selected C+: advertise `write_file` and `edit_file` over the existing Bun action engine, fold in the prompt corrections, and replace the wrong-direction quoted-lines recovery hint. It rejected automatic repair and heuristic rejection of otherwise valid JavaScript.
