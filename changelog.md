# Changelog

This repository-level file is the handoff ledger for Prime Bun-specific work and selective synchronization from [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent); package release notes remain in `packages/*/CHANGELOG.md`.

## Active design decisions

- Retain the existing monochrome Prime butterfly terminal splash in `packages/coding-agent/src/themes/prime-logo.ts`; a muscular Prime Bun mascot replacement was explored on 2026-08-18 and explicitly declined, so do not revisit it unless the user asks.
- Require Bun 1.4.0 or newer for the JavaScript kernel; keep `.bun-version`, runtime validation, current docs, and kernel CI on the same floor.

## Bun runtime ledger

### Bun v1.4.0 upgrade — 2026-08-22

- Upgraded the local runtime from Bun `1.3.14+0d9b296af` to `1.4.0+34cbb9a40`, moved the installer to the official `bun.com` endpoint, and pinned coding-agent and nightly process-stress CI to Bun 1.4.0.
- Added `packages/coding-agent/test/bun-runtime-version-bench.ts` so future runtime upgrades can repeat the production-protocol startup, cell, output, shell, checkpoint, abort/recovery, long-session, and RSS probes.
- Compared three matched runs per version on the same machine. Each run used 12 startup samples, 40 ordinary-operation samples, six checkpoint and recovery samples, and 2,000 long-session scalar cells; the table reports the median result across those runs.

| Prime Bun operation | Bun 1.3.14 | Bun 1.4.0 | Change |
| --- | ---: | ---: | ---: |
| Cold kernel startup | 46.68 ms | 43.10 ms | 7.7% faster |
| Scalar cell | 0.837 ms | 0.771 ms | 7.9% faster |
| 64 KiB output | 1.068 ms | 0.976 ms | 8.7% faster |
| 10,000 one-byte writes | 1.352 ms | 1.149 ms | 15.0% faster |
| Native Bun Shell | 3.169 ms | 3.328 ms | 5.0% slower |
| 32 MiB checkpoint | 10.279 ms | 10.302 ms | effectively flat |
| Abort synchronous loop | 113.82 ms | 113.33 ms | 0.4% faster |
| First cell after recovery | 3.105 ms | 2.820 ms | 9.2% faster |
| 2,000 scalar cells | 1,509.2 ms | 1,468.9 ms | 2.7% faster |
| Worker RSS before long loop | 40.98 MiB | 34.55 MiB | 15.7% lower |
| Worker RSS after long loop | 61.98 MiB | 55.52 MiB | 10.4% lower |
| RSS growth across long loop | 21.09 MiB | 21.67 MiB | effectively flat |
| Worker RSS with 32 MiB state | 165.20 MiB | 160.17 MiB | 3.0% lower |

The upgrade lowers steady-state memory and improves most kernel paths, but it does not materially change the long-session RSS growth slope. Native-shell and checkpoint distributions overlap the prior runtime and should be watched rather than described as wins.

### Prime Agent v0.8.0 comparison — 2026-08-22

- Compared Prime Bun v0.7.4 on Bun 1.4.0 with the official Prime Agent v0.8.0 release on Python 3.11.15 using matched end-to-end host/kernel operations on the same Apple M1 Pro.
- Ran three rounds per implementation, with 12 cold startups, 40 ordinary-operation samples, six abort/recovery and explicit snapshot samples, and a 2,000-cell steady-state loop in each round; the README reports the median result across rounds.
- Confirmed Prime Bun was faster on seven of nine paths, including 83.6% faster startup, 92.0% faster repeated writes, 23.6% faster 32 MiB snapshots, and 71.2% faster steady-state cells.
- Recorded the two regressions honestly: Prime Bun was 48.2% slower to interrupt a synchronous loop and 5.3% slower on the first recovery cell.
- Treated Prime Agent v0.8.0 only as the benchmark target; the selective upstream synchronization checkpoint remains v0.7.4 until its commits are separately reviewed and dispositioned.

## Upstream synchronization ledger

Last refreshed: 2026-09-07.

