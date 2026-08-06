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

Use exact old/new strings. Template literals are useful for multiline snippets.
Returns a short confirmation; raises if `oldStr` is
missing or matches more than once (widen the snippet to make it unique).
