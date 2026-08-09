# DeepSeek V4 Full Dogfood Design

## Objective

Keep full-model repository exploration bounded and correct without weakening the exact structured edit path or imposing a global tool-call cutoff on legitimate coding work.

## Live Evidence

Four isolated `deepseek/deepseek-v4-pro` scenarios exercised JSON print mode, the interactive TUI, first-run repository exploration, and fenced Markdown edits. The interactive audit remained responsive through 15 structured calls and 115,180 tool-result characters, rendered in 10 ms, detached immediately, and held steady at about 775 MiB while active. The fenced edit/write scenario completed in three calls with zero errors and byte-exact output.

The JSON audit exposed quadratic serialization: a 183,558-byte persisted transcript generated 15,071,292 bytes of JSON output because every token delta repeated the entire accumulated assistant message. It made 16 JavaScript calls and produced 75,544 result characters before interruption.

The first-run exploration made 13 JavaScript calls and hit one schema error when V4 Pro added `outputMode: "files_with_matches"` to a structured search. It then fell back to generated JavaScript and repeatedly wrote `const { stdout } = await $\`...\`.text()`. Because `.text()` returns a string, destructuring silently yielded `undefined`; the calls appeared successful while discarding evidence.

## Socratic Decisions

### Is the TUI renderer the reproduced bottleneck?

Not at this scale. Real pane capture stayed at 10 ms, RSS remained stable, and detach was immediate. The reproduced amplification is in JSON print serialization, while the reproduced correctness miss is at the structured-search boundary.

### Should ordinary prompts receive a hard 12-call cutoff?

No. Both full-model audits exceeded the prompt guideline, but a global cutoff would also terminate legitimate debugging and coding turns. Keep the guideline as a soft target and address the failures that pushed the model away from bounded actions.

### Should Prime emulate every foreign search schema?

No. Support only the common, bounded output modes that directly change result cardinality: `content` (current behavior), `files_with_matches`, and `count`. Unknown values remain validation errors.

### Should `.text()` return a wrapper object?

No. A `String` wrapper changes `typeof` and strict equality for correct callers. Instead, the existing AST cell transform will rewrite only a single `stdout` object binding from an awaited zero-argument `.text()` call into the equivalent direct string binding. Multiple or non-stdout destructuring remains untouched and fails normally.

### Should JSON mode keep repeating full partial messages?

No. `message_start` and `message_end` already carry complete messages. Streaming `message_update` rows should carry only the assistant delta with its nested cumulative `partial` removed. This makes output linear while preserving enough information to reconstruct the stream.

## Selected Design

1. Extend structured search actions with optional `outputMode: "content" | "files_with_matches" | "count"` and select the corresponding ripgrep behavior without shell interpolation.
2. Preserve `outputMode` through validation, worker protocol logging, and TUI intent rendering.
3. Extend the Bun cell AST transform to lower a single `stdout` destructure from awaited `.text()` into a direct identifier binding.
4. Compact CLI JSON `message_update` rows to `{ type, assistantMessageEvent }`, stripping the cumulative `partial`; retain complete `message_start` and `message_end` rows.
5. Update JSON documentation and changelog for the intentionally leaner streaming shape.

No daemon command, event, capability, schema revision, or protocol version changes. The daemon already sends compact private deltas and reconstructs the public event locally; this change affects only CLI JSON stdout.

## Acceptance Gates

- Search tests prove all three modes, bounded output, missing-match behavior, and schema rejection of unknown modes.
- Cell-transform tests fail before implementation and prove direct `.text()` use is unchanged while single-`stdout` destructuring is lowered exactly.
- Print-mode tests prove a growing assistant message produces delta-sized JSON rows without cumulative message or nested `partial` payloads.
- Repeated V4 Pro exploration uses `files_with_matches` without a validation retry or silent `undefined` evidence.
- The fenced edit regression remains byte exact.
- Targeted tests and `npm run check` pass before integration.

## Non-Goals

- No global hard tool-call cap.
- No generic foreign-tool schema emulation.
- No `String` wrapper or global prototype mutation.
- No interactive event API or daemon protocol change.
- No changes to the already successful exact edit/write path.
