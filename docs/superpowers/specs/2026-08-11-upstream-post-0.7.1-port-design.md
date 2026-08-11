# Post-0.7.1 Upstream Port Design

## Objective

Port the valuable Prime Agent changes merged after v0.7.1 into Prime Bun without importing product analytics, Prime platform coupling, Python-kernel assumptions, or an unused Homebrew distribution path. Preserve Prime Bun's Bun-native runtime and protocol version while adopting upstream reliability and terminal usability fixes.

## Upstream inventory

The reviewed range is `v0.7.1..PrimeIntellect-ai/prime-agent:main` through commit `14d6e749` on 2026-08-11.

| Upstream commit | Decision | Reason |
| --- | --- | --- |
| `10fb172b` Homebrew ownership | Skip | Prime Bun has no documented Homebrew distribution. |
| `b817a089` sent agent-message rendering | Port with adaptation | Removes noisy receipt output, but the receipt detector must understand Bun/JavaScript output rather than Python reprs. |
| `a18809e0` product analytics | Reject | Adds persistent installation identity, outbound analytics, Prime platform ingestion, PostHog coupling, and telemetry daemon policy. |
| `c131d94c` Gemini test model refresh | Port | Keeps opt-in provider tests on the current representative model without changing production behavior. |
| `ebfe770e` login URL copy | Port | Makes wrapped OAuth links reliable over SSH and in narrow terminals using the existing clipboard abstraction. |
| `d698b4b7` agents-view expansion persistence | Port | Preserves user-controlled expansion state across view remounts and identity transitions. |
| `d1b07268` independent expansion controls | Port with adaptation | Separates tool, thinking, and agent-message expansion; also supplies a stop/retry serialization prerequisite for later worker fixes. |
| `71ca6cfd` queued-message editing | Port | Replaces destructive bulk dequeue with safe per-item browse, edit, delete, reorder, and lane changes while preserving queues on interrupt. |
| `2857e234` honest worker lifecycle | Port | Prevents stopping or disconnected workers from appearing ready or receiving new work. |
| `e9ef5777` timed-out stop finalization | Port | Adds PID-generation-safe escalation, zombie detection, cleanup retry, and durable stop completion. |
| `14d6e749` resume self-healing | Port | Reclaims confirmed-dead registrations so saved sessions can reopen without manual repair. |

## Behavioral contract

### Terminal ergonomics

- Login dialogs expose a configurable copy-link action and use the raw OAuth URL, not wrapped terminal text.
- Tool output, agent-to-agent messages, and thinking traces expand independently through configurable keybindings.
- Collapsed thinking remains one line and includes a bounded recap; expanded content retains an explicit collapse hint.
- Sent agent messages show the same compact summary and guttered expanded body as received messages.
- A single structured agent-message receipt already represented by the summary is suppressed; broadcasts, failures, unrelated values, and values that merely mention a receipt ID remain visible.
- Agent-tree and revealed-program expansion choices persist for the current client run and survive active-to-persisted row identity changes.

### Queued messages

- Alt+Up and Alt+Down browse queued steering and follow-up messages without removing them from the server-owned queue.
- Enter applies an edit as steering; the configured follow-up binding applies it as a follow-up. Empty submission deletes the selected item.
- Configurable move-earlier and move-later actions reorder an item within its current lane.
- Ctrl+C or Escape aborts active work but preserves queued messages. Queue draining resumes after a successful edit or a fresh submission.
- The old restore-all `app.message.dequeue` behavior is intentionally replaced. Existing custom bindings migrate to `app.message.navigateOlder`.
- Mutation failures, stale indices, daemon incompatibility, session switches, and concurrent queue events never silently lose the user's edited text or overwrite a newer draft.

### Worker lifecycle and recovery

- Durable or in-memory stop intent is reported as `stopping`; disconnected workers are never reported as `ready`.
- Stopping workers remain visible to daemon busy-safety checks but are excluded from live agent selection, fan-out, attach, and ordinary routing.
- Stop and retry cannot race: retry is rejected while a stop invocation still owns the worker.
- Signals are sent only after confirming the original process generation. A recycled PID is never signalled, and an unobservable identity is never treated as proof of death.
- Timed-out stops continue in a single-flighted background finalizer, escalate only against the authenticated process generation, treat zombies as dead, and retry cleanup failures.
- Resume reclaims only a tombstoned, disconnected registration whose process is confirmed gone or replaced. Healthy, recovering, unknown-identity, or still-running workers are untouched.
- A bounded reclaim wait returns a retryable error instead of hanging resume or reusing a confirmed-dead registration.

