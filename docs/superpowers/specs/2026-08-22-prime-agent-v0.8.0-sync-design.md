# Prime Agent v0.8.0 Synchronization Design

## Objective

Bring Prime Bun to selective behavioral parity with Prime Agent v0.8.0 while preserving the persistent Bun JavaScript notebook, bounded rendering and recovery, negotiated daemon compatibility, configurable keybindings, Prime Bun branding, and the no-telemetry policy. Validate the integrated release through focused tests, a live authenticated Grok dogfood run, and a read-only Fable5 go/no-go gate.

## Reviewed range

The reviewed upstream range is `af0b8e00..8d7deeab`, from the previously dispositioned Prime Agent v0.7.4 release through the v0.8.0 release. It contains twenty-two commits.

| Prime Agent source | Decision | Prime Bun treatment |
| --- | --- | --- |
| `d98d0762` ACP resident lifecycle | Exclude | The 5,500-line protocol rewrite conflicts with Prime Bun's daemon and durable JavaScript action lifecycle; it requires a dedicated compatibility project rather than a release-sync merge. |
| `02e217e6` ACP prompt admission | Exclude | The owned prompt-cancellation schema is built on `d98d0762`; exclude it with the resident-lifecycle rewrite and the unrelated generated model catalog. |
| `91b5c619` empty credential env values | Port | Treat configured environment-variable names whose value is empty as missing credentials. |
| `f8f02221` generic kernel MCP runtime | Not applicable | The shipped implementation is a Python/IPython runtime and its host management surface is inseparable from that lifecycle; retain Prime Bun's authored JavaScript MCP skills and assess a generic Bun API separately. |
| `ab3db326` headless continuation failure | Port and adapt | Add a narrow Prime Bun-owned continuation settlement so ACP and print-mode waiters reject when a post-compaction continuation cannot start. |
| `55277ff3` cold IPython/ZMQ startup | Not applicable | Prime Bun has no IPython, Python virtual environment, or ZMQ kernel channels; retain its Bun worker startup diagnostics. |
| `bb61ca21` MCP security and shutdown follow-ups | Port and adapt | Bind user-server OAuth credentials to exact endpoints, make credential removal disk-verified, and reserve authored integration URLs. Exclude generic Python runtime shutdown, Python dependencies/tests, and generated models. |
| `b5807b6f` changelog fragments | Exclude | This is upstream release machinery and governance; Prime Bun retains its explicit package changelogs and repository trace ledger. |
| `a3af021c` queue-browse hint styling | Port | Dim the queue-browse header while retaining the configured editor behavior. |
| `addfc23f` IPython/forkserver parent watchdog | Already superseded | Prime Bun workers already use owner-scoped process cleanup, orphan journaling, recovery checkpoints, and PID-identity safeguards; no Python forkserver code applies. |
| `c75a637b` ACP MCP programs | Not applicable | This routes ACP servers into the excluded generic Python MCP runtime; Prime Bun keeps ACP and authored JavaScript MCP skills separate. |
| `bb3ac37f` subagent summary tile | Port | Render the prompt summary as a bordered agents tile with running, idle, and inactive counts. |
| `848081ed` OpenAI API-key `/fast` | Port | Permit supported GPT-5.4/5.5/5.6 OpenAI API-key models and use the corrected multiplier without changing generated model data. |
| `e51d2266` goal continuation quiescence | Port | Hold goal continuation while descendant work is unsettled and resume in queue order after settlement. |
| `35103cb4` typed continuation errors | Port | Replace message-text matching with stable `AgentContinueError` codes. |
| `48b6478e` working timer continuity | Deferred | The patch crosses Prime Bun's diverged session scheduler and 8,000-line interactive controller; land it separately with attach/resume dogfood rather than coupling it to security and headless fixes. |
| `108eff32` `session_before_refine` hook | Deferred | The new public extension contract fans across refinement planning, exports, docs, and scheduler state; it needs a dedicated compatibility review against Prime Bun's serialized refine path. |
| `274cbb84` refinement outcomes | Deferred | This depends on `108eff32` and rewrites multiple shared transcript cards; defer the coupled TUI/API change instead of accepting a partial outcome contract. |
| `8c749fb9` MCP protected-resource OAuth | Port | Follow RFC 9728 protected-resource discovery, preserve canonical resources, and allow same-origin tenant issuers. |
| `34b294f8` heartbeat catalog failed workers | Deferred | The one-line behavior sits inside Prime Bun's substantially expanded supervisor; validate its recovery semantics in a daemon-focused follow-up rather than editing that lifecycle casually. |
| `a3d86fbe` MCP provider refresh | Already superseded | Prime Bun already refreshes dynamic OAuth providers and authored JavaScript MCP skill gating after login, logout, and resource reload. |
| `8d7deeab` v0.8.0 release metadata | Recreate locally | Bump Prime Bun and all lockstep packages to 0.8.0 without upstream distribution code, publication, tags, or GitHub releases. |

