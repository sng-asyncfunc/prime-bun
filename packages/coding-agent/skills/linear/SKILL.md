---
name: linear
description: Read and write Linear issues, projects, cycles, comments, and more via Linear's official MCP server. Tools are auto-discovered from the server at runtime.
---

# Linear

Talk to Linear through its official hosted MCP server from the Bun REPL.

## Setup

Connect via `/login` → **Services** tab → **Linear** (OAuth in the browser).
`/mcp login linear` does the same. Once connected, this skill is enabled
automatically. If a call raises `NotEnabled`, the user isn't logged in — walk
them through `/login`; don't ask them to set environment variables.

## Usage

The tool set is defined by the server, not by this skill, so **discover before
you call** — don't assume tool names or argument names:

```javascript
// 1. Discover available tools
for (const tool of await linear.listTools()) {
  console.log(tool.name, "-", tool.description);
}

// 2. Inspect the tool's inputSchema returned by listTools().

// 3. Call it; the object must match the tool's input schema
const result = await linear.list_issues({ team: "Engineering" });
console.log(result);
```

Notes:
- Every tool is an `async` method — always `await`.
- Results are already-parsed JavaScript values (an object for structured output,
  otherwise a string). No need to call `JSON.parse`.
- For tools whose names aren't valid JavaScript property identifiers, use the escape hatch:
  `await linear.callTool("tool-name", { arg: "value" })`.
- Run `listTools()` before assuming a tool exists — it returns the server's
  descriptions and JSON input schemas, and the server is the source of truth
  for tool names and arguments.
