# Bun Transient State Hygiene Design

## Objective

Reduce long-session Bun checkpoint growth and memory pressure without changing notebook semantics. The harness should teach models to persist compact, reusable state at top level while keeping large one-shot intermediates inside an explicit block so they are not serialized into later checkpoints.

## Reproduced Behavior

A DeepSeek V4 Flash dogfood session generated 5,000 records, serialized them, wrote the result, parsed it again, and verified the artifact. The transcript stayed at 15,541 bytes, but the notebook checkpoint reached 716,229 bytes because the persistent namespace retained the records alongside sorted, serialized, and parsed duplicates.

A control session created and wrote a 2,000,000-character value inside `{ ... }`. The value was unavailable in the next cell, the artifact was correct, and the checkpoint remained 195 bytes. This isolates persistent top-level bindings—not file output or transcript storage—as the avoidable source of checkpoint amplification.

## Socratic Decision

### What state is valuable?

Compact values that the model expects to reuse across cells are valuable notebook state. Examples include a file path, a computed summary, or a normalized record set that will feed later analysis.

### What state is accidental?

Serialized text, parsed copies of already-retained data, sorted copies, temporary buffers, and other large values used for only one operation are accidental persistent state. Retaining them makes every later checkpoint larger without improving the model's ability to continue the task.

### Why not evict values automatically?

Runtime eviction would silently change JavaScript semantics and could remove a value the model intended to reuse. Size alone cannot determine intent, so automatic eviction is rejected.

### Why not add a checkpoint warning first?

A warning adds UI and policy complexity, consumes context, and still asks weaker models to recover after the waste has occurred. It remains a possible follow-up if live dogfood shows that concise, local guidance is insufficient.

### Selected approach

Add a short state-lifetime contract to both the JavaScript control prompt and the JavaScript tool description:

- Top-level named bindings are durable session state and are checkpointed between cells.
- Only values likely to be reused should remain at top level.
- Large one-shot intermediates should be created inside an explicit `{ ... }` block.
- Direct computed writes inside that block are preferred over retaining both an object and its serialized representation.
- Compact reusable summaries may remain at top level.

Placing the rule in both surfaces gives weaker models a global explanation and a local reminder at tool selection time. The runtime and checkpoint format remain unchanged.

## Behavioral Contract

The guidance must explicitly name common duplication patterns: serialized text, parsed duplicates, sorted copies, and temporary buffers. It must recommend an explicit block rather than relying on `delete`, reassignment, or garbage collection, because top-level lexical bindings cannot be reliably removed and the notebook checkpoint is derived from persistent scope.

The wording must not promise immediate RSS reduction. Block scope prevents the transient value from becoming durable notebook state; garbage collection timing remains a runtime concern.

## Verification

Automated regressions will require the lifetime contract in the generated system prompt and in the JavaScript tool surface. The focused system-prompt test will be observed failing before production text changes and passing afterward.

Live DeepSeek V4 Flash dogfood will cover:

1. A hybrid analysis that retains reusable records but writes and verifies large serialized data without preserving redundant copies.
2. A one-shot large artifact where the payload is not needed later and should not enter the persistent checkpoint.

For each case, verification will inspect tool calls, results, checkpoint bytes, process RSS, and leftover processes. Repository-wide checks and a blocking Fable5 review are required before the change is considered ready.

## Non-goals

- Automatic variable eviction or cleanup.
- A new checkpoint warning, memory meter, or UI.
- Changes to garbage collection behavior.
- Changes to shell routing, search helpers, or crypto APIs.
- Changes to the daemon protocol or checkpoint format.
