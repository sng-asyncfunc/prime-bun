# Bun Long-Session Stability Design

## Objective

Keep Prime BUN responsive and memory-safe during long JavaScript notebook sessions without weakening abort recovery or session resume. Aliases to one object graph must not multiply checkpoint memory or disk use, and one dirty cell must not serialize the same namespace separately for recovery and persistence.

## Evidence

The Bun 1.3.14 worker was exercised through its production protocol.

- Twenty aliases to one 8 MiB `Uint8Array` used about 49 MiB RSS without snapshots.
- Taking the existing recovery snapshot before every cell raised the worker to about 506 MiB RSS.
- The final checkpoint contained one 8 MiB serialized copy per alias and lost alias identity on restore.
- Serializing the same bindings together in one `Map` produced an 8 MiB payload and retained shared references.
- Replacing one binding for 20,000 cells stayed responsive. Distinct persistent names increased reconciliation cost gradually but did not reproduce the crash-scale amplification.

The primary fault was per-binding structured cloning, compounded when recovery and persistent snapshots serialized the same namespace separately.

## Selected Design

Snapshot-safe ordinary bindings are serialized together as `Map<string, unknown>`. JavaScriptCore's structured-clone graph then preserves shared references and cycles across bindings. Function and module recipes remain separate entries because they use different restore mechanisms.

Snapshot format version 4 adds a `bindings` entry. Versions 2 and 3 remain readable so existing session state can still restore. Unsupported bindings are reported individually. If a value passes validation but structured cloning rejects it, or a mixed graph exceeds the cap, the worker bisects the binding group to isolate unsafe or oversized values while preserving smaller safe state. Direct aliases are grouped by object identity during fallback so they cannot be repeatedly cloned. Validation results are cached by object identity so aliases are not repeatedly traversed.

Restore deserializes each binding graph once, validates its map shape and string keys before installation, refuses runtime-global collisions, and installs each value. A normal snapshot uses one graph, preserving alias identity across all ordinary bindings.

The worker protocol accepts an optional persistent mirror on a recovery request. The private recovery file includes cwd/environment state; the persistent session file reuses the same serialized binding buffers without runtime metadata. A mirror failure remains retryable and does not invalidate a successful recovery checkpoint. Coalescing is used only when both snapshots have the same byte cap; differing caps retain independent writes and semantics. A background recovery timeout is contained, records a diagnostic, terminates the wedged worker, and blocks unsafe execution instead of escaping as an unhandled rejection.

This changes the private Bun host/worker protocol and snapshot encoding, not the daemon protocol. No daemon capability or schema revision is required.

## Alternatives Rejected

- Forced garbage collection did not release the retained serialized checkpoint buffers.
- Worker recycling would discard non-serializable live resources and introduce restart pauses.
- Less frequent recovery snapshots would weaken synchronous-abort rollback guarantees.

## Verification

Regression coverage proves compact aliased snapshots, alias-preserving restore, version-3 compatibility, zero-copy payload decoding, isolation of uncloneable bindings, one-pass recovery/persistence writes, mirror failure handling, and distinct-cap behavior. Final verification includes all focused test files, `npm run check`, a before/after reproduction, and a read-only Fable5 review loop.

## Non-Goals

- Automatically deleting user bindings.
- Killing user-created timers or background resources.
- Weakening recovery checkpoints.
- Changing notebook syntax, rendering, or daemon wire behavior.
