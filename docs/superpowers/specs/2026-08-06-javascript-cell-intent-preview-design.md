# JavaScript Cell Intent Preview Design

## Objective

Make collapsed JavaScript tool calls readable at a glance without flooding terminal history. Replace the visible `javascript` label with `js`, separate status from long source previews, and preserve the full source in the existing expanded view.

## Layout

Collapsed cells use an adaptive layout:

- short previews remain on the status row when the complete row fits;
- long JavaScript previews move below the status row;
- the intent preview may wrap once, for at most two preview rows;
- status metadata remains on the first row: marker, `js`, line counts, duration, error, and expand hint;
- expanded cells keep their current exact source and output rendering.

Example:

```text
✓ js · ↑1 ↓11 lines · 39ms
  agentObserve.recentMessages("mechanics-auditor", …)
```

## Intent Compression

The existing preview selector continues choosing the highest-signal statement. The collapsed JavaScript preview then removes a leading `await` and collapses bulky trailing arguments to `…` while retaining the callee and first identifying argument. Bash previews keep their existing behavior and label.

Compression is display-only. It never modifies executed code or expanded source.

## Interaction and Visual Rules

- No animation; tool history is a high-frequency keyboard-driven surface.
- Use muted `js` language text and existing syntax highlighting for the intent preview.
- Keep the status row stable when expanding or collapsing.
- Every rendered row must remain within the available terminal width and close ANSI color spans.

## Testing

Add renderer regressions proving:

- `javascript` is rendered as `js`;
- a long JavaScript call moves to an indented intent row;
- the long intent preview wraps at most once;
- a short call stays on one row;
- expanded source remains exact; and
- all rows remain within the terminal width without ANSI color leakage.

## Non-Goals

- Model-generated prose summaries.
- More than two collapsed preview rows.
- Changing bash preview behavior.
- Changing executed code, tool protocol names, or the `javascript` tool identifier.
