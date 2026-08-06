# MCP Integrations

Prime Agent exposes Model Context Protocol servers through JavaScript-backed skills. MCP servers do not become separate model tools; an enabled integration becomes one prepared global inside the persistent Bun notebook.

## Built-in integrations

Prime Agent ships disabled Linear and Notion skills. Connect one with `/login` or `/mcp`:

```text
/mcp login linear
/mcp login notion
```

OAuth opens in the browser. Credentials are stored under `mcp:<name>` in `~/.prime/agent/auth.json`. A valid credential enables the matching skill; logging out disables it again.

The prepared globals discover server tools and expose them as async properties:

```javascript
const tools = await linear.listTools();
console.log(tools.map((tool) => `${tool.name}: ${tool.description}`).join("\n"));

const issues = await linear.list_issues({ team: "Engineering" });
const page = await notion.search({ query: "launch plan" });
```

Use `callTool(name, arguments)` when a tool name is not convenient as a property:

```javascript
const result = await linear.callTool("list_issues", { team: "Engineering" });
```

Each call creates an authenticated MCP client, normalizes text or structured results, and closes the transport. OAuth refresh remains host-owned.

## Commands

```text
/mcp                    open integration status and connection management
/mcp login <name>       connect with OAuth
/mcp logout <name>      remove the stored credential
```

`/login` exposes the same MCP Connections tab.

## Server configuration

Declare custom servers under `mcpServers` in global or project settings:

```jsonc
{
  "mcpServers": {
    "acme": {
      "type": "http",
      "url": "https://mcp.acme.com/mcp",
      "oauth": true
    }
  }
}
```

The server configuration alone does not add a model tool or notebook global. Add a matching JavaScript-backed skill that defines the model-facing API.

## JavaScript skill layout

```text
acme/
├── SKILL.md
├── package.json
└── src/
    └── index.ts
```

`package.json` declares the prepared global and the official MCP SDK dependency:

```json
{
  "name": "prime-agent-acme-skill",
  "private": true,
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0"
  },
  "primeAgent": {
    "entry": "src/index.ts",
    "global": "acme"
  }
}
```

Run `bun install` in the skill directory after adding dependencies.

The entry module exports `createSkill(context)` and returns the callable or object exposed as `acme`. A minimal bearer-token integration looks like this:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface SkillContext {
  readonly cwd: string;
  display(mimeType: string, data: unknown): void;
  hostRequest(type: string, payload?: unknown): Promise<unknown>;
}

export function createSkill(_context: SkillContext) {
  const endpoint = "https://mcp.acme.com/mcp";

  return {
    async callTool(name: string, args: Record<string, unknown> = {}) {
      const token = process.env.ACME_TOKEN;
      if (!token) throw new Error("ACME_TOKEN is not configured");
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: "prime-agent-acme", version: "1.0.0" });
      await client.connect(transport);
      try {
        return await client.callTool({ name, arguments: args });
      } finally {
        await client.close();
      }
    },
  };
}
```

For Prime Agent-managed OAuth, use `context.hostRequest("mcp.config", { server: "acme" })` to obtain the authoritative endpoint and headers metadata. If a stored access token is expired, call `context.hostRequest("mcp.refresh", { server: "acme" })`, then reread the credential from `auth.json`. The bundled Linear and Notion skills implement this complete flow in `skills/_shared/mcp.ts` and are the canonical template.

## SKILL.md guidance

Describe when the integration applies, the prepared global, and its input conventions:

````markdown
---
name: acme
description: Query and update Acme work items over MCP. Use for Acme issue, project, or planning requests.
---

# Acme

Use the prepared `acme` global from the Bun notebook.

```javascript
const tools = await acme.listTools();
const result = await acme.callTool("list_items", { project: "Core" });
```
````

Only the skill metadata enters the startup prompt. Full instructions remain on demand.

## Result and error handling

MCP results may contain text blocks, structured content, images, or embedded resources. Preserve structured content when available and throw on `isError` responses so the cell is visibly marked failed. Bound or summarize very large tool results before returning them to the model.

An unavailable credential should produce an actionable message naming `/mcp login <name>`. Do not silently return empty data.

## Security

- Treat server descriptions, tool results, and embedded resources as untrusted input.
- Keep credential refresh and persistent auth writes in the TypeScript host.
- Do not print access tokens or include them in tool results.
- Review third-party skill code and dependencies before loading them.
- The Bun notebook is not a sandbox; MCP skills run with the session worker's operating-system permissions.
