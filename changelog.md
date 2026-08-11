# Changelog

This repository-level file is the handoff ledger for Prime Bun-specific work and selective synchronization from [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent); package release notes remain in `packages/*/CHANGELOG.md`.

## Upstream synchronization ledger

Last refreshed: 2026-08-11.

- Upstream baseline: Prime Agent [`v0.7.1` / `95afd319`](https://github.com/PrimeIntellect-ai/prime-agent/commit/95afd319).
- Last fully dispositioned upstream commit: [`14d6e749`](https://github.com/PrimeIntellect-ai/prime-agent/commit/14d6e749).
- Upstream `main` observed at: [`1ae59498`](https://github.com/PrimeIntellect-ai/prime-agent/commit/1ae59498).
- Prime Bun synchronization checkpoint: [`5c774e46`](https://github.com/sng-asyncfunc/prime-bun/commit/5c774e46).
- Policy: port behavior selectively, adapt it to the Bun architecture, and never inherit Prime Agent telemetry, analytics, release metadata, or distribution-specific code without an explicit decision.

### Dispositioned Prime Agent commits after v0.7.1

| Prime Agent source | Disposition | Prime Bun trace | Notes |
| --- | --- | --- | --- |
| [`10fb172b`](https://github.com/PrimeIntellect-ai/prime-agent/commit/10fb172b) | Not ported | — | Homebrew ownership handling is specific to the upstream distribution path. |
| [`b817a089`](https://github.com/PrimeIntellect-ai/prime-agent/commit/b817a089) | Ported | [`4ed80b42`](https://github.com/sng-asyncfunc/prime-bun/commit/4ed80b42) | Expanded sent agent messages now show only their message text. |
| [`a18809e0`](https://github.com/PrimeIntellect-ai/prime-agent/commit/a18809e0) | Explicitly excluded | — | Privacy-safe upstream analytics are still telemetry and are outside Prime Bun policy. |
| [`c131d94c`](https://github.com/PrimeIntellect-ai/prime-agent/commit/c131d94c) | Ported and hardened | [`eb28f451`](https://github.com/sng-asyncfunc/prime-bun/commit/eb28f451) | Refreshed stale Gemini test models and added a guard against accidental real test authentication. |
| [`ebfe770e`](https://github.com/PrimeIntellect-ai/prime-agent/commit/ebfe770e) | Ported | [`186e76f8`](https://github.com/sng-asyncfunc/prime-bun/commit/186e76f8) | Added the login URL copy action alongside the agents-view work. |
| [`d698b4b7`](https://github.com/PrimeIntellect-ai/prime-agent/commit/d698b4b7) | Ported | [`186e76f8`](https://github.com/sng-asyncfunc/prime-bun/commit/186e76f8) | Preserved agents-view expansion and selection state across navigation. |
| [`d1b07268`](https://github.com/PrimeIntellect-ai/prime-agent/commit/d1b07268) | Ported and adapted | [`ffc64c70`](https://github.com/sng-asyncfunc/prime-bun/commit/ffc64c70) | Split tool, thinking, and agent-message expansion controls while retaining configurable keybindings. |
| [`71ca6cfd`](https://github.com/PrimeIntellect-ai/prime-agent/commit/71ca6cfd) | Ported in two stages | [`f98b8a6e`](https://github.com/sng-asyncfunc/prime-bun/commit/f98b8a6e), [`85b22c95`](https://github.com/sng-asyncfunc/prime-bun/commit/85b22c95) | Added compare-and-swap queue mutations, in-place editing, deletion, reordering, and interrupt-safe queue preservation. |
| [`2857e234`](https://github.com/PrimeIntellect-ai/prime-agent/commit/2857e234) | Ported and hardened | [`9e42d8cf`](https://github.com/sng-asyncfunc/prime-bun/commit/9e42d8cf) | Reports truthful worker lifecycle state and hides stopping workers from active routing. |
| [`e9ef5777`](https://github.com/PrimeIntellect-ai/prime-agent/commit/e9ef5777) | Ported and hardened | [`9e42d8cf`](https://github.com/sng-asyncfunc/prime-bun/commit/9e42d8cf) | Finalizes timed-out worker stops without risking signals to recycled PIDs. |
| [`14d6e749`](https://github.com/PrimeIntellect-ai/prime-agent/commit/14d6e749) | Ported and hardened | [`9e42d8cf`](https://github.com/sng-asyncfunc/prime-bun/commit/9e42d8cf) | Reclaims stale worker registrations during resume with conservative process-identity checks. |

Prime Bun then added a dogfood-derived clarification in [`5c774e46`](https://github.com/sng-asyncfunc/prime-bun/commit/5c774e46): prepared JavaScript skill globals may be callable functions or method-only objects, and `rlmHeartbeat` must not be called as a wait primitive.

### Known upstream commits after the completed audit

These commits were present at the last refresh but are not yet included in the fully dispositioned checkpoint:

| Prime Agent source | Next action | Reason |
| --- | --- | --- |
| [`795a21de`](https://github.com/PrimeIntellect-ai/prime-agent/commit/795a21de) | Review next | Keeps Down Arrow inside an unfinished prompt until the cursor reaches the actual end; likely a useful Prime Bun UX fix. |
| [`47dccfad`](https://github.com/PrimeIntellect-ai/prime-agent/commit/47dccfad) | Review separately | Consolidates dependencies and related source adjustments; never cherry-pick wholesale, and enforce Prime Bun's seven-day dependency-age policy. |
| [`83a0f9f9`](https://github.com/PrimeIntellect-ai/prime-agent/commit/83a0f9f9) | Informational only | Upstream v0.7.2 release metadata summarizes the ported work but Prime Bun versions and changelogs are independent. |
| [`1ae59498`](https://github.com/PrimeIntellect-ai/prime-agent/commit/1ae59498) | Review next | Prevents malformed provider responses containing null assistant content blocks from crashing TUI rendering. |

### Future-agent pickup procedure

1. Fetch without adding or mutating a persistent remote: `git fetch https://github.com/PrimeIntellect-ai/prime-agent.git main`.
2. Inspect new commits after the observed checkpoint: `git log --reverse --oneline 1ae59498..FETCH_HEAD`.
3. Resolve the four known commits above before advancing the “last fully dispositioned” checkpoint.
4. Classify every upstream commit as ported, adapted, excluded, informational, or deferred; add both upstream and Prime Bun commit links here.
5. Do not blindly cherry-pick daemon, dependency, release, Homebrew, or telemetry changes; preserve Prime Bun protocol capability gates, Bun runtime behavior, and dependency-age rules.
6. After code ports, run `npm run check`, focused tests for every changed behavior, live DeepSeek Flash/Pro dogfood, and a Fable5 go/no-go gate when the change is cross-cutting.

### Verification for the 2026-08-11 synchronization

- `npm run check` passed on merged `main`.
- Focused verification passed 485 coding-agent tests, 8 TUI keybinding tests, 3 heartbeat bridge tests, and 8 supervisor-process tests with 6 intentional skips.
- DeepSeek V4 Flash and Pro each completed 17 JavaScript results with zero JavaScript errors; settled aggregate source-mode RSS was 244 MB and 236 MB respectively.
- Fable5 returned `SATISFIED_PROCEED`, and local `main`, `origin/main`, and the remote ref were synchronized at `5c774e46`.

## 2026-08-08 to 2026-08-09

### Added

- Added a structured Bun action engine for batched read, search, shell, and write operations, with compact results rendered in interactive and print modes.
- Added safer structured-action handling for multiline Markdown, fenced code, independent writes, empty listings, and common tool-name aliases.
- Added Bun runtime safeguards for bounded checkpoint memory, failed-cell preservation, unsafe snapshot-cycle detection, and cached snapshot validation.

### Improved

- Improved long-running Bun sessions with worker-heap compaction, on-demand state reconciliation, released checkpoint buffers, reduced transcript duplication, bounded output, and lower idle memory usage.
- Improved notebook audits with compact search summaries, expected no-match handling, redundant import tolerance, reliable Bun Shell `.text()` results, and bounded inspection guidance.
- Improved TUI responsiveness during long streams by prioritizing focused frames, limiting unnecessary repaints, and reusing cached viewport content.
- Improved daemon and session reliability with idle catalog restart, more robust subprocess launching, compatibility aliases, and resilient catalog processing.
- Changed JSON print-mode assistant updates to emit linear deltas instead of repeating the accumulated message.

### Documentation

- Documented the compact Bun runtime, structured actions, full-model dogfood fixes, and related performance and stability work.
