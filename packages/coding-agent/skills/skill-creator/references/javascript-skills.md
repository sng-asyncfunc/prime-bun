# JavaScript-Backed Skills

A JavaScript-backed skill is a regular markdown skill that also ships a TypeScript or JavaScript module. Prime Agent loads the module into the persistent Bun worker and exposes its value as a prepared global, so the agent can call it directly.

## Detection Contract

All of these must hold or the skill degrades to markdown-only with a load warning:

- `SKILL.md` exists as usual.
- `package.json` exists at the skill root and contains `primeAgent.entry` and `primeAgent.global`.
- `primeAgent.entry` is a relative path that stays inside the skill directory and names an existing module.
- `primeAgent.global` is a valid JavaScript identifier and does not collide with another prepared skill or a Bun/runtime global.
- The entry module exports `createSkill(context)` or a default value.

## Minimal Template

```text
word-count/
├── SKILL.md
├── package.json
└── src/
    └── index.ts
```

`package.json`:

```json
{
  "name": "word-count",
  "private": true,
  "type": "module",
  "primeAgent": {
    "entry": "src/index.ts",
    "global": "wordCount"
  }
}
```

`src/index.ts`:

```typescript
interface SkillContext {
  cwd: string;
  display(mimeType: string, data: unknown): void;
  hostRequest(type: string, payload?: unknown): Promise<unknown>;
}

export function createSkill(_context: SkillContext) {
  return (text: string, top = 5) => {
    const counts = new Map<string, number>();
    for (const word of text.toLowerCase().split(/\s+/)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, top);
  };
}
```

The kernel exposes `wordCount` and the agent calls it directly:

```javascript
wordCount("some text to analyze", 3);
```

## `createSkill(context)`

The factory runs once when the Bun worker initializes. It may return a function, object, class instance, or other value. Async factories are supported. Its context contains:

- `cwd`: the session working directory.
- `display(mimeType, data)`: emit a rich display payload to Prime Agent.
- `hostRequest(type, payload?)`: invoke a registered host bridge operation.

If a skill only needs pure computation, it can ignore the context. A default export is also accepted when a factory is unnecessary.

Failures do not prevent the Bun worker from starting. The global is bound to a placeholder that reports the module load error when used, and the session receives a diagnostic.

## Dependencies

Use normal package imports and declare runtime packages in `dependencies` or `optionalDependencies`. Prime Agent installs them automatically with Bun into a content-addressed cache under its managed kernel directory and exposes that cache to the worker. It does not create or update `node_modules` in the skill directory. Relative `file:` dependencies resolve from the skill root.

`installPackage()` is for ad hoc notebook helpers, not a substitute for a skill's declared dependencies.

Do not shell out to Python or add a `pyproject.toml`. JavaScript-backed skills must run entirely in Bun.

## Verifying a JavaScript Skill

1. Check the detection contract and confirm the global uses camelCase.
2. Start from a clean skill directory and let Prime Agent provision declared dependencies.
3. In a fresh agent session, verify the global is present and its common call path works.
4. Confirm a bad import produces a skill diagnostic without preventing ordinary JavaScript cells from running.
