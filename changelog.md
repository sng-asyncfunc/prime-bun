# Changelog

This repository-level file is the handoff ledger for Prime Bun-specific work and selective synchronization from [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent); package release notes remain in `packages/*/CHANGELOG.md`.

## Upstream synchronization ledger

Last refreshed: 2026-08-17.

- Upstream baseline: Prime Agent [`v0.7.3` / `61131b2d`](https://github.com/PrimeIntellect-ai/prime-agent/commit/61131b2d).
- Last fully dispositioned upstream commit: [`61131b2d`](https://github.com/PrimeIntellect-ai/prime-agent/commit/61131b2d).
- Upstream release observed at: [`v0.7.3`](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.7.3).
- Prime Bun synchronization checkpoint: [`ae317a54`](https://github.com/sng-asyncfunc/prime-bun/commit/ae317a54).
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
| [`795a21de`](https://github.com/PrimeIntellect-ai/prime-agent/commit/795a21de) | Ported | [`4ed9609c`](https://github.com/sng-asyncfunc/prime-bun/commit/4ed9609c) | Kept Down Arrow inside an unfinished prompt until the cursor reaches the actual end. |
| [`47dccfad`](https://github.com/PrimeIntellect-ai/prime-agent/commit/47dccfad) | Ported | [`f4285e9b`](https://github.com/sng-asyncfunc/prime-bun/commit/f4285e9b) | Consolidated dependency updates and adapted biome 2.5.5 formatting while enforcing Prime Bun's seven-day dependency-age policy. |

Prime Bun then added a dogfood-derived clarification in [`5c774e46`](https://github.com/sng-asyncfunc/prime-bun/commit/5c774e46): prepared JavaScript skill globals may be callable functions or method-only objects, and `rlmHeartbeat` must not be called as a wait primitive.

### Prime Agent v0.7.3 disposition

| Prime Agent source | Disposition | Prime Bun trace | Notes |
| --- | --- | --- | --- |
| [`1ae59498`](https://github.com/PrimeIntellect-ai/prime-agent/commit/1ae59498) | Ported | [`750b8f65`](https://github.com/sng-asyncfunc/prime-bun/commit/750b8f65) | Tolerates null assistant content without crashing rendering. |
| [`965941c7`](https://github.com/PrimeIntellect-ai/prime-agent/commit/965941c7), [`0987c1ba`](https://github.com/PrimeIntellect-ai/prime-agent/commit/0987c1ba), [`fd789e21`](https://github.com/PrimeIntellect-ai/prime-agent/commit/fd789e21) | Ported and hardened | [`750b8f65`](https://github.com/sng-asyncfunc/prime-bun/commit/750b8f65) | Opens OSC 8 and bare HTTP links across wrapped and wide text while preserving selection and Ghostty scrolling. |
| [`5e268e28`](https://github.com/PrimeIntellect-ai/prime-agent/commit/5e268e28), [`324298a2`](https://github.com/PrimeIntellect-ai/prime-agent/commit/324298a2) | Ported and adapted | [`7283206e`](https://github.com/sng-asyncfunc/prime-bun/commit/7283206e) | Adds contextual Bun host contracts and reports a supported Codex discovery version without changing the daemon protocol. |
| [`7787f074`](https://github.com/PrimeIntellect-ai/prime-agent/commit/7787f074) | Ported and hardened | [`d2eebe4e`](https://github.com/sng-asyncfunc/prime-bun/commit/d2eebe4e) | Retains exact root-kill cleanup ownership and rejects retries while the worker stop is active. |
| [`f8d73abe`](https://github.com/PrimeIntellect-ai/prime-agent/commit/f8d73abe), [`e64fbcbf`](https://github.com/PrimeIntellect-ai/prime-agent/commit/e64fbcbf), [`875aba96`](https://github.com/PrimeIntellect-ai/prime-agent/commit/875aba96) | Ported and adapted | [`1c30b25e`](https://github.com/sng-asyncfunc/prime-bun/commit/1c30b25e) | Separates tool, agent-message, and edit-diff expansion and replaces upstream Python assumptions with Bun JavaScript cells. |
| [`fa9e4ab1`](https://github.com/PrimeIntellect-ai/prime-agent/commit/fa9e4ab1), [`849c9211`](https://github.com/PrimeIntellect-ai/prime-agent/commit/849c9211), [`35f37ed0`](https://github.com/PrimeIntellect-ai/prime-agent/commit/35f37ed0) | Ported | [`85bb5aab`](https://github.com/sng-asyncfunc/prime-bun/commit/85bb5aab) | Improves agents-view ordering, search guidance, and model/effort context. |
| [`2ea5ae09`](https://github.com/PrimeIntellect-ai/prime-agent/commit/2ea5ae09) | Ported and branded | [`62f1a955`](https://github.com/sng-asyncfunc/prime-bun/commit/62f1a955) | Restores bare `prime-bun --resume` and `/resume [selector]`. |
| [`9bf49d89`](https://github.com/PrimeIntellect-ai/prime-agent/commit/9bf49d89) | Ported | [`ae317a54`](https://github.com/sng-asyncfunc/prime-bun/commit/ae317a54) | Pins third-party workflow actions by immutable digests and disables checkout credential persistence. |
| [`97b994c3`](https://github.com/PrimeIntellect-ai/prime-agent/commit/97b994c3) | Ported | [`61941392`](https://github.com/sng-asyncfunc/prime-bun/commit/61941392) | Adds a bounded supervisor-owned RLM spawn ledger as family authority. |
| [`06e4a19d`](https://github.com/PrimeIntellect-ai/prime-agent/commit/06e4a19d) | Ported and adapted | [`f39b8e61`](https://github.com/sng-asyncfunc/prime-bun/commit/f39b8e61) | Consolidates child topology while retaining Prime Bun's idle catalog restart test. |
| [`26f7f1a1`](https://github.com/PrimeIntellect-ai/prime-agent/commit/26f7f1a1) | Ported | [`e2a8fa8a`](https://github.com/sng-asyncfunc/prime-bun/commit/e2a8fa8a) | Moves supervisor authority out of macOS-cleaned temporary storage with a read-only legacy fallback. |
| [`a9a86550`](https://github.com/PrimeIntellect-ai/prime-agent/commit/a9a86550) | Ported selectively | [`079f4e61`](https://github.com/sng-asyncfunc/prime-bun/commit/079f4e61) | Drops deleted child kernel state and deduplicates artifact paths; its unrelated model-test refresh was excluded. |
| [`114a1d6a`](https://github.com/PrimeIntellect-ai/prime-agent/commit/114a1d6a) | Ported and hardened | [`2b60254c`](https://github.com/sng-asyncfunc/prime-bun/commit/2b60254c) | Resumes interrupted goals after compaction and fixes a Bun action-lifecycle race found by the imported regression. |
| [`8edd21b0`](https://github.com/PrimeIntellect-ai/prime-agent/commit/8edd21b0), [`91977ebf`](https://github.com/PrimeIntellect-ai/prime-agent/commit/91977ebf), [`2c34b82f`](https://github.com/PrimeIntellect-ai/prime-agent/commit/2c34b82f), [`941d7b3e`](https://github.com/PrimeIntellect-ai/prime-agent/commit/941d7b3e) | Deferred | — | Model-catalog and reasoning metadata updates overlap user-owned generator changes; re-evaluate by updating the generator, never the generated file directly. |
| [`ba4c53b3`](https://github.com/PrimeIntellect-ai/prime-agent/commit/ba4c53b3) | Explicitly excluded | — | Promotes trace sharing and is outside Prime Bun's no-telemetry synchronization policy. |
| [`8598deda`](https://github.com/PrimeIntellect-ai/prime-agent/commit/8598deda) | Explicitly excluded | — | Documents the upstream Python runtime and does not apply to the Bun JavaScript notebook. |
| [`a3b3e753`](https://github.com/PrimeIntellect-ai/prime-agent/commit/a3b3e753), [`25769089`](https://github.com/PrimeIntellect-ai/prime-agent/commit/25769089), [`9f950114`](https://github.com/PrimeIntellect-ai/prime-agent/commit/9f950114) | Not ported | — | Upstream issue templates, Bugbot rules, and contribution governance do not improve the Prime Bun runtime. |
| [`61131b2d`](https://github.com/PrimeIntellect-ai/prime-agent/commit/61131b2d) | Informational | — | Upstream release metadata was replaced with Prime Bun-specific versioning and release notes. |

The daemon ports add internal on-disk authority records but no command, event, response, capability, or startup wire change; existing daemons remain readable through the legacy registry fallback, so the daemon protocol version and schema revision remain unchanged.

### Future-agent pickup procedure

1. Fetch without adding or mutating a persistent remote: `git fetch https://github.com/PrimeIntellect-ai/prime-agent.git main`.
2. Inspect new commits after the observed checkpoint: `git log --reverse --oneline 61131b2d..FETCH_HEAD`.
3. Revisit the deferred model-catalog group only after the user-owned generator changes have been reconciled.
4. Classify every upstream commit as ported, adapted, excluded, informational, or deferred; add both upstream and Prime Bun commit links here.
5. Do not blindly cherry-pick daemon, dependency, release, Homebrew, or telemetry changes; preserve Prime Bun protocol capability gates, Bun runtime behavior, and dependency-age rules.
6. After code ports, run `npm run check`, focused tests for every changed behavior, live DeepSeek Flash/Pro dogfood, and a Fable5 go/no-go gate when the change is cross-cutting.

### Verification for the 2026-08-11 synchronization

- `npm run check` passed on merged `main`.
- Focused verification passed 485 coding-agent tests, 8 TUI keybinding tests, 3 heartbeat bridge tests, and 8 supervisor-process tests with 6 intentional skips.
- DeepSeek V4 Flash and Pro each completed 17 JavaScript results with zero JavaScript errors; settled aggregate source-mode RSS was 244 MB and 236 MB respectively.
- Fable5 returned `SATISFIED_PROCEED`, and local `main`, `origin/main`, and the remote ref were synchronized at `5c774e46`.

### Verification for the 2026-08-12 synchronization

- Ported `795a21de` (Down Arrow) and `47dccfad` (dependency consolidation), then bumped Prime Bun and all package changelogs to `0.7.2`.
- `npm run check` passed on merged `main` (biome 2.5.5, tsgo, installer render, and browser smoke).
- Focused editor verification passed 16 custom-editor tests and 186 TUI editor tests.
- The daemon supervisor process suite was not run to completion in this session because the agent runtime runs as a daemon worker and leaks `PRIME_AGENT_INTERNAL_DAEMON_WORKER=1` into spawned test supervisors; a scrubbed-environment handshake confirmed the supervisor reports `appVersion 0.7.2` and protocol v8.

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
