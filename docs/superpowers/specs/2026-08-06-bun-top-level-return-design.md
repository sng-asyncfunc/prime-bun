# Bun Top-Level Return Design

## Objective

Allow JavaScript and TypeScript notebook cells to use top-level `return` without a parser error. This lets generated RLM code exit a cell early instead of spending another model turn repairing syntax that is already valid inside the worker's async function executor.

## Behavior

- `return value` exits the current cell and exposes `value` as the cell result.
- Bare `return` exits the current cell without a result.
- Statements following an executed return do not run.
- Top-level declarations executed before a return remain available to later cells with their latest values, including mutations made by an enclosing `finally` block.
- The final-expression result behavior remains unchanged for cells without a top-level return.

## Implementation

The cell transformer enables Acorn's `allowReturnOutsideFunction` parser option because the worker executes transformed cells inside an `AsyncFunction`.

For each top-level statement containing a notebook-scope return, the transformer records the return value and completion, then persists bindings in an enclosing `finally`. Wrapping the top-level statement makes persistence run after nested user `finally` blocks. A return overridden by an exception or canceled by another control-flow completion does not trigger the return persistence path.

Only bindings declared by earlier top-level statements are included, avoiding temporal-dead-zone reads of declarations that the return skipped. Returns inside nested functions and classes retain normal JavaScript semantics and are not rewritten.

## Error Handling

Invalid return expressions continue to produce normal syntax errors. Runtime exceptions evaluated by a return expression continue through the worker's existing cell-error path.

## Verification

Unit coverage proves final, bare, conditional, exception-overridden, and canceled returns, including persistence after user `finally` mutations. A worker integration regression proves the same behavior after Bun's TypeScript transpilation and across a following cell.

## Non-Goals

- Changing returns inside nested functions or classes.
- Changing final-expression wrapping.
- Changing static binding metadata for unreachable declarations.
- Changing worker protocol messages or snapshot behavior.
