# Prime Agent v0.7.4 Synchronization Design

## Objective

Bring Prime Bun to selective behavioral parity with Prime Agent v0.7.4 while preserving the persistent Bun JavaScript notebook, bounded terminal rendering, daemon compatibility, configurable keybindings, and telemetry-free product policy. Validate the integrated release with a live Grok repository audit that exercises long output, JavaScript actions, cancellation, expansion, resume, and memory settling.

## Reviewed range

The reviewed upstream range is `61131b2d..af0b8e00`, from the previously dispositioned Prime Agent v0.7.3 release commit through the v0.7.4 release commit. It contains fourteen commits.

| Prime Agent source | Decision | Prime Bun treatment |
| --- | --- | --- |
| `e85a67ac` daemon root depth | Port and harden | Remove inherited `RLM_DEPTH` from each new top-level resident worker environment. |
| `7ca44937` long-running RLM guidance | Port and adapt | Add Bun-native nonblocking work, bounded-wait, parallel-worker, progress-update, and concise-prose guidance without Python or nonexistent job helpers. |
| `20b54977` compaction continuation | Already superseded | Keep Prime Bun's durable action-lifecycle implementation from `2b60254c`; rerun its regression instead of replacing it with the less precise upstream condition. |
| `032e3ee7` broad cleanup | Do not port | The release-wide comment and unused-internal deletions create large churn without user-visible parity and conflict with Prime Bun-specific runtime code. |
| `aa0bdfa6` remove nonexistent async bash guidance | Not applicable | Prime Bun's Bun prompt does not contain the upstream IPython `bash()` or managed-job paragraph. |
| `8ee310c5` raw newline handling | Port | Let a literal newline reach the editor while retaining configurable `app.edits.expand` handling for unambiguous key encodings. |
| `d51590c4` agents-view draft preservation | Port and adapt | Auto-stash nonblank rich drafts during full or scoped agents-view handoff and restore them immediately when that session reopens. |
| `824a9ee3` child reasoning override | Port and adapt | Accept `thinking` in the JavaScript `rlm` options object, validate it before spawn, and reject levels unsupported by the resolved child model. |
| `8189b12d` daemon socket normalization | Port and harden | Normalize socket identities at every CLI, daemon, supervisor, log, ownership, and update-restart boundary while tolerating matching legacy descriptor spellings. |
| `e7b8cae9` Linear workflow | Explicitly exclude | Upstream organization governance is not part of Prime Bun. |
| `1663d443` IPython snapshot bounds | Explicitly exclude | Prime Bun has no IPython runtime; its Bun notebook already has separate bounded snapshot safeguards. |
| `f8f0036c` Trendshift badge | Do not port | Upstream repository promotion is unrelated to runtime parity. |
| `b09fbdb4` model-search ranking | Port | Rank exact IDs before prefix/token and fuzzy matches, then use authentication, current model, recency, and deterministic order as tie-breakers. |
| `af0b8e00` release metadata | Recreate locally | Bump Prime Bun and all workspace packages to 0.7.4 and write Prime Bun-specific changelog and trace entries. |

## Behavioral contract

### Runtime and prompt behavior

- New top-level daemon sessions always start at RLM depth zero even when their supervisor was launched from a child process.
- Slow work never relies on sleep loops, repeated polling, or an unbounded blocking await. Independent RLM workers start without sequential waiting, and root sessions provide concise outcome-focused progress at meaningful milestones.
- The prompt describes only Bun JavaScript, structured actions, documented shell helpers, and available RLM capabilities.
- Prime Bun retains its existing bounded JavaScript output and snapshot protections; no IPython or Python REPL source, tests, dependencies, or guidance are added.

### Terminal interaction

- A raw newline inserts an editor newline and never triggers the edit-diff action; an unambiguous configured Ctrl+J sequence still triggers that action.
- Opening either agents view with a draft is lossless. Text, paste snapshots, and image markers remain attached to the originating client session, existing manual stashes remain queued, and whitespace-only drafts are ignored.
- Draft preservation and all keyboard actions are immediate and unanimated.
- Model searches prioritize intent rather than allowing a weak signed-in match to outrank an exact match.

### RLM child configuration

- `await rlm("task", { thinking: "low" })` applies the requested reasoning level to the resolved child.
- `thinking` must be a known string value and must be supported by the resolved child model; invalid requests fail before child runtime creation.
- Omitting `thinking` keeps the current parent-level inheritance and model clamping behavior.

### Daemon compatibility

- Socket normalization is backward-compatible internal behavior. It changes no daemon command, event, response shape, capability, startup requirement, `DAEMON_PROTOCOL_VERSION`, or `DAEMON_SCHEMA_REVISION`.
- Relative `--daemon-socket` values resolve after `--cwd`, equivalent Unix spellings share identity-derived paths, and Windows retains its existing named-pipe behavior.
- Persisted descriptors using an equivalent old spelling remain readable and are normalized in memory; the port does not introduce cross-directory migration.

## Implementation boundaries

- Port behavior manually against Prime Bun's current files; do not cherry-pick the broad cleanup or upstream Python changes.
- Add focused regressions before production changes and observe each relevant failure before implementing the port.
- Keep thinking-level values in one shared typed module rather than duplicating CLI and runtime lists.
- Centralize lexical daemon socket normalization in one utility and reuse it from all identity consumers.
- Preserve existing Prime Bun action-lifecycle hardening around compaction and only improve its test determinism if necessary.
- Do not modify `packages/ai/scripts/generate-models.ts` or `packages/ai/src/models.generated.ts`; both contain pre-existing user changes.
- Do not add analytics, PostHog, trace-sharing promotion, installation identity, or outbound telemetry.

## Verification

- Run every changed test file from its package root with the repository's Vitest entry point.
- Run the existing compaction-continuation suite to prove the local superseding behavior remains intact.
- Run the slow daemon process regressions for root depth and normalized socket launch.
- Run `npm run check` with complete output after code changes and again on the release tree.
- Scan the final changed paths and added lines for Python/IPython, telemetry, hardcoded key checks, and generated-model edits.
- Dogfood from source in a dedicated tmux session using an authenticated Grok model. Run the repository KEEP/REMOVE audit without edits, persistent multi-cell JavaScript, structured search/read actions, a bounded large-output cell, expansion/collapse, cancellation, a follow-up cell, agents-view draft restoration, and resume.
- Sample the source process tree before, during, and after the Grok run. Require responsive input and Ctrl+C, bounded visible output, no JavaScript errors, no terminal corruption, and stable post-run RSS rather than monotonic growth.
- Send the final diff and verification evidence through a read-only Fable5 go/no-go review.

## Release and delivery

- Set the root and all published workspace packages to version 0.7.4 without publishing npm packages or copying upstream release branding.
- Finalize affected package changelogs in the repository's flat format and update `changelog.md` with every upstream disposition, Prime Bun commit traces, Grok evidence, and Fable5 verdict.
- Commit only files changed for this synchronization. Preserve all unrelated modified and untracked user files.
- Fast-forward the verified feature branch into local `main`, push `main` to `origin`, and verify local `main`, `origin/main`, and the remote ref resolve to the same commit.

## Non-goals

- IPython state persistence, Python package management, Python kernel tooling, or Python-specific prompt text.
- Prime Agent telemetry, trace-sharing promotion, Linear enforcement, repository badges, or broad cleanup-only churn.
- Model-catalog regeneration or direct edits to generated model data.
- Daemon protocol or schema changes.
- npm publication, GitHub release creation, or git tag creation.
