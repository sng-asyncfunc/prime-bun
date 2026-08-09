---
name: edit
description: Replace an exact, unique string in an existing file. Use for targeted single-occurrence edits from the Bun REPL instead of rewriting the whole file.
---

# Edit

Make a targeted edit to an existing file by replacing one exact, unique
occurrence of a string. `oldStr` must appear exactly once in the file.

Call directly from the kernel:

```javascript
await edit({ path: "pkg/file.ts", oldStr, newStr });
```

Read the target first and use exact old/new strings copied from the file. Include
enough surrounding lines to make `oldStr` unique. For snippets containing
backticks, `${...}`, or Markdown fences, use ordinary quoted strings with `\n`
escapes or arrays of quoted lines joined with `"\n"`; do not use a template
literal. Preserve unchanged text exactly and reread the affected window after
editing. Returns a short confirmation; raises if `oldStr` is missing or matches
more than once (widen the snippet to make it unique).
