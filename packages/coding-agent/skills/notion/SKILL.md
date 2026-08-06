---
name: notion
description: Search Notion and read/create/update pages and databases via Notion's official hosted MCP server. Tools are auto-discovered from the server at runtime.
---

# Notion

Talk to Notion through its official hosted MCP server from the Bun REPL.

## Setup

Connect via `/login` → **Services** tab → **Notion** (OAuth in the browser).
`/mcp login notion` does the same. Once connected, this skill is enabled
automatically. If a call raises `NotEnabled`, the user isn't logged in — walk
them through `/login`; don't ask them to set environment variables.

## Usage

The tool set is defined by the server, not by this skill, so **discover before
you call** — don't assume tool names or argument names:

Notion's tools are named with hyphens (e.g. `notion-search`, `notion-fetch`),
which require bracket access in JavaScript — call them via `callTool`:

```javascript
// 1. Discover available tools (returns names + schemas)
for (const tool of await notion.listTools()) {
  console.log(tool.name, "-", tool.description);
}

// 2. Call by exact name; the second arg matches the tool's input schema
const result = await notion.callTool("notion-search", { query: "roadmap" });
console.log(result);
```

Tools whose names *are* valid identifiers can also be called as
`await notion.<tool>(args)`.

Notes:
- Every call is `async` — always `await`.
- Results are already-parsed JavaScript values (an object for structured output,
  otherwise a string). No need to call `JSON.parse`.
- Run `listTools()` before assuming a tool exists — the
  server's schema is the source of truth for names and arguments.
