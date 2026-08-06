# Bun RLM Performance Design

## Goal

Make the Bun notebook outperform the former Python/Jupyter notebook on normal RLM work while preserving the stronger Bun recovery guarantees. Performance claims must use end-to-end wall time rather than only worker evaluation time.

## Baseline

Local matched runs against the globally installed Prime Agent 0.7.0 Python kernel and this branch on Bun 1.3.14 produced these representative results:

| Operation | Python | Bun before optimization |
| --- | ---: | ---: |
| Warm startup | 594–610 ms | 42–46 ms |
| Persistent scalar cell | 3.6–6.1 ms | 2.7–3.7 ms |
| 65,536-character output | 3.8–5.6 ms | 2.1–3.0 ms |
| Abort synchronous loop | 116 ms | 102 ms |
| First cell after abort | 5.4 ms | 3.6 ms |
| Ordinary shell command | 9.5 ms | 3.8 ms with Bun Shell; 12.5 ms with `sh` |
| 10,000 one-byte writes | 25.6 ms | 186 ms |
| Checkpoint after a 32 MiB typed array | Not applicable to Python interrupt recovery | Greater than 90 seconds |

The typed-array result is an algorithmic fault, not serialization cost: Bun serializes the same 32 MiB value in about 18 ms, while the snapshot validator enumerates every typed-array index first.

## Chosen Design

### Batch cell output at the worker boundary

The worker will coalesce synchronous writes by cell and stream name. A microtask flush preserves interactive output for asynchronous work, and an explicit flush before the result frame guarantees all synchronous output reaches the host before cell completion. A bounded byte threshold prevents an individual buffer from growing without limit.

The host remains responsible for final character caps and for dropping frames attributed to completed cells. The protocol shape does not change; only the number and size of `stream` frames change.

### Validate standard typed arrays without enumerating indices

For a built-in typed-array prototype, the validator will accept the indexed storage in constant time instead of calling `Object.keys()`. Bun's serializer preserves the typed-array data but does not preserve arbitrary custom properties. Custom properties on typed arrays are therefore explicitly outside the best-effort snapshot contract, matching the existing serializer's behavior while avoiding an unbounded preflight scan.

Unsupported views, subclassed typed arrays, custom prototypes, symbols, promises, weak references, and unsafe nested values remain rejected as before.

### Prefer Bun Shell for ordinary RLM commands

The runtime keeps `sh(command)` as the compatibility path for configured shell executables and command prefixes. The RLM prompt will lead with Bun Shell for ordinary commands because it is more than twice as fast in the matched benchmark, then explain when `sh` is required. This changes model routing without changing shell semantics.

### Report end-to-end and phase timings

`ExecuteResult.durationMs` will measure the complete public `execute()` call, including startup, queueing, recovery checkpointing, worker execution, and abort recovery. An optional timing breakdown will expose:

- startup time;
- execution-queue wait;
- recovery-checkpoint time;
- worker execution time; and
- total time.

The JavaScript tool will carry the breakdown in its details. Existing consumers that only read `durationMs` remain compatible and receive a more accurate value.

## Rejected Designs

### Background checkpointing

Checkpointing immediately after a cell could hide work behind the model round trip, but a completed cell may still have pending asynchronous callbacks that mutate persisted objects. A background checkpoint can become stale before the next cell and silently weaken abort recovery.

### Incremental dirty-binding snapshots

Declarations and explicit global assignments are observable, but mutations through retained object references are not. Treating only syntactically assigned bindings as dirty would make performance depend on an incomplete mutation detector.

Both designs are rejected until the runtime can prove quiescence or observe all retained-object mutations.

## Verification

Regression coverage will prove that:

- a synchronous burst is emitted in bounded batches rather than one protocol frame per write;
- all output arrives before the result frame and delayed output remains isolated by cell;
- standard typed arrays are accepted without enumerating their numeric keys;
- typed arrays still survive restart recovery;
- total timing includes checkpoint overhead and the phase breakdown is internally consistent; and
- the prompt prefers Bun Shell while retaining the exact `sh` contract.

After the focused tests and repository check, rerun the matched Python/Bun benchmark. Bun must retain its existing wins and eliminate the streaming and typed-array pathologies. Timing assertions in the permanent suite should verify accounting invariants and bounded protocol work, not fragile machine-specific millisecond thresholds.