## Architecture

### 1. Bun-native transcript adaptation

Extract shared agent-message summary, preview, and body renderers from `agent-message.ts`. Apply the upstream presentation behavior to `javascript-cell.ts`, not the deleted `ipython-cell.ts`. Receipt suppression will validate the structured result against the recorded sent-message ID and receipt shape; it will not use a broad substring match.

The expansion state remains split in `InteractiveMode`: one flag for tool cells and one for agent messages, while thinking keeps its existing visibility flag. Scope-aware default key resolution prevents a user-added editor binding from silently colliding with a new default.

### 2. Queue mutation boundary

Add a small `QueueSelection` state machine that owns draft stashing, cursor movement, and resynchronization. Core queue mutations remain in `AgentSession` and address an item by `(lane, index, expectedText)` against the same visible projection published to clients. This acts as compare-and-swap without adding persistent queue IDs.

Remote mutation is a new optional daemon command behind `queue_message_mutation`. Old daemons return `unsupported`; the client retains the edit and shows a local status. Mutations serialize client-side, and optimistic queue updates apply only if no newer queue event replaced the mirror.

Protocol classification: backward-compatible and capability-gated. Prime Bun keeps `DAEMON_PROTOCOL_VERSION = 8`, advances its Bun-specific schema history from revision 14 to revision 15, updates command compatibility maps, and covers new-client/old-daemon plus old-client/new-daemon behavior. The schema ID is recomputed from Prime Bun's actual wire types rather than copied from upstream protocol 7.

### 3. Worker lifecycle boundary

Keep process existence and zombie detection in `utils/child-process.ts`. Keep process-generation verdicts, stop single-flighting, finalization, and stale-registration reclaim inside `DaemonSupervisor`, where descriptor identity and ownership are available.

The `stopping` worker state is an optional response-shape extension and an honest semantic correction. It is backward-compatible without a new command capability, but receives schema revision 16 so clients can distinguish the semantics. Session summaries and agents-view filters degrade locally when `workerState` is absent. No telemetry attach checks or policy fields are introduced.

### 4. Attribution and maintenance

Port behavior in dependency order and preserve upstream PR references in commit bodies or changelog entries where useful. Do not copy upstream changelog context that mentions analytics. The Gemini change remains test-only.

## Error handling and safety

- Clipboard failure is surfaced in the login dialog and never changes authentication state.
- Queue operations preserve the draft on every rejected, invalid, unsupported, or thrown mutation path.
- Queue selection is cleared on session switch so a stale selection cannot mutate another session.
- Process signalling fails closed on missing identity evidence.
- Stop cleanup verifies the tombstone, stop revision, worker registration, PID, and process start identity after asynchronous boundaries.
- Background finalization is bounded during shutdown and leaves a durable tombstone for the next supervisor when cleanup cannot finish safely.
- User-owned untracked files remain outside all staging and commits.

## Delivery order

1. Add Bun-adapted transcript, login, agents-view, keybinding, and stop/retry regressions; then port the ergonomic behavior.
2. Add queue state-machine, core mutation, protocol compatibility, and interactive race regressions; then port queue editing and interrupt preservation as schema revision 15.
3. Add worker lifecycle, zombie, PID reuse, timeout, shutdown, and resume-reclaim regressions; then port the three-part recovery chain as schema revision 16.
4. Refresh the Gemini test model and update the flat `[Unreleased]` changelog without analytics text.
5. Run every modified focused test, the full `npm run check`, protocol compatibility tests, and controlled interactive smoke scenarios for expansion, queue interrupt/edit, daemon stop timeout, and resume.

## Non-goals

- Product analytics, telemetry settings, persistent installation IDs, PostHog, or Prime platform ingestion.
- Homebrew installation detection before Prime Bun ships a Homebrew package.
- Python/IPython compatibility layers or restoration of deleted kernel code.
- A daemon protocol-version bump; all wire additions are optional or capability-gated.
- Broad refactoring outside files needed for these ports.
