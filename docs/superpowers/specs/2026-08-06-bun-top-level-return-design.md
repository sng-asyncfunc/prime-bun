# Bun Top-Level Return Design

## Objective

Allow JavaScript and TypeScript notebook cells to use top-level `return` without a parser error. This lets generated RLM code exit a cell early instead of spending another model turn repairing syntax that is already valid inside the worker's async function executor.

## Behavior

- `return value` exits the current cell and exposes `value` as the cell result.
- Bare `return` exits the current cell without a result.
- Statements following an executed return do not run.
- Top-level declarations executed before a return remain available to later cells through the existing persistence hooks.
- The final-expression result behavior remains unchanged for cells without a top-level return.

## Implementation

The cell transformer will enable Acorn's `allowReturnOutsideFunction` parser option. No return statements need rewriting because the worker already executes transformed cells inside an `AsyncFunction`.

Declaration persistence remains statement-local: the transformer already injects `__primePersist` immediately after each top-level declaration. Therefore an early return retains declarations that executed before it and naturally excludes declarations that were not reached.

## Error Handling

Invalid return expressions continue to produce normal syntax errors. Runtime exceptions evaluated by a return expression continue through the worker's existing cell-error path.

## Verification

Unit coverage will prove early exit, returned and bare values, and persistence before the return. A worker integration regression will prove the same behavior after Bun's TypeScript transpilation and across a following cell.

## Non-Goals

- Rewriting returns or suppressing explicit return values.
- Changing final-expression wrapping.
- Changing static binding metadata for unreachable declarations.
- Changing worker protocol messages or snapshot behavior.
