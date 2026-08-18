# Prime Agent v0.7.3 Synchronization Design

## Objective

Bring Prime Bun to selective behavioral parity with Prime Agent v0.7.3 while preserving the persistent Bun notebook, Prime Bun daemon safety guarantees, configurable keybindings, low-overhead terminal rendering, and telemetry-free product policy. The port must also reduce the cost of future upstream synchronization by adopting the upstream RLM family-authority foundation rather than repeatedly maintaining parallel session-discovery logic.

## Reviewed range

The reviewed upstream range is `83a0f9f9..61131b2d`, where `83a0f9f9` is the v0.7.2 release commit already dispositioned in Prime Bun and `61131b2d` is the Prime Agent v0.7.3 release commit. The range contains 30 commits.

| Upstream commit | Decision | Reason |
| --- | --- | --- |
| `1ae59498` null assistant content | Port | Malformed provider blocks must not crash incremental assistant rendering. |
| `8edd21b0` Prime model catalog | Defer | Overlaps user-owned uncommitted model-generator work in the main checkout. |
| `a3b3e753` issue templates | Skip | Repository governance, not runtime or user-facing parity. |
| `91977ebf` provider-derived reasoning | Defer | Valuable, but it changes the same generator and generated catalog currently edited by the user; it must be reconciled separately. |
| `965941c7` OSC 8 click handling | Port | Restores direct link interaction in fullscreen terminals that route mouse events to the TUI. |
| `0987c1ba` bare URL and Ghostty handling | Port | Completes the fullscreen-link stack and avoids stealing native Ghostty clicks. |
| `5e268e28` host-request contracts | Port | Gives Bun skills a deterministic, testable declaration of host bridge availability and is a useful future-sync boundary. |
| `7787f074` root-kill cleanup ownership | Port | Prevents failed root cleanup from losing ownership before retry. |
| `324298a2` Codex discovery version | Port | Lets Codex-authenticated users discover and spawn RLM subagents. |
| `ba4c53b3` opt-in trace sharing promotion | Reject | Product telemetry/trace-upload promotion is outside Prime Bun policy. |
| `8598deda` Python harness docstring | Reject | Python runtime-only change; Prime Bun must not restore or maintain Python REPL code. |
| `f8d73abe` Ctrl+P sent-message expansion | Port with adaptation | Apply to Prime Bun agent messages and JavaScript cells, never `ipython-cell.ts`. |
| `fa9e4ab1` agents-view recency sorting | Port | Improves large-session navigation while keeping running agents stable. |
| `25769089` Bugbot rules | Skip | Cursor-specific review configuration is not product parity. |
| `2ea5ae09` bare `--resume` and `/resume` | Port | Restores a useful session entry point without changing stored-session format. |
| `9bf49d89` workflow digest pins | Port selectively | Supply-chain hardening is valuable; adapt only workflows and actions that exist in Prime Bun. |
| `fd789e21` Ghostty mouse capture | Port | Completes the fullscreen mouse behavior corrected by the link stack. |
| `9f950114` trusted contribution process | Skip | Upstream organization governance is not Prime Bun runtime behavior. |
| `97b994c3` supervisor RLM spawn ledger | Port with adaptation | Establishes durable supervisor-owned family authority required by later subagent improvements. |
| `06e4a19d` ledger-backed subagent metadata | Port with adaptation | Removes divergent registry/catalog topology and consolidates passive subagent metadata. |
| `2c34b82f` live catalog refresh | Defer | Generated catalog churn overlaps user-owned model work and is not stable behavior. |
| `e64fbcbf` independent edit-diff control | Port with adaptation | Add configurable Ctrl+J ownership for diffs on Bun/JavaScript edit rows. |
| `875aba96` persistent edit summary | Port with adaptation | Keep edit summaries visible while rendering diffs inline under their own toggle. |
| `849c9211` agents-view search hint | Port | Small but correct usability copy for the sessions view. |
| `26f7f1a1` durable supervisor authority | Port with adaptation | Prevents macOS tmpdir cleanup from wedging long-running daemons; preserve Prime Bun identity and legacy fallback. |
| `a9a86550` deleted-child artifact cleanup | Port selectively | Remove deleted Bun kernel artifacts while retaining transcripts; omit unrelated provider-test churn. |
| `35f37ed0` subagent model and effort | Port | Makes heterogeneous RLM families understandable in the agents view. |
| `941d7b3e` model catalog regeneration | Defer | Same user-owned catalog conflict as the earlier model commits. |
| `114a1d6a` post-compaction continuation | Port | Long-running goals must resume after threshold compaction and remain cancelled when compaction is aborted. |
| `61131b2d` v0.7.3 release metadata | Recreate locally | Bump Prime Bun packages to 0.7.3 and write Prime Bun changelogs; do not copy upstream analytics or Python notes. |