## Behavioral contract

### Headless lifecycle

- ACP and print mode reject the current terminal wait when an owned post-compaction continuation fails to start.
- A failed continuation is exposed once and never poisons later idle waits.
- Stable `AgentContinueError` codes replace message-text matching for busy and nothing-to-continue conditions.

### MCP credential safety

- User-server OAuth credentials carry the exact endpoint that issued them and are never reused after a server is retargeted. Same-named authored integrations continue to reject stored credential reuse when a user overrides their URL.
- Empty configured credential environment variables are treated as missing rather than literal credential names.
- OAuth discovery follows protected-resource metadata without accepting a cross-origin issuer.

### Interaction and goals

- Queue-browse guidance reads as a hint and subagent counts render as a stable bordered tile.
- Goal continuation waits for descendant settlement, respects abort/admission pauses, preserves queue order, and counts resumed continuations once.

## Implementation boundaries

- Apply upstream behavior in reviewable batches and resolve against Prime Bun's current files; do not import Python runtime files, IPython code, forkserver code, ZMQ behavior, or Python tests.
- Do not modify `packages/ai/scripts/generate-models.ts` or `packages/ai/src/models.generated.ts`; both contain unrelated user work.
- Do not add telemetry, analytics, trace sharing, Linear governance, changelog-fragment automation, upstream distribution scripts, promotional badges, or release publication.
- Keep keybindings configurable and reuse existing TUI components and theme tokens.
- Do not add a daemon wire dependency in this synchronization; the excluded ACP lifecycle and ACP MCP commits remain recorded for a dedicated capability-gated project.
- Add or port focused regressions for each selected behavior and run every changed test file from its package root.

## Verification and delivery

- Run focused tests for headless continuation, authentication/OAuth, goals, fast mode, and TUI components.
- Run `npm run check` with complete output, `git diff --check`, version consistency checks, and scans for excluded Python/telemetry/generated-model changes.
- Dogfood from source with an authenticated Grok model: startup, persistent JavaScript, exact fenced Markdown writes containing quotes and backticks, large output expansion/collapse, cancellation/recovery, draft/resume behavior, and RSS/UI responsiveness.
- Send the final diff and verification evidence to Fable5 in read-only mode. Only `SATISFIED_PROCEED` or `SATISFIED_LIVE_TEST` permits delivery.
- Commit only synchronization-owned files, fast-forward local `main`, push `origin/main` without force, and verify the local, tracking, and remote refs match.

## Non-goals

- Python/IPython runtime parity, Python package management, ZMQ/forkserver behavior, generic MCP runtime, or ACP MCP programs.
- The upstream ACP resident-lifecycle protocol rewrite and its owned queued-prompt schema; both require a dedicated compatibility design.
- Prime Agent telemetry, conversation sharing, internal governance, changelog-fragment CI, npm publication, GitHub release creation, or tag creation.
- Model-catalog regeneration or direct generated-model edits.