- Upstream baseline: Prime Agent [`v0.9.3` / `915c78f4`](https://github.com/PrimeIntellect-ai/prime-agent/commit/915c78f4).
- Last fully dispositioned upstream commit: [`915c78f4`](https://github.com/PrimeIntellect-ai/prime-agent/commit/915c78f4).
- Upstream release observed at: [`v0.9.3`](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.9.3).
- Prime Bun synchronization checkpoint: [`v0.9.3` / `bde357e4`](https://github.com/sng-asyncfunc/prime-bun/commit/bde357e4).
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

### Prime Agent v0.7.4 disposition

| Prime Agent source | Disposition | Prime Bun trace | Notes |
| --- | --- | --- | --- |
| [`e85a67ac`](https://github.com/PrimeIntellect-ai/prime-agent/commit/e85a67ac) | Ported and hardened | [`183547d5`](https://github.com/sng-asyncfunc/prime-bun/commit/183547d5) | Removes inherited RLM depth from new top-level resident workers. |
| [`7ca44937`](https://github.com/PrimeIntellect-ai/prime-agent/commit/7ca44937) | Ported and adapted | [`183547d5`](https://github.com/sng-asyncfunc/prime-bun/commit/183547d5) | Adds Bun-native nonblocking work, bounded-wait, parallel-worker, progress, and concise-prose guidance. |
| [`20b54977`](https://github.com/PrimeIntellect-ai/prime-agent/commit/20b54977) | Already superseded | [`2b60254c`](https://github.com/sng-asyncfunc/prime-bun/commit/2b60254c) | Keeps Prime Bun's more precise durable action-lifecycle continuation instead of replacing it with the upstream condition. |
| [`032e3ee7`](https://github.com/PrimeIntellect-ai/prime-agent/commit/032e3ee7) | Not ported | — | Broad cleanup churn has no user-visible parity value and overlaps Prime Bun runtime code. |
| [`aa0bdfa6`](https://github.com/PrimeIntellect-ai/prime-agent/commit/aa0bdfa6) | Not applicable | — | Prime Bun has none of the removed IPython asynchronous-bash guidance. |
| [`8ee310c5`](https://github.com/PrimeIntellect-ai/prime-agent/commit/8ee310c5) | Ported | [`183547d5`](https://github.com/sng-asyncfunc/prime-bun/commit/183547d5) | Raw newlines reach the editor while configurable encoded Ctrl+J still expands edit diffs. |
| [`d51590c4`](https://github.com/PrimeIntellect-ai/prime-agent/commit/d51590c4) | Ported and adapted | [`183547d5`](https://github.com/sng-asyncfunc/prime-bun/commit/183547d5) | Rich drafts survive full and scoped agents-view handoff and restore to the originating session. |
| [`824a9ee3`](https://github.com/PrimeIntellect-ai/prime-agent/commit/824a9ee3) | Ported and adapted | [`183547d5`](https://github.com/sng-asyncfunc/prime-bun/commit/183547d5) | Bun RLM children accept a validated model-supported `thinking` override. |
| [`8189b12d`](https://github.com/PrimeIntellect-ai/prime-agent/commit/8189b12d) | Ported and hardened | [`183547d5`](https://github.com/sng-asyncfunc/prime-bun/commit/183547d5) | Normalizes socket identity across CLI, daemon, supervisor, logs, ownership, and update restart while reading equivalent legacy spellings. |
| [`e7b8cae9`](https://github.com/PrimeIntellect-ai/prime-agent/commit/e7b8cae9) | Explicitly excluded | — | Linear workflow policy is upstream organization governance. |
| [`1663d443`](https://github.com/PrimeIntellect-ai/prime-agent/commit/1663d443) | Explicitly excluded | — | IPython snapshot work does not apply to the Bun notebook. |
| [`f8f0036c`](https://github.com/PrimeIntellect-ai/prime-agent/commit/f8f0036c) | Not ported | — | The Trendshift badge is repository promotion, not runtime parity. |
| [`b09fbdb4`](https://github.com/PrimeIntellect-ai/prime-agent/commit/b09fbdb4) | Ported | [`183547d5`](https://github.com/sng-asyncfunc/prime-bun/commit/183547d5) | Model search ranks exact intent before prefix, token, and fuzzy matches with deterministic tie-breakers. |
| [`af0b8e00`](https://github.com/PrimeIntellect-ai/prime-agent/commit/af0b8e00) | Recreated locally | [`f0b43bb5`](https://github.com/sng-asyncfunc/prime-bun/commit/f0b43bb5) | Releases Prime Bun-specific 0.7.4 metadata without copying upstream branding or distribution code. |

Release dogfood added three Prime Bun-specific hardenings in [`f0b43bb5`](https://github.com/sng-asyncfunc/prime-bun/commit/f0b43bb5): common runtime-global declarations remain cell-local, expanded and collapsed JavaScript results use separate bounded caches, and identical unchanged successful tool-call loops stop after four executions with balanced result messages.

The daemon ports add internal on-disk authority records but no command, event, response, capability, or startup wire change; existing daemons remain readable through the legacy registry fallback, so the daemon protocol version and schema revision remain unchanged.

### Prime Agent v0.8.0 disposition

| Prime Agent source | Disposition | Notes |
| --- | --- | --- |
| [`d98d0762`](https://github.com/PrimeIntellect-ai/prime-agent/commit/d98d0762), [`02e217e6`](https://github.com/PrimeIntellect-ai/prime-agent/commit/02e217e6) | Explicitly excluded | The ACP resident-lifecycle and prompt-admission protocol rewrite conflicts with Prime Bun's durable Bun action scheduler and requires a separate capability-gated design. |
| [`91b5c619`](https://github.com/PrimeIntellect-ai/prime-agent/commit/91b5c619) | Ported | Treats a configured environment-variable name with an empty value as a missing credential instead of the literal variable name. |
| [`f8f02221`](https://github.com/PrimeIntellect-ai/prime-agent/commit/f8f02221), [`c75a637b`](https://github.com/PrimeIntellect-ai/prime-agent/commit/c75a637b) | Not applicable | The generic MCP and ACP MCP implementations are coupled to the upstream Python/IPython runtime; Prime Bun keeps authored JavaScript MCP skills. |
| [`ab3db326`](https://github.com/PrimeIntellect-ai/prime-agent/commit/ab3db326) | Ported and adapted | Headless waiters now observe a scheduled post-compaction continuation start failure exactly once. |
| [`55277ff3`](https://github.com/PrimeIntellect-ai/prime-agent/commit/55277ff3) | Not applicable | Cold IPython, virtual-environment, and ZMQ startup changes do not apply to the Bun worker. |
| [`bb61ca21`](https://github.com/PrimeIntellect-ai/prime-agent/commit/bb61ca21), [`8c749fb9`](https://github.com/PrimeIntellect-ai/prime-agent/commit/8c749fb9) | Ported and adapted | Adds endpoint-bound MCP credentials, disk-verified removal, strict HTTPS metadata validation, and RFC 9728 protected-resource discovery without Python shutdown code or generated models. |
| [`b5807b6f`](https://github.com/PrimeIntellect-ai/prime-agent/commit/b5807b6f) | Explicitly excluded | Upstream changelog fragments and release governance are not used by Prime Bun. |
| [`a3af021c`](https://github.com/PrimeIntellect-ai/prime-agent/commit/a3af021c) | Ported | Dims the queue-browse instruction row without changing configurable keybindings. |
| [`addfc23f`](https://github.com/PrimeIntellect-ai/prime-agent/commit/addfc23f) | Already superseded | Prime Bun uses owner-scoped process cleanup, orphan journaling, recovery checkpoints, and PID-identity safeguards rather than an IPython forkserver watchdog. |
| [`bb3ac37f`](https://github.com/PrimeIntellect-ai/prime-agent/commit/bb3ac37f) | Ported | Renders width-safe running, idle, and inactive subagent counts in a bordered agents tile. |
| [`848081ed`](https://github.com/PrimeIntellect-ai/prime-agent/commit/848081ed) | Ported | Enables `/fast` for supported OpenAI API-key GPT-5.4, GPT-5.5, and GPT-5.6 models with corrected priority pricing. |
| [`e51d2266`](https://github.com/PrimeIntellect-ai/prime-agent/commit/e51d2266) | Ported and adapted | Defers goal continuation until Bun descendants settle, then resumes once behind their terminal notice. |
| [`35103cb4`](https://github.com/PrimeIntellect-ai/prime-agent/commit/35103cb4) | Ported | Replaces continuation error-message matching with stable error codes. |
| [`48b6478e`](https://github.com/PrimeIntellect-ai/prime-agent/commit/48b6478e), [`108eff32`](https://github.com/PrimeIntellect-ai/prime-agent/commit/108eff32), [`274cbb84`](https://github.com/PrimeIntellect-ai/prime-agent/commit/274cbb84), [`34b294f8`](https://github.com/PrimeIntellect-ai/prime-agent/commit/34b294f8) | Deferred | Working-timer continuity, refinement hooks/outcomes, and failed-worker heartbeat filtering cross Prime Bun's diverged interactive, refinement, and supervisor lifecycles; each needs a focused compatibility and dogfood pass. |
| [`a3d86fbe`](https://github.com/PrimeIntellect-ai/prime-agent/commit/a3d86fbe) | Already superseded | Prime Bun already refreshes dynamic OAuth providers and JavaScript MCP skill gating after auth and resource reloads. |
| [`8d7deeab`](https://github.com/PrimeIntellect-ai/prime-agent/commit/8d7deeab) | Recreated locally | Updates Prime Bun's lockstep metadata to 0.8.0 without upstream publication, tags, distribution code, or generated catalog changes. |

No Python/IPython runtime, telemetry, analytics, trace sharing, Linear governance, daemon wire schema, or generated model catalog change was included in the v0.8.0 synchronization.

Prime Bun delivery [`4489e1e3`](https://github.com/sng-asyncfunc/prime-bun/commit/4489e1e3) contains the selected v0.8.0 ports plus the Grok-discovered compatibility fix for providers that populate an empty `code` field beside structured JavaScript actions.

### Prime Agent v0.8.1 disposition

| Prime Agent source | Disposition | Prime Bun trace | Notes |
| --- | --- | --- | --- |
| [`e319a66d`](https://github.com/PrimeIntellect-ai/prime-agent/commit/e319a66d) | Deferred | — | The generated model snapshot overlaps user-owned generator work and remains excluded from direct edits. |
| [`a44b07ee`](https://github.com/PrimeIntellect-ai/prime-agent/commit/a44b07ee) | Not applicable | — | Multiline Python and IPython syntax highlighting does not apply to the Bun notebook. |
| [`9e49b73d`](https://github.com/PrimeIntellect-ai/prime-agent/commit/9e49b73d) | Ported | [`ceb13a2d`](https://github.com/sng-asyncfunc/prime-bun/commit/ceb13a2d) | New sessions default to RLM depth 2 while saved and environment overrides remain authoritative. |
| [`a9b5d88b`](https://github.com/PrimeIntellect-ai/prime-agent/commit/a9b5d88b) | Ported selectively | [`ceb13a2d`](https://github.com/sng-asyncfunc/prime-bun/commit/ceb13a2d) | Preserves OpenAI-compatible reasoning lineage; ACP terminal quiescence remains excluded because it depends on the upstream resident-lifecycle rewrite that Prime Bun did not adopt. |
| [`06860844`](https://github.com/PrimeIntellect-ai/prime-agent/commit/06860844) | Explicitly excluded | — | Upstream citation copy, badges, and subtitle branding are promotional repository changes. |
| [`9bc00557`](https://github.com/PrimeIntellect-ai/prime-agent/commit/9bc00557) | Adapted selectively | [`ceb13a2d`](https://github.com/sng-asyncfunc/prime-bun/commit/ceb13a2d) | Rescopes Cloudflare AI Gateway docs and its default to the current `claude-sonnet-4-5` catalog ID; generated catalogs and generator metadata pins remain excluded. |
| [`b5ee2f81`](https://github.com/PrimeIntellect-ai/prime-agent/commit/b5ee2f81) | Ported and branded | [`ceb13a2d`](https://github.com/sng-asyncfunc/prime-bun/commit/ceb13a2d) | ACP thinking and visible chunks now share stable per-message `prime-bun-assistant-*` boundaries. |
| [`51463372`](https://github.com/PrimeIntellect-ai/prime-agent/commit/51463372) | Recreated locally | [`ceb13a2d`](https://github.com/sng-asyncfunc/prime-bun/commit/ceb13a2d) | Updates Prime Bun's lockstep metadata to 0.8.1 without upstream publication, tags, distribution code, fragments, or generated models. |

No Python/IPython runtime, telemetry, analytics, trace sharing, promotional badges, daemon wire schema, upstream distribution machinery, or generated model catalog change was included in the v0.8.1 synchronization.

### Prime Agent v0.9.0 and v0.9.1 disposition

| Prime Agent source | Disposition | Prime Bun trace | Notes |
| --- | --- | --- | --- |
| [`0940833b`](https://github.com/PrimeIntellect-ai/prime-agent/commit/0940833b), [`61eb6474`](https://github.com/PrimeIntellect-ai/prime-agent/commit/61eb6474), [`80902713`](https://github.com/PrimeIntellect-ai/prime-agent/commit/80902713), [`d60fab8a`](https://github.com/PrimeIntellect-ai/prime-agent/commit/d60fab8a) | Not applicable | — | Async Python bash, CPython REPL, and Python kernel protocol work do not apply to the Bun JavaScript runtime. |
| [`bc0fa760`](https://github.com/PrimeIntellect-ai/prime-agent/commit/bc0fa760) | Already superseded | — | Prime Bun already covers delivery between root siblings in its supervisor process suite. |
| [`0fa717d4`](https://github.com/PrimeIntellect-ai/prime-agent/commit/0fa717d4) | Excluded | — | The generated model snapshot remains excluded from direct edits and overlaps local generator work. |
| [`90343dca`](https://github.com/PrimeIntellect-ai/prime-agent/commit/90343dca) | Ported | [`2210e27b`](https://github.com/sng-asyncfunc/prime-bun/commit/2210e27b) | Worker mode now trusts supervisor-approved renames without rechecking the worker-local sibling set. |
| [`8c4ab8f5`](https://github.com/PrimeIntellect-ai/prime-agent/commit/8c4ab8f5), [`378e32d5`](https://github.com/PrimeIntellect-ai/prime-agent/commit/378e32d5), [`05601462`](https://github.com/PrimeIntellect-ai/prime-agent/commit/05601462), [`18fe5d5b`](https://github.com/PrimeIntellect-ai/prime-agent/commit/18fe5d5b), [`8ca52555`](https://github.com/PrimeIntellect-ai/prime-agent/commit/8ca52555), [`bcf69db5`](https://github.com/PrimeIntellect-ai/prime-agent/commit/bcf69db5) | Excluded | — | Test-seam and unused-export cleanup has no user-visible parity value and would add broad churn. |
| [`0f6a3885`](https://github.com/PrimeIntellect-ai/prime-agent/commit/0f6a3885), [`d90062b6`](https://github.com/PrimeIntellect-ai/prime-agent/commit/d90062b6), [`bab12421`](https://github.com/PrimeIntellect-ai/prime-agent/commit/bab12421), [`85c236d5`](https://github.com/PrimeIntellect-ai/prime-agent/commit/85c236d5) | Excluded | — | These interactive-state refactors do not fix a demonstrated Prime Bun behavior and cross its diverged TUI lifecycle. |
| [`5e0e288a`](https://github.com/PrimeIntellect-ai/prime-agent/commit/5e0e288a) | Not applicable | — | The removed upstream kernel seams are absent from the Bun worker. |
| [`ceb41804`](https://github.com/PrimeIntellect-ai/prime-agent/commit/ceb41804), [`c0334a17`](https://github.com/PrimeIntellect-ai/prime-agent/commit/c0334a17), [`dfffea27`](https://github.com/PrimeIntellect-ai/prime-agent/commit/dfffea27) | Excluded | — | The agent-admission and RLM projection refactors are coupled to upstream lifecycle architecture; Prime Bun retains its tested Bun projections. |
| [`af14f066`](https://github.com/PrimeIntellect-ai/prime-agent/commit/af14f066) | Not applicable | — | The host-reply envelope fixes a Python kernel dispatcher path not used by Prime Bun. |
| [`80bf72c8`](https://github.com/PrimeIntellect-ai/prime-agent/commit/80bf72c8) | Ported | [`2210e27b`](https://github.com/sng-asyncfunc/prime-bun/commit/2210e27b) | A remote agent message is sent once after transport connection, so reconnect errors cannot duplicate a delivered prompt. |
| [`ee8fd699`](https://github.com/PrimeIntellect-ai/prime-agent/commit/ee8fd699) | Adapted | [`2210e27b`](https://github.com/sng-asyncfunc/prime-bun/commit/2210e27b) | Session reuse now waits for recovery and validates current ownership, root presence, and readiness. |
| [`9db2722e`](https://github.com/PrimeIntellect-ai/prime-agent/commit/9db2722e) | Excluded | — | Telemetry implementation changes remain outside Prime Bun policy. |
| [`dab03c00`](https://github.com/PrimeIntellect-ai/prime-agent/commit/dab03c00) | Excluded | — | The quiescence rewrite depends on upstream post-compaction scheduling and needs a dedicated Bun compatibility cycle. |
| [`853041ec`](https://github.com/PrimeIntellect-ai/prime-agent/commit/853041ec) | Adapted | [`2210e27b`](https://github.com/sng-asyncfunc/prime-bun/commit/2210e27b) | Every concurrent Bash call owns an abort controller, and one abort reaches all in-flight calls. |
| [`6322b7bb`](https://github.com/PrimeIntellect-ai/prime-agent/commit/6322b7bb) | Ported | [`2210e27b`](https://github.com/sng-asyncfunc/prime-bun/commit/2210e27b) | Daemon close awaits the tracked Bash completion chain instead of polling session state. |
| [`5b6c0e94`](https://github.com/PrimeIntellect-ai/prime-agent/commit/5b6c0e94) | Adapted | [`2210e27b`](https://github.com/sng-asyncfunc/prime-bun/commit/2210e27b) | Concurrent opens join only after owner validation and cannot reuse a still-starting worker. |
| [`a903d4b6`](https://github.com/PrimeIntellect-ai/prime-agent/commit/a903d4b6) | Excluded | — | Contributor-vouch governance is upstream repository administration. |
| [`c382f098`](https://github.com/PrimeIntellect-ai/prime-agent/commit/c382f098) | Excluded | — | Inline Mermaid adds rendering dependencies and memory surface without addressing a Prime Bun reliability need. |
| [`c718bf3c`](https://github.com/PrimeIntellect-ai/prime-agent/commit/c718bf3c), [`1b5830f0`](https://github.com/PrimeIntellect-ai/prime-agent/commit/1b5830f0), [`71c01082`](https://github.com/PrimeIntellect-ai/prime-agent/commit/71c01082), [`85ac06e9`](https://github.com/PrimeIntellect-ai/prime-agent/commit/85ac06e9) | Not applicable | — | Python bash guidance, Python snapshot optimization, and Python-cell presentation do not apply to Bun JavaScript cells. |
| [`cbc0f7d7`](https://github.com/PrimeIntellect-ai/prime-agent/commit/cbc0f7d7) | Ported | [`2210e27b`](https://github.com/sng-asyncfunc/prime-bun/commit/2210e27b) | Empty unnamed sessions report idle and are passivated after their last client detaches. |
| [`9f5edc19`](https://github.com/PrimeIntellect-ai/prime-agent/commit/9f5edc19), [`74c8d39e`](https://github.com/PrimeIntellect-ai/prime-agent/commit/74c8d39e) | Excluded | — | The spawn-error and startup-ownership patches depend on the newer upstream supervisor transport and require a separate daemon migration. |
| [`9f712708`](https://github.com/PrimeIntellect-ai/prime-agent/commit/9f712708) | Ported | [`2210e27b`](https://github.com/sng-asyncfunc/prime-bun/commit/2210e27b) | Anthropic-compatible prompt caching now advances its rolling cache marker across tool results. |
| [`4e42fab2`](https://github.com/PrimeIntellect-ai/prime-agent/commit/4e42fab2), [`8d5722ee`](https://github.com/PrimeIntellect-ai/prime-agent/commit/8d5722ee), [`1d2e91d3`](https://github.com/PrimeIntellect-ai/prime-agent/commit/1d2e91d3), [`173d845a`](https://github.com/PrimeIntellect-ai/prime-agent/commit/173d845a), [`0749e066`](https://github.com/PrimeIntellect-ai/prime-agent/commit/0749e066) | Excluded | — | The status, roster subscription, and direct-session transport stack is a coupled daemon protocol change and cannot be imported without negotiated capability gates. |
| [`15ef4566`](https://github.com/PrimeIntellect-ai/prime-agent/commit/15ef4566), [`23e55152`](https://github.com/PrimeIntellect-ai/prime-agent/commit/23e55152), [`c32f2725`](https://github.com/PrimeIntellect-ai/prime-agent/commit/c32f2725) | Not applicable | — | These repair the excluded reconnect-loop, direct-viewer, and roster-backed catalog paths. |
| [`6179a608`](https://github.com/PrimeIntellect-ai/prime-agent/commit/6179a608) | Adapted | [`2210e27b`](https://github.com/sng-asyncfunc/prime-bun/commit/2210e27b) | Identical RLM child snapshots are suppressed before they reach transcript and UI subscribers. |
| [`083c68dc`](https://github.com/PrimeIntellect-ai/prime-agent/commit/083c68dc) | Excluded | — | The Node TUI process-replacement path is distribution-specific and overlaps Prime Bun's source launcher recovery. |
| [`3d639f7b`](https://github.com/PrimeIntellect-ai/prime-agent/commit/3d639f7b), [`48c69d41`](https://github.com/PrimeIntellect-ai/prime-agent/commit/48c69d41) | Already superseded | — | The prompt change and immediate revert are net-zero. |
| [`3da8c5a1`](https://github.com/PrimeIntellect-ai/prime-agent/commit/3da8c5a1) | Excluded | — | Trace-upload and doomed Python snapshot handling mixes proprietary trace sharing with Python runtime behavior. |
| [`c394506e`](https://github.com/PrimeIntellect-ai/prime-agent/commit/c394506e), [`81ae3cb3`](https://github.com/PrimeIntellect-ai/prime-agent/commit/81ae3cb3) | Adapted | [`2210e27b`](https://github.com/sng-asyncfunc/prime-bun/commit/2210e27b) | Recreated Prime Bun lockstep 0.9.1 metadata without upstream publication, tags, distribution code, or changelog fragments. |

No Python/IPython runtime, telemetry, analytics, trace sharing, roster/direct-transport wire change, upstream distribution machinery, or generated model catalog change was included in the v0.9.1 synchronization. The selected daemon fixes are internal behavior changes behind existing commands and event shapes, so the daemon protocol version and schema revision remain unchanged.

### Prime Agent v0.9.2 disposition

| Prime Agent source | Disposition | Prime Bun trace | Notes |
| --- | --- | --- | --- |
| [`e72da005`](https://github.com/PrimeIntellect-ai/prime-agent/commit/e72da005) | Not ported | — | Upstream issue-form requirements are repository administration, not a Prime Bun runtime improvement. |
| [`408e7490`](https://github.com/PrimeIntellect-ai/prime-agent/commit/408e7490) | Explicitly excluded | — | Linear ticket defaults are upstream internal governance. |
| [`0ba0423c`](https://github.com/PrimeIntellect-ai/prime-agent/commit/0ba0423c) | Ported and hardened | [`cc08eb4a`](https://github.com/sng-asyncfunc/prime-bun/commit/cc08eb4a) | Pins portable process-start queries to UTC and the C locale while matching pre-0.9.2 local-time identities during rolling upgrades. |
| [`3f02aa5d`](https://github.com/PrimeIntellect-ai/prime-agent/commit/3f02aa5d) | Ported | [`cc08eb4a`](https://github.com/sng-asyncfunc/prime-bun/commit/cc08eb4a) | Advertises Claude Code 2.1.257 for OAuth-backed Fable 5.x compatibility. |
| [`cd10724f`](https://github.com/PrimeIntellect-ai/prime-agent/commit/cd10724f) | Explicitly excluded | — | npm 12 remote-policy handling changes the upstream binary distribution installer and release CI, which this sync does not inherit. |
| [`7f21fa34`](https://github.com/PrimeIntellect-ai/prime-agent/commit/7f21fa34) | Not applicable | — | ACP MCP registration is implemented through a CPython proxy absent from Prime Bun's Bun-native tool runtime. |
| [`7941b318`](https://github.com/PrimeIntellect-ai/prime-agent/commit/7941b318) | Explicitly excluded | — | Disk-cursor agent-trace upload scheduling is proprietary trace-sharing infrastructure. |
| [`4f301527`](https://github.com/PrimeIntellect-ai/prime-agent/commit/4f301527) | Not applicable | — | Idle-verdict currency republishes through the roster stack that Prime Bun intentionally has not adopted. |
| [`118c1d90`](https://github.com/PrimeIntellect-ai/prime-agent/commit/118c1d90) | Not ported | — | Extracting a generic event-log substrate is internal refactoring without standalone behavior and is coupled to the excluded trace stack. |
| [`d72beaf9`](https://github.com/PrimeIntellect-ai/prime-agent/commit/d72beaf9) | Deferred | — | Heartbeat residency and durable wake rewrite the newer roster/direct-session lifecycle across daemon and UI boundaries; parity requires a separate capability-gated migration. |
| [`1768ace5`](https://github.com/PrimeIntellect-ai/prime-agent/commit/1768ace5) | Explicitly excluded | — | ACP semantic-edge provenance is trace collection infrastructure outside Prime Bun's no-telemetry policy. |
| [`1c07eaad`](https://github.com/PrimeIntellect-ai/prime-agent/commit/1c07eaad) | Explicitly excluded | — | Semantic-edge delivery depends on the proprietary agent-traces upload outbox. |
| [`61655728`](https://github.com/PrimeIntellect-ai/prime-agent/commit/61655728) | Deferred | — | Busy-descendant counts alter the excluded roster response and agents-view state stack without negotiated daemon capability gates. |
| [`6950bc88`](https://github.com/PrimeIntellect-ai/prime-agent/commit/6950bc88) | Not applicable | — | Late compaction settlement and daemon lineage only repair the excluded semantic-edge producer. |
| [`d74a75fe`](https://github.com/PrimeIntellect-ai/prime-agent/commit/d74a75fe) | Deferred | — | Agents-view token and cost details add uncapped daemon response fields and depend on the excluded roster/ledger projection. |
| [`87fa4998`](https://github.com/PrimeIntellect-ai/prime-agent/commit/87fa4998) | Ported and adapted | [`cc08eb4a`](https://github.com/sng-asyncfunc/prime-bun/commit/cc08eb4a) | Routes Prime Bun's direct-session RLM lookup, state checks, deletion, and cancellation through one cycle-safe iterative visited walk. |
| [`3484f06a`](https://github.com/PrimeIntellect-ai/prime-agent/commit/3484f06a) | Deferred | — | The live generated model refresh overlaps user-owned generator/catalog changes and remains excluded from direct generated-file edits. |
| [`5c2750bd`](https://github.com/PrimeIntellect-ai/prime-agent/commit/5c2750bd) | Ported and adapted | [`cc08eb4a`](https://github.com/sng-asyncfunc/prime-bun/commit/cc08eb4a) | Replaces the Python stderr logger with an ordered Bun-worker log that rotates at 5 MiB while retaining the existing 16 KiB in-memory tail. |
| [`3b51ce33`](https://github.com/PrimeIntellect-ai/prime-agent/commit/3b51ce33) | Ported selectively with v0.9.3 | [`bde357e4`](https://github.com/sng-asyncfunc/prime-bun/commit/bde357e4) | Reconciled the GPT-6 reasoning metadata, Copilot Responses routing, and dated Qwen 3.8 Max alias required by the v0.9.3 Astra fallback while retaining the deferred broad live-catalog refresh. |
| [`36751122`](https://github.com/PrimeIntellect-ai/prime-agent/commit/36751122) | Deferred | — | Usage columns, legends, sorting, and striping build on the excluded cost and roster state contracts and need a separate UI/protocol design. |
| [`9c54a35d`](https://github.com/PrimeIntellect-ai/prime-agent/commit/9c54a35d) | Recreated locally | [`cc08eb4a`](https://github.com/sng-asyncfunc/prime-bun/commit/cc08eb4a) | Updates Prime Bun's lockstep metadata to 0.9.2 without upstream publication, tags, changelog fragments, example-version churn, or distribution code. |

No Python/IPython runtime, telemetry, analytics, trace sharing, semantic-edge provenance, roster/direct-transport wire change, upstream distribution machinery, or generated model catalog change was included in the v0.9.2 synchronization. The selected daemon fix only normalizes an internal process query, so the daemon protocol version and schema revision remain unchanged.

### Prime Agent v0.9.3 disposition

| Prime Agent source | Disposition | Prime Bun trace | Notes |
| --- | --- | --- | --- |
| [`47f94a0e`](https://github.com/PrimeIntellect-ai/prime-agent/commit/47f94a0e) | Ported and adapted | [`bde357e4`](https://github.com/sng-asyncfunc/prime-bun/commit/bde357e4) | Added GPT-6 Astra fallbacks for ChatGPT Codex and GitHub Copilot, raised Codex discovery compatibility to 0.153.4, and preserved the Bun-native provider architecture. |
| [`a062ed22`](https://github.com/PrimeIntellect-ai/prime-agent/commit/a062ed22) | Ported and hardened | [`bde357e4`](https://github.com/sng-asyncfunc/prime-bun/commit/bde357e4) | Centralized Copilot 0.48.1 and VS Code 1.136.1 request identity, advertised Claude Code 2.1.261, and deterministically selected peak numeric UTC-window OpenRouter tariffs without accepting malformed tiers. |
| [`915c78f4`](https://github.com/PrimeIntellect-ai/prime-agent/commit/915c78f4) | Recreated locally | [`bde357e4`](https://github.com/sng-asyncfunc/prime-bun/commit/bde357e4) | Updated Prime Bun's lockstep metadata and dated package changelogs to 0.9.3 without upstream publication, tags, distribution code, or changelog fragments. |

The previously deferred [`3b51ce33`](https://github.com/PrimeIntellect-ai/prime-agent/commit/3b51ce33) generator prerequisite was selectively reconciled through a deterministic existing-catalog update mode; [`3484f06a`](https://github.com/PrimeIntellect-ai/prime-agent/commit/3484f06a) remains deferred because a broad mutable catalog refresh would overwrite unrelated user-owned model work. No Python/IPython runtime, telemetry, analytics, trace sharing, internal governance, upstream distribution machinery, or daemon protocol change was included in the v0.9.3 synchronization.

### Future-agent pickup procedure

1. Fetch without adding or mutating a persistent remote: `git fetch https://github.com/PrimeIntellect-ai/prime-agent.git main`.
2. Inspect new commits after the observed checkpoint: `git log --reverse --oneline 915c78f4..FETCH_HEAD`.
3. Revisit the deferred broad model-catalog refresh only after the user-owned generator changes have been reconciled; retain the scoped existing-catalog update path for release-critical identity and fallback changes.
4. Classify every upstream commit as ported, adapted, excluded, informational, or deferred; add both upstream and Prime Bun commit links here.
5. Do not blindly cherry-pick daemon, dependency, release, Homebrew, or telemetry changes; preserve Prime Bun protocol capability gates, Bun runtime behavior, and dependency-age rules.
6. After code ports, run `npm run check`, focused tests for every changed behavior, live full-model dogfood, and a Fable5 go/no-go gate when the change is cross-cutting.

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

### Verification for the 2026-08-18 synchronization

- `npm run check` passed for Prime Bun 0.7.3, including biome, tsgo, installer render, and browser smoke.
- Focused verification passed 524 coding-agent tests, 10 slow daemon ownership/recovery tests, and 53 TUI fullscreen/link tests; Fable5 independently spot-ran another 260 tests and `tsgo --noEmit`.
- DeepSeek V4 Pro completed the repository audit in session `01a01335-b89a-7728-b216-28719bef9fa3` with eight error-free JavaScript batches, 32–37 MB source-process RSS, immediate 584-line expansion/collapse, and a responsive double-Ctrl+C exit.
- DeepSeek V4 Flash completed fenced Markdown and template-literal structured writes/edits on its first attempt, pure JavaScript hash/parsing, bounded a 588,895-byte 100,000-line result, cancelled an active Bun cell within one second, recovered on the next cell, and resumed session `01a01339-b4a4-7719-a153-f186e3690f84`.
- Fable5 returned `SATISFIED_PROCEED`, confirmed no Python runtime or new trace-sharing telemetry landed, and parked pre-existing fork-identity drift as follow-up work rather than a v0.7.3 blocker.

### Verification for the 2026-08-21 synchronization

- `npm run check` passed for Prime Bun 0.7.4 across 945 files, tsgo, installer rendering, and browser smoke; current focused suites passed 40 agent-loop and 83 Bun worker/render tests in addition to the integrated sync, daemon, compaction, resume, thinking, and model-ranking suites.
- Grok completed a no-edit repository audit with error-free structured JavaScript, then authored fenced Markdown containing backticks through structured write on its first attempt while declaring common `fs`, `crypto`, and `path` locals.
- A 1,000,000-character JavaScript result remained bounded; after its first expanded render, 30 additional expansion cycles stayed responsive and UI RSS settled from 151.7 MB to 87.6 MB instead of growing monotonically.
- A multiline bracketed paste with an image marker survived agents-view handoff, the previous manual stash remained queued behind it, explicit `--resume` restored the transcript, a 30-second Bun cell cancelled within 0.5 seconds, and the next cell executed successfully.
- An adversarial Grok prompt that previously produced 374 identical tool calls was bounded to four successful results plus one explicit loop-guard result, with every call/result pair preserved.
- Fable5 returned `SATISFIED_PROCEED`, verified the final shadowing, render-cache, loop-breaker, exclusion, version, and daemon-compatibility contracts, and approved fast-forward delivery.

### Verification for the 2026-08-22 synchronization

- `npm run check` passed for Prime Bun 0.8.0 across 948 files, tsgo, installer rendering, and browser smoke; focused suites passed 34 agent, 37 AI, and 251 coding-agent tests, followed by 68 MCP/auth and 14 JavaScript provisioner tests after review fixes.
- Authenticated Grok 4.3 completed the no-edit repository audit responsively, persisted state across separate Bun cells, and wrote and byte-verified an exact 133-byte fenced Markdown file containing nested backticks, quotes, and a template literal without embedding authored content in JavaScript syntax.
- A 2 MiB JavaScript result stayed bounded and collapsed; 20 additional expansion toggles left the 36,848 KiB UI RSS unchanged and reduced worker RSS from 34,448 KiB to 34,064 KiB rather than growing.
- Ctrl-C cancelled a synchronous 30-second Bun cell in about three seconds, replaced the worker, restored persistent state, and accepted the next cell; explicit session resume restored the transcript and JavaScript snapshot, and prompt stash/restore preserved quotes and backticks.
- Initial dogfood exposed Grok adding `code: ""` to a structured action payload; a focused regression and live fresh-daemon retest confirmed the compatibility normalization accepts only the empty placeholder while meaningful mixed inputs remain rejected.
- Fable5 first blocked the release because MCP logout had not wired disk-verified removal; after the real logout path, failure reporting, regression, and changelog were corrected, its final verdict was `SATISFIED_PROCEED` and explicitly approved the main fast-forward and push.

### Verification for the 2026-08-26 synchronization

- `npm run check` passed for Prime Bun 0.8.1 across 948 files, tsgo, installer rendering, and browser smoke; focused suites passed 172 tests covering OpenAI reasoning replay, ACP events, model resolution, and recursive session depth.
- Authenticated Grok 4.3 completed a no-edit repository audit with 22 JavaScript results; the only error was the intentional cancellation harness, and no JavaScript syntax error occurred.
- Grok wrote and verified an exact 111-byte fenced Markdown payload containing nested backticks, quotes, and a template literal through structured write on its first attempt; the independently reproduced SHA-256 was `fd9dc8d9924ffef13f70d728332e01e387ab7e9f816b1cfd518a3fdfa70b6548`.
- A 2 MiB JavaScript result stayed bounded; after 20 expansion toggles, source-process RSS settled from 125,824 KiB to 124,128 KiB instead of growing monotonically.
- Ctrl-C cancelled an active 30-second Bun cell while preserving a draft containing quotes and backticks; the replacement worker restored persistent state, accepted a recovery cell in 4 ms, and explicit session resume restored both transcript and snapshot.
- Both Fable5 invocation paths were rejected before inference by the authenticated Claude account's monthly spend limit; at the user's explicit direction, a fresh full-diff self-review and repeated verification replaced that unavailable external gate for delivery.

### Verification for the 2026-09-01 synchronization

- `npm run check` passed for Prime Bun 0.9.1 across 948 files, tsgo, installer rendering, and browser smoke; focused AI and coding-agent suites passed 445 tests covering cache placement, concurrent Bash cancellation, daemon close, message delivery, session lifecycle, worker recovery, and child-update deduplication.
- Authenticated Grok 4.3 completed a bounded no-edit repository audit with five error-free JavaScript action batches and no syntax or string-literal error, then wrote and independently byte-verified an exact 102-byte fenced Markdown payload containing nested backticks, quotes, and a template expression.
- A raw 2 MiB JavaScript result stayed bounded to a 65,536-character expanded render; across 20 additional expansion toggles, client RSS stayed at 23,488 KiB, supervisor RSS settled from 40,848 KiB to 40,784 KiB, and the resident worker retained one 9,600 KiB render cache rather than growing per toggle.
- Ctrl-C interrupted a synchronous 30-second Bun cell, the replacement worker accepted a recovery cell in 8 ms, an exact quoted/backticked draft survived stash and agents-view reopen, and explicit resume restored session `01a05f17-440c-734f-b3ef-8e38b448e3f1`; after settling, supervisor, resident-worker, and kernel RSS were 26,512 KiB, 31,216 KiB, and 2,512 KiB respectively.
- Fable5 independently reran all eight changed test files, verified the lifecycle and exclusion contracts plus all 54 dispositions, and returned `SATISFIED_PROCEED` for fast-forward delivery.

### Verification for the 2026-09-06 synchronization

- Two consecutive final `npm run check` runs passed for Prime Bun 0.9.2 across 951 files, tsgo, installer rendering, and browser smoke; `git diff --check` also passed.
- Focused suites passed 4 timezone/rolling-identity, 4 Bun stderr-log, 99 RLM recursion, and 16 JavaScript provisioner tests; 66 related identity/lifecycle tests, 95 supervisor recovery tests, and 10 process-level supervisor tests also passed, with 6 intentional platform skips.
- Authenticated Grok 4.3 completed a bounded no-edit repository audit, preserved JavaScript state across cells and explicit resume, and live-verified that structured actions tolerate a provider-supplied `code: "undefined"` placeholder without weakening standalone `undefined` cells or meaningful mixed-input rejection.
- Grok wrote and byte-verified an exact 96-byte fenced Markdown payload containing nested backticks, quotes, and a template expression; the independently reproduced SHA-256 was `70dc9c10eeeb6dd8a1559dfa7b566855f0356bc8dce2e0522da6d4cf87c689d5`.
- A 2,000,000-character JavaScript result stayed bounded to 65,536 expanded characters; 20 additional toggles remained responsive without monotonic RSS growth, Ctrl-C interrupted a synchronous 30-second cell, the next cell recovered, and a quoted/backticked draft survived agents-view handoff.
- Fable5 twice blocked delivery on rolling-upgrade identity gaps, first across shared lifecycle consumers and then persisted supervisor worker descriptors; after tri-state legacy matching and red/green regressions covered both, its final verdict was `SATISFIED_PROCEED` for implementation commit, ledger hash substitution, main fast-forward, and non-force push.

### Verification for the 2026-09-07 synchronization

- `npm run check` passed for Prime Bun 0.9.3 across 953 files, tsgo, installer rendering, and browser smoke; focused AI and coding-agent suites passed 23 tests covering peak tariff selection, shared Copilot identity, GPT-6 Astra reasoning/routes, OAuth headers, and the Codex discovery floor.
- The scoped existing-catalog generator produced the same `563dd69cddb1997479753f52e640e71f4e51c04c4a3a8529cf062bac39e5a172` SHA-256 across three consecutive runs and changed only existing Copilot identity/routes plus the two GPT-6 Astra rows.
- Authenticated Grok 4.3 completed a bounded no-edit repository audit, wrote an exact 120-byte fenced Markdown payload containing quotes, an apostrophe, backticks, and a template expression through one structured write, and executed persistent plain JavaScript state without syntax errors.
- A 2,000,000-character JavaScript result remained bounded and responsive; after 20 rapid expansion toggles aggregate source-process RSS settled lower rather than growing monotonically, a synchronous 30-second cell cancelled, and the replacement worker restored the global for a 6 ms recovery cell.
- A draft containing quotes, backticks, and a template expression survived stash/restore exactly; explicit fresh-client resume restored the transcript and returned the persisted global in 123 ms.
- Grok placed `timeoutSeconds` on one search action during the audit, received a precise validation error, removed it on the next turn, and completed; Fable5 classified this recoverable model/schema mismatch as non-blocking because the structured-action schema was unchanged by the sync.
- Fable5 first blocked delivery on missing dated package release headers and the deferred Qwen/GPT-6 prerequisite trace; after both were corrected, its final verdict was `SATISFIED_PROCEED` for safe fast-forward and non-force push.

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
