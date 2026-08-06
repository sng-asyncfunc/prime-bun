---
name: agent-observe
description: Read-only observation of an agent's parent, siblings, and direct children. Use to inspect family status and bounded recent-message previews without mutating sessions.
---

# Agent Observe

Observe the current agent's nuclear family through the local daemon: parent,
siblings, direct children, and self. Observation is currently limited to family
members in the same worker; root siblings in other workers are not observable yet.
This skill is read-only: it can list family sessions, inspect one session, and fetch
bounded recent message previews. It cannot prompt, steer, clear, kill, rename, or
otherwise mutate another session.

Call directly from the kernel:

```javascript
const children = await rlm.listSubagents();
const child = children.find((item) => item.activeSessionId);
if (child) {
  const worker = await agentObserve.getAgent(child.sessionName);
  const recent = await agentObserve.recentMessages(child.sessionName, { limit: 6 });
  // Deletion is a parent-owned RLM operation, not an observe mutation:
  await rlm.deleteSubagent(child);
}
```

## API

- `await agentObserve.listAgents()` returns `current` and `agents`. Each
  agent includes active session id, session id, optional name, runtime kind,
  cwd, status, streaming state, message count, pending count, and a latest
  message preview. The list is restricted to self, parent, siblings, and direct
  children. For direct children, `await rlm.listSubagents()` also exposes
  parent-owned lifecycle handles.
- `await agentObserve.getAgent(target)` returns `agent`, where `agent`
  contains one agent summary. `target` is resolved like other live-session
  selectors: active id, session id/name, or unambiguous suffix.
- `await agentObserve.recentMessages(target, { limit: 8, maxChars: 800 })`
  returns up to `limit` recent bounded message previews for the target session.
  `limit` must be 1-50, and `max_chars` must be 80-2000.

## Safety

- This skill is read-only and exposes no mutation commands.
- Targets outside the nuclear family are rejected; transcript reads follow the
  same family rule as messaging.
- Message access is bounded by count and per-message character limit.
- Prefer status and recent previews for orchestration. Ask the user before
  using observed context to steer or message another session.