## Behavioral contract

### Bun and provider robustness

- Null or unknown assistant content blocks are ignored for cache keys, visible-content checks, updates, and rendering.
- Host-request contracts expose the current request types to Bun JavaScript skills without turning host capabilities into new model tools.
- Threshold compaction resumes interrupted goals or autonomous work on success, skip, or recoverable failure, but never after user cancellation.
- No Python/IPython source, prompt, dependency, or test is added.

### Terminal and session ergonomics

- Fullscreen mode opens safe OSC 8 and bare HTTP(S) links on a plain non-drag click when the terminal delegates mouse input to the TUI.
- Ghostty keeps native link handling when appropriate and regains mouse capture when configured fullscreen behavior requires it.
- Ctrl+P expands sent and received agent messages consistently.
- Ctrl+J independently controls edit diffs; edit summaries remain visible and show exactly one configurable hint.
- Agents are sorted by most recent message within inactive sections while running agents retain stable creation order.
- Agents view shows subagent model and enabled effort, and its empty-input hint says that typing searches sessions.
- Bare `--resume` and `/resume` open the existing sessions view without changing the default new-chat behavior.

### Daemon and RLM family authority

- The supervisor owns a bounded append-only RLM spawn ledger that records spawn, rename, and delete topology.
- Ledger replay is bounded by bytes and records, rejects invalid interior data, repairs only a torn final record, and treats unknown future v1 operations as skippable.
- Seeding from legacy session metadata is atomic and cannot clobber a concurrent live append.
- Admission does not report success before its spawn record is durable; deletion remains tombstone-first and self-heals a lost ledger delete on retry.
- Passive subagent rows derive topology from the ledger, while compact display metadata stores presentation-only fields such as model and effort.
- Root-kill retry retains cleanup ownership until cleanup succeeds or is safely handed off.
- Supervisor authority records live outside `$TMPDIR`, with read-only legacy fallback for one compatibility window and no cross-process PID assumptions.
- Deleting an RLM child removes its Bun kernel/session artifact directory but preserves the transcript and never lets job-store cleanup mask a durable deletion.

## Architecture and adaptation

### 1. TUI link and rendering layer

Port the upstream URL parsing and painted-frame hyperlink lookup into `packages/tui`. Keep URL opening injectable through `TUI.onOpenUrl`, reject control characters, and distinguish click from drag. Prime Bun's interactive mode supplies the platform opener and existing settings manager. Assistant null-block tolerance stays local to `AssistantMessageComponent`.

### 2. Bun-native transcript and edit layer

The upstream release still references `ipython-cell.ts`; Prime Bun will apply equivalent state and hint behavior to `javascript-cell.ts` and shared tool/edit components. `app.tools.expand`, `app.messages.expand`, `app.thinking.expand`, and the new `app.diff.expand` remain independently configurable. No hardcoded key comparisons are allowed.

### 3. Host request contract boundary

Expose a read-only set of registered host request names from the kernel manager and add it to the JavaScript skill context. The contract is descriptive only: host handlers remain authoritative, unavailable calls still fail, and no daemon wire command is introduced.

