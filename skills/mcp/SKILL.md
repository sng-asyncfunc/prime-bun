---
name: mcp
description: Use external MCP services generically from JavaScript - search the supported-service catalog, inspect the user's connections, discover live tool schemas, and call tools on any connection (Notion, Linear, Slack, and the rest of the catalog) without per-service packages.
---

# MCP Services

Every external service reachable over MCP uses the same pre-loaded `mcp`
global. Adding a service is data (a catalog entry plus a user login), never a
new skill package, and there are no per-service skills to read.

## Inventory: what can I use?

```javascript
// Supported catalog, one bounded page. More pages exist while nextCursor is not null.
const unconnected = await mcp.listPlugins({ connectionStatus: "not_connected", limit: 50 });
const results = await mcp.searchPlugins("notion");    // bounded search
const page = await mcp.listPlugins();                 // default: first 50 entries

// The user's actual connections. connectionId is the dispatch id everywhere below.
const connections = await mcp.listConnections();
```

Catalog entries carry `connectionStatus` (`connected`, `pending`,
`not_connected`, `setup_required`, `disabled`, `error`), `connectable`, and
when connected the `connectionIds` you dispatch on. `connected` means a
verified MCP handshake, not just stored credentials; `pending` means
credentials exist but verification hasn't run or succeeded yet. Entries may
also carry `setupHint` (why a service isn't connectable yet), `unverified`
(imported but not vetted), `verifiedAt`/`toolCount`, and `connectionIds`
(empty when not dispatchable). Entries with `setup_required` need a developer
app or API key first — say so honestly instead of promising one-click.

## Recommend, never connect

If a task would benefit from an unconnected service, name the real catalog
entry (e.g. "Connecting Notion would let me search your workspace directly")
and tell the user to open `/plugins` (or run `/mcp login <service>`) to connect.
Recommendations and catalog lookups never install anything, open a browser,
use credentials, or request extra scopes. There is no agent-initiated connect
call in this slice; if the user connects mid-task, the connection activates on
the next call without a reload.

## Discover, then call

```javascript
// Live tool metadata is cached per connection; schemas come from the server.
const matches = await mcp.searchTools("search workspace documents", { connectionId: "notion" });
const tool = await mcp.describeTool("notion", "notion-search"); // { name, description, inputSchema }
const tools = await mcp.listTools("notion");                    // full tool list with schemas

const result = await mcp.callTool("notion", "notion-search", { query: "roadmap" });
```

- Discover before calling: don't assume tool names or arguments; read the
  `inputSchema` with `describeTool` and construct matching arguments.
- `listTools` returns the complete inventory or throws — never a silent
  partial list. Returned schemas are isolated copies; mutate them freely.
- `searchTools` without a `connectionId` searches at most 8 connections the
  host reports as connected and reports its scope: `searched`, `unavailable`
  (per-connection failures as fixed, redaction-safe summaries), and
  `truncated` (narrow the query or pick a connection when it is set — the
  result never claims to be exhaustive).
- Prefer narrow catalog searches over paging the whole catalog; don't dump all
  schemas into context.
- Results are already-parsed JavaScript values (an object for structured output,
  otherwise a string). No `JSON.parse` needed.
- `await mcp.reload(connectionId?)` refreshes cached server sessions, and
  `await mcp.close()` closes open MCP client connections.

## Large or integrity-critical payloads

`mcp.callTool` runs the MCP client session inside this kernel. Arguments go
from JavaScript straight to the server and never pass through model output or
the daemon; results enter context only if you print them. For bulk writes or
data that must stay exact (financial figures, generated rows), keep the payload
in code:

```javascript
const src = "/tmp/updates.json"; // written by code, never typed by the model
const raw = await fs.readFile(src);
const args = JSON.parse(raw.toString("utf8"));
const result = await mcp.callTool("sheets", "update_spreadsheet", args);
await fs.writeFile("/tmp/updates.result.json", JSON.stringify(result));
const digest = new Bun.CryptoHasher("sha256").update(raw).digest("hex").slice(0, 12);
console.log(args.requests.length, digest);
```

- Build or load arguments with code (`JSON.parse`, `fs.readFile`, a generator).
  Never paste a payload into a cell or ask the model to retype one.
- Write results to a file and check them in JavaScript (counts, hashes, a
  readback compared field by field). Print the summary, not the payload.
- Each call times out after 60 s by default. For large writes, raise
  `callTimeoutMs` in that server's `mcpServers` entry.

## Errors and permissions

- **Permission error** — the tool is excluded by the user's `enabledTools` /
  `disabledTools` policy. Don't retry; tell the user.
- **Not-found error** — the tool or connection doesn't exist. Re-check with
  `listTools` / `listConnections`; tools can change across sessions.
- `McpDiscoveryError` — the server's tool listing couldn't complete honestly
  (broken pagination). No partial inventory is published; re-run, and ask the
  user to reconnect if it persists.
- `McpCredentialsUnavailable` (or runtime/bridge errors) — credentials are not
  available (ask the user to connect via `/plugins` or `/mcp login <service>`,
  never via environment variables), a refresh failed, or the host bridge is
  unavailable.
- `McpToolError` — the server flagged the call as an error. Surface the
  message; don't blindly retry a write that may have already happened.

Credentials never appear in inventory results, tool schemas, or errors.
