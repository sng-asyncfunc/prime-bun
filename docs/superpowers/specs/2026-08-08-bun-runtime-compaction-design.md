# Bun Runtime Compaction Design

## Objective

Reduce Prime BUN notebook memory, checkpoint retention, and namespace-growth latency over very long sessions without weakening abort recovery, killing detached work, or discarding non-serializable live state.

This phase builds on the version-4 graph checkpoint work. It targets costs that remain after alias duplication is removed.

## Evidence

Production-protocol probes on Bun 1.3.14 identified four independent costs.

1. One hundred thousand unique rebinding cells completed in 9.69 seconds but ended at 196 MiB RSS after forced collection. JSC reported only 3.5 MiB of live heap and about 12 MiB through `process.memoryUsage()`, so the excess was native/code allocator retention rather than reachable notebook data.
2. One hundred thousand identical-source cells ended at 102 MiB RSS. The unique-source run retained about 2,000 more `UnlinkedFunctionExecutable` objects, tying the additional native pressure to per-cell compilation.
3. Twenty thousand distinct top-level names took 31.6 seconds without snapshots. Each 2,000-cell bucket grew from 0.59 seconds to 6.14 seconds because `reconcileBindings()` scanned the entire namespace after every cell.
4. Repeatedly checkpointing one stable 64 MiB typed array left the worker around 350–420 MiB RSS after forced collection. An isolated serialization probe showed that `gcAndSweep()` after dropping the serialized buffer reduced retained RSS by roughly one payload generation. At 8 MiB per payload it also improved allocator reuse; at 1 MiB it added overhead.

Bun documents that it has separate JavaScript and native heaps, exposes `heapStats()`, `gcAndSweep()`, and structured-clone serialization through `bun:jsc`, and provides `--smol` to make the GC heap grow more slowly. The `--smol` probe reduced the 100,000-unique-cell result from 196 MiB to 92 MiB with a total-time change from 9.69 to 10.15 seconds.

Primary references:

