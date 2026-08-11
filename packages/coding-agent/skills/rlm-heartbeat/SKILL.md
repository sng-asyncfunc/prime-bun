---
name: rlm-heartbeat
description: Manage agent-owned RLM heartbeats from the Bun REPL. Use when the user asks the agent to start, create, schedule, or manage a heartbeat, unless they explicitly request the user's /heartbeat.
---

# RLM Heartbeat

RLM heartbeats are internal recurring prompts for the current agent session.
They are separate from the user's visible `/heartbeat`: this skill cannot read,
replace, pause, resume, or clear that user-level heartbeat.

`rlmHeartbeat` is a method-only object, not a callable function. Use its
documented methods directly from Bun:

```javascript
await rlmHeartbeat.create("check test progress", { interval: "5m", label: "tests" });
await rlmHeartbeat.create("watch build", { deliveryMode: "follow_up" });
await rlmHeartbeat.list();
await rlmHeartbeat.update("job-id", { status: "pause" });
await rlmHeartbeat.delete("job-id");
```

## API

- `await rlmHeartbeat.list({ includeInactive }?)` — list this session's
  internal RLM heartbeats. By default this includes active and paused entries.
- `await rlmHeartbeat.create(instruction, { interval, label, deliveryMode }?)` — create a recurring heartbeat for this session. The
  default interval is every 5 minutes. Multiple RLM heartbeats may run at once;
  use labels to distinguish them. `deliveryMode` is `"steer"` (default) or
  `"follow_up"`.
- `await rlmHeartbeat.update(id, { instruction, interval, label, status, deliveryMode }?)` — update one RLM heartbeat by id. `status`
  may be `"pause"` or `"resume"`; `deliveryMode` may be `"steer"` or
  `"follow_up"`.
- `await rlmHeartbeat.delete(id)` — cancel one RLM heartbeat by id.

## Delivery mode

Each heartbeat has a delivery mode controlling how the scheduled prompt reaches
the session when it is busy:

- `steer` (default): interrupt the current turn so the heartbeat runs promptly.
- `follow_up`: wait for the current turn to finish before running the heartbeat.

## Rules

- Use this when the user asks you to start, create, schedule, or manage your own
  heartbeat without explicitly referring to `/heartbeat`.
- Use this only for agent-internal recurring checks and long-running task
  coordination.
- Do not use this skill to satisfy a user's request to configure `/heartbeat`;
  that is a separate user-level surface.
- Do not call `rlmHeartbeat(...)` or use this skill to wait for subagent
  messages or to end a turn. Stop calling tools and end the turn instead.
- Keep heartbeat instructions specific and actionable so each recurring turn
  knows exactly what to inspect or continue.
