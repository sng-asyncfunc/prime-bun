# Bun Shell Lifecycle Design

## Problem

The Bun notebook launches configured-shell commands with `execFile` and leaves the child stdin pipe open. Commands that infer input from stdin, including `rg` without a path and `git shortlog` without a revision, can therefore wait forever. Structured action output is emitted only after the whole batch finishes, so a later hung command also hides earlier completed evidence. A user abort kills the worker and its descendants, but the agent loop replaces the tool result, leaving the model without the evidence needed to explain the failure accurately.

## Behavioral contract

- Notebook shell execution is non-interactive: stdin is closed immediately for shell actions, `sh()`, package installation, and structured search subprocesses.
- Structured shell actions have a 120-second wall timeout by default and accept an explicit `timeoutSeconds` override up to 86,400 seconds.
- `sh()` has no default timeout; callers may opt into `sh(command, { timeoutMs })` for long-lived code-mode composition.
- Shell pipelines run in isolated process groups. The worker reports live child PIDs to the host, and force-stopping a worker freezes and sweeps its process tree so even a not-yet-reported shell cannot escape abort, recovery, shutdown, or timeout cleanup.
- Cancelling while an ordinary recovery checkpoint finishes returns an aborted cell without poisoning later notebook execution; genuinely wedged checkpoints still fail closed.
- A timed-out structured action returns its partial output and an actionable non-zero result without restarting the worker.
- Completed structured action sections stream in order while the batch is running. The final accumulated result remains bounded and contains every completed section up to the batch output cap.
- Prompt and tool guidance state that stdin is unavailable, explicit search paths and Git revisions are required, and the agent must stop when an authoritative result answers the request.

## Architecture

Add a worker-local spawn runner that owns stdin closure, bounded stdout/stderr capture, optional wall deadlines, and process-group termination. It remains inside the worker so persistent `process.cwd()` and `process.env` mutations continue to affect later cells. The existing Bash tool remains separate because it has different output persistence and orphan-journal responsibilities.

Child process start and exit notifications extend the private host/worker protocol. The host tracks PIDs per current worker and kills those process groups before terminating or replacing that worker. On POSIX force-stop paths, it first suspends the worker and snapshots its descendants, closing the small spawn-to-notification race before terminating every discovered process group. Timeout termination happens inside the worker and returns normally through the existing cell result path.

Recovery checkpoint cancellation has a short grace window. A healthy in-flight checkpoint may finish and preserve the notebook before the aborted cell returns; if the checkpoint remains wedged beyond the grace window, the existing fail-closed recovery behavior terminates the worker and blocks further cells rather than silently losing state.

Structured action execution accepts a completion callback. Each bounded action section is emitted once on completion, while a bounded cumulative renderer produces the final tool result without duplicating streamed content.

## Delivery order

1. Reproduce stdin-sensitive hangs with live-kernel tests and close stdin in all notebook subprocess paths.
2. Add child process tracking, process-group cleanup, timeout validation, and timeout recovery tests.
3. Stream completed structured sections and verify order and partial evidence.
4. Update notebook guidance and the unreleased changelog.
5. Run focused regressions, the full repository check, direct dogfood reproductions, and a read-only Fable5 go/no-go review.

## Non-goals

- No command-specific sniffing or rewriting.
- No default timeout for arbitrary code-mode `sh()` calls.
- No inactivity timeout.
- No host-side shell execution that would break worker-local cwd or environment state.
- No abort-evidence changes in the general agent loop in this patch; that is a separate cross-package follow-up.