- [Bun memory measurement and profiling](https://bun.com/docs/project/benchmarking)
- [Bun runtime `--smol` behavior](https://bun.com/docs/runtime#bun-run-smol)
- [`bun:jsc` API reference](https://bun.sh/reference/bun/jsc)
- [Open Bun native-RSS retention report](https://github.com/oven-sh/bun/issues/21560)
- [JavaScriptCore garbage-collector design](https://webkit.org/blog/12967/understanding-gc-in-jsc-from-scratch/)

## Socratic Decisions

### Is automatic worker rotation the right fix?

No. Rotation reclaims native and compiled-code memory, but a notebook may own detached timers, subprocesses, sockets, pending host requests, or bindings that cannot be serialized. A completeness check on binding snapshots cannot prove that those resources are absent. Automatic rotation would turn memory optimization into silent functionality loss.

### Should recovery snapshots become incremental?

Not yet. Arbitrary functions, dynamic global lookup, accessors, proxies, and detached asynchronous work can mutate state without a statically visible root reference. A heuristic dirty-set would make abort recovery nondeterministic. Safe incremental checkpoints require a separate mutation/resource-tracking architecture and compatibility plan.

### Should apparently pure cells skip recovery checkpoints?

No by default. Even a literal-only cell can overlap a detached task created by an earlier cell. The existing boundary checkpoint may capture that task's mutation. Skipping it without reliable async-resource tracking weakens rollback.

### What can be changed safely now?

Use Bun's compact heap policy for the isolated worker, remove redundant namespace scans from the cell-completion path, memoize safety inspection across the complete binding graph, sweep only after large serialized buffers have been written and dereferenced, and correctly mark erroring cells dirty when user code began executing.

## Selected Architecture

### Compact worker heap

`KernelManager` starts the Bun worker with `--smol` by default. A `smol?: boolean` manager option permits throughput-sensitive embedders to opt out. This affects only the dedicated notebook process, not the TypeScript host, daemon, or user subprocesses.

### Demand-driven namespace reconciliation

Top-level declarations already call `persistBinding()` directly. Reconciliation is therefore removed from `executeCell()` and run immediately before `snapshot` and `list_names`, the two operations that consume the binding registry.

This keeps direct `globalThis` additions, deletions, and overwritten module recipes correct while moving an O(namespace) scan off every cell's result path. Recovery checkpoints still reconcile before serialization, so abort state remains current.

### Shared graph safety inspection

Snapshot validation uses one memoizing inspector for the whole binding set. Settled safe and unsafe results are reused across top-level roots and nested shared subgraphs. Each root traversal keeps visiting and provisional-safe cycle state locally; cycle members become globally safe only after the complete root proves safe. This prevents order-dependent acceptance of an unsafe cyclic alias without repeatedly traversing safe cyclic diamonds.

The existing `snapshotValueSkipReason()` API remains as a one-shot wrapper. The worker uses the shared inspector, and serialization fallback still isolates values that JavaScriptCore rejects.

### Large-buffer release

After both recovery and optional persistent files are written, the worker clears references to serialized payload parts. For payloads of at least 8 MiB it invokes `gcAndSweep()` inside a guarded best-effort cleanup. Cleanup failure emits a diagnostic but cannot invalidate an already-written checkpoint.

Small snapshots do not trigger a sweep because measurements showed overhead at 1 MiB. The threshold is an internal constant backed by focused tests and the benchmark record.

### Error-cell durability

Worker result messages add `stateChanged`. It is `true` for successful user execution and for errors thrown after the executor starts; parse, transform, compile, and runtime-global conflict errors report `false`. The host marks recovery and persistence dirty from this field rather than from `status === "ok"`.

This matches notebook semantics: mutations performed before a thrown error remain visible and must survive the next abort or session restore. Aborted cells still recover the prior checkpoint and never mark the killed worker's partial state dirty.

This bumps only the private Bun host/worker protocol. There is no daemon command, event, or response-shape change.

## Error Handling

- `--smol` is passed only to a resolved supported Bun runtime.
- Reconciliation stays inside snapshot/list operations and cannot delay delivery of a completed cell result.
- Shared validation caches an inspection failure as unsafe and never treats a previously failed graph as safe.
- `gcAndSweep()` is best effort after durable writes; it cannot turn a valid snapshot into a failure.
- Failed user code is checkpointed conservatively. Errors before user execution do not generate redundant state writes.

## Verification

Test-first coverage proves:

- workers start in compact mode by default and can opt out;
- direct global additions/deletions remain visible to listing and snapshots after reconciliation moves;
- shared nested objects are safety-inspected once, including cycles and unsafe shared descendants;
- large payload cleanup is threshold-gated and cleanup failure is non-fatal;
- mutations before a thrown error survive persistence and abort recovery;
- syntax/transform errors do not mark a clean namespace dirty; and
- the existing graph identity, cap, timeout, mirror, v2/v3 restore, and abort suites remain green.

Benchmarks repeat the 100,000-unique-cell, 20,000-distinct-name, 64 MiB stable-state, and 8 MiB alias workloads. Repository `npm run check` and an adversarial read-only review gate finish the phase.

## Results

The production-protocol benchmark matrix completed with the default compact heap policy:

- 100,000 rebinding cells completed in 10.37 seconds and ended at 133 MiB RSS after collection, with 3.45 MiB of live JSC heap.
- 20,000 distinct-name cells completed in 2.17 seconds instead of 31.6 seconds, a 93% reduction in elapsed time; the final 2,000-cell bucket remained flat at 0.20 seconds instead of growing to 6.14 seconds.
- Twenty checkpoints over one stable 64 MiB value completed in 1.48 seconds and ended at 241 MiB RSS after collection, below the prior 350–552 MiB range.
- Twenty aliases over one 8 MiB value produced an 8 MiB checkpoint, completed in 0.14 seconds, and ended at 75 MiB RSS after collection.

The focused kernel suites, repository checks, and Fable5 gate passed. Fable's blocking review found an order-dependent safe-cache result inside an unsafe cycle; regressions now cover both roots at worker level. Its follow-up performance concern led to provisional cycle promotion, reducing a 12-level cyclic-diamond probe from 4,095 inspections to 12 while retaining unsafe-cycle rejection.

## Deferred Research

- Mutation-aware component snapshots with tracked async resources.
- A standby worker or OS copy-on-write checkpoint architecture.
- Safe worker rotation after proving the absence of detached resources and non-serializable state.
- Persistent compiled-cell caches shared across worker generations.

These ideas retain high upside but require dedicated protocols and correctness models rather than heuristic integration into this phase.