### 4. Supervisor ledger boundary

Adopt upstream `rlm-ledger.ts` and `rlm-subagent-display.ts` as focused modules. Integrate them with Prime Bun's already-hardened stop/recovery supervisor instead of replacing the supervisor wholesale. Preserve Prime Bun's process-generation checks, stop finalizer, schema revision history, and optional capability degradation.

The ledger and display files are internal durable state, not daemon protocol messages. If integration reveals any command, event, or response-shape change, classify it explicitly, advance `DAEMON_SCHEMA_REVISION`, update compatibility maps, and add old/new daemon tests before use.

### 5. Durable authority records

Move ownership JSON away from the socket tmpdir while retaining the socket itself under `$TMPDIR` for Unix path-length limits. Prime Bun shares the session/config namespace with Prime Agent, so the authority registry must continue preventing two supervisors from concurrently owning the same session population. Environment and explicit-directory overrides remain isolated in tests.

### 6. Model changes and dirty-main isolation

Do not modify `packages/ai/scripts/generate-models.ts` or `packages/ai/src/models.generated.ts` in this branch. Record the four deferred upstream commits in `changelog.md` so a future agent can reconcile them after the user's current edits are committed. Never modify `models.generated.ts` directly.

## Error handling and safety

- URL opening accepts only HTTP(S), rejects terminal control characters, and never treats a drag as a click.
- Ledger reads are size-bounded before allocation; malformed interior records fail closed instead of silently rewriting family history.
- Ledger writes are append-only and flushed at admission boundaries where later behavior depends on them.
- Display metadata uses canonical session paths, atomic replacement, and legacy fallback without restoring registry topology.
- Supervisor ownership renewal is single-flight; release waits for in-flight renewal and prevents post-release rewrites.
- Artifact cleanup operates only on validated child session paths and never deletes transcript JSONL files.
- Compaction cancellation withdraws only the continuation action it queued and rolls back only the corresponding usage count.
- Existing user-owned modifications and untracked directories in the main checkout remain unstaged and unmodified.

## Versioning and delivery

- Set the root and all published workspace packages to `0.7.3` without tagging or publishing packages.
- Finalize each affected package's flat `[Unreleased]` bullets into Prime Bun-specific v0.7.3 notes only if the repository's existing release workflow requires it; do not copy upstream release prose wholesale.
- Update the repository `changelog.md` with every upstream disposition, exact Prime Bun commit traces, the new observed checkpoint, deferred model work, verification, and Fable5 verdict.
- Fast-forward and push `main` only after the feature branch is clean, all checks pass, live dogfood succeeds, and Fable5 returns a proceed verdict.

## Verification

- Run `npm run check` after every code-bearing commit and on the merged tree.
- Run every modified test file from its package root using the package's configured runner.
- Cover malformed assistant blocks, hyperlink click/drag/control characters, Ghostty settings, host request contracts, root-kill retry, RLM ledger replay/repair/seeding, display metadata, artifact deletion, resume routing, edit-diff toggling, agents-view sorting/model effort, and compaction continuation.
- Dogfood from source with DeepSeek V4 Flash and Pro: long read-only audit, persistent two-cell JavaScript, structured fenced-Markdown write/edit outside the repo, queue/interrupt responsiveness, `/resume`, agent view, and memory settling.
- Inspect added lines for telemetry, trace-upload promotion, Python/IPython sources, hardcoded key checks, and direct edits to generated model data.
- Use Fable5 as the final read-only go/no-go gate.

## Non-goals

- Prime Agent analytics, trace sharing, installation identity, PostHog, or Prime platform ingestion.
- Python REPL, IPython cell rendering, Python harness documentation, or Python package management.
- Live model-catalog refresh or provider-reasoning generation while the user's generator files are dirty.
- Upstream contribution gates, issue templates, Bugbot rules, or release automation.
- Publishing packages, creating a v0.7.3 tag, or force-pushing.
