<p align="center">
  <a href="https://primeintellect.ai">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/40c36e38-c5bd-4c5a-9b34-f7b902cd155d">
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8">
      <img alt="Prime Intellect" src="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8" width="312" style="max-width: 100%;">
    </picture>
  </a>
</p>

<h3 align="center">
Prime Bun: A Bun-Native RLM Agent
</h3>

<p align="center">
  <a href="packages/coding-agent/docs/index.md">Documentation</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/verifiers">Verifiers</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/prime-rl">PRIME-RL</a> &bull;
  <a href="https://github.com/badlogic/pi-mono">pi-mono</a>
</p>

<p align="center">
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml/badge.svg" alt="Build Binaries" />
  </a>
</p>

<p align="center">
  <img src="assets/brand/prime-bun-hero.png" alt="Prime Bun Agent: Bun-native JavaScript RLM" width="960" style="max-width: 100%;">
</p>

## Bun-native by design

Prime Bun replaces the Python notebook with a native Bun implementation. RLM programs execute as persistent JavaScript or TypeScript directly in Bun—not through a Python wrapper or subprocess bridge—with retained session state, prepared runtime globals, native shell execution, abort and recovery handling, and snapshot support.

Lower is better. **Bun faster** is the reduction in elapsed time relative to the Python implementation.

| Operation | Bun | Python | Bun faster |
|---|---:|---:|---:|
| Startup | 57.8 ms | 789.4 ms | 92.7% |
| Scalar cell | 2.07 ms | 2.96 ms | 30.1% |
| 64 KiB output | 1.77 ms | 3.10 ms | 42.9% |
| 10,000 writes | 3.20 ms | 14.98 ms | 78.6% |
| Native shell | 1.38 ms | 9.13 ms | 84.9% |
| Abort | 146.5 ms | 175.7 ms | 16.6% |
| Recovery | 2.55 ms | 3.30 ms | 22.7% |
| 32 MiB snapshot | 23.31 ms | 38.31 ms | 39.2% |

> [!NOTE]
> Prime Bun is a fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent). All credit for the original agent, RLM architecture, TUI, and surrounding ecosystem goes to Prime Intellect and the Prime Agent contributors. Their thoughtful and ambitious work created an exceptional open-source foundation; this fork focuses on a Bun-native JavaScript and TypeScript runtime.

Prime Bun builds on Prime Agent, an open-source coding and research agent for general and long-running work. It preserves two core abstractions:

- The **[Recursive Language Model (RLM)](https://www.primeintellect.ai/blog/rlm)** treats context as variables (*prompt-as-a-variable*) and tools like recursive subagents as function calls (*programmatic tool /sub-agent calling*) inside a persistent REPL.
- The **[Continual Harness](https://arxiv.org/abs/2605.09998)** stores supplemental prompts, memories, skill descriptions, and reusable subagent specifications as durable state that Prime Agent can refine through small, evidence-backed updates, local to the session by default.

Prime Bun combines a persistent Bun JavaScript control environment with durable harness state, so useful working context and reusable operating patterns can outlive a single chat window.

- **Everything is programmatic:** the persistent Bun notebook is the built-in model tool; file operations, shell commands, skill use, subagents, and context management happen through JavaScript or TypeScript.
- **Subagents are built in:** `rlm(...)` spawns real child agents for parallel or background work and returns an admission handle; results arrive through explicit agent messages or files.
- **The harness can improve:** `/refine` reviews the current trajectory and can apply small, evidence-backed updates to supplemental harness state. It never rewrites the immutable base system prompt, and recorded snapshots support rollback.
- **Skills are executable:** JavaScript-backed skills load prepared globals into the notebook, and the built-in skill creator can turn recurring workflows into project or personal skills.
- **Sessions run in the background:** daemon-backed agents keep running when the terminal disconnects and can be reattached later.
- **Agents communicate directly:** running agents can exchange messages and orchestrate one another without routing everything through the user.
- **Long tasks keep moving:** automatic compaction, persistent goals, heartbeats, schedules, autonomous mode, and retained subagents preserve progress across turns and terminal sessions.

## Getting Started

Install the latest stable release on macOS or Linux:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

The installer downloads a versioned release, verifies its SHA-256 checksum, installs the `prime-agent` command, and can prepare the Bun runtime used by the agent.

Start Prime Agent from the repository or directory you want it to work in:

```bash
cd /path/to/project
prime-agent
```

On first launch, run `/login` to choose a subscription or API-key provider. Prime Agent works in the current directory and can run commands and modify files there. Use a disposable clone, clean worktree, or another checkpoint you can inspect and restore.

> [!WARNING]
> Prime Agent executes model-generated JavaScript, TypeScript, and project commands with your user permissions. Its worker and notebook processes improve lifecycle isolation and recovery; they are **not** a security sandbox. Review changes and use trusted repositories, instructions, skills, and extensions only. Run untrusted code or instructions in an external sandbox or restricted environment.

Useful commands:

```bash
prime-agent agents                   # Browse running, idle, and saved sessions
prime-agent attach <agent>           # Reattach to a running session
prime-agent --resume <path|id>       # Resume a saved session
prime-agent status                   # Inspect background service state
prime-agent doctor [--fix]           # Inspect or repair background services
prime-agent update [--force]         # Update Prime Agent
prime-agent shutdown [--force]       # Stop every agent, worker, and background service
```

## Built for Long-Running Work
Prime Agent is built for long-running work, especially for evaluations in research. These features are available in the TUI, and when run autonomously. 

- **Continual Harness:** `/refine` can persist focused, reviewable lessons as supplemental prompts, memories, reusable skill descriptions, or subagent specifications, with recorded refinement history. It does not replace packaging and reviewing new executable skills.
- **Direct agent-to-agent communication:** running agents and retained subagents can discover one another, exchange messages, and steer active work.
- **Daemon-backed continuity:** active sessions, Bun notebook state, schedules, and subagents keep running when the terminal detaches and can be reattached later.
- **Heartbeats and schedules:** `/heartbeat`, `rlmHeartbeat`, and `prime-agent schedule` can re-enter a session periodically or at a specific time.
- **Persistent goals:** `/goal` keeps an objective and its progress active across turns until it is completed, paused, or cleared.
- **Bounded autonomous mode:** `/autonomous` continues within configured turn, token, and time budgets and can run user-defined quality gates. A passed gate checks only what that gate verifies; reaching a limit does not imply task success.

## Documentation

- [Quickstart](packages/coding-agent/docs/quickstart.md) — install, authenticate, and run a first session
- [Usage and CLI reference](packages/coding-agent/docs/usage.md) — commands, sessions, autonomous limits, and output modes
- [Long-running and background agents](packages/coding-agent/docs/long-running-agents.md) — detach and reattach, goals, heartbeats, and schedules
- [RLM programming model](packages/coding-agent/docs/rlm.md) — persistent Bun execution, subagents, skills, and the trust model
- [JSON mode](packages/coding-agent/docs/json.md) and [RPC mode](packages/coding-agent/docs/rpc.md) — headless automation and integrations
- [Skills](packages/coding-agent/docs/skills.md) — install and create reusable capabilities
- [Provider setup](packages/coding-agent/docs/providers.md) — subscription and API-key providers
- [Architecture overview](packages/coding-agent/docs/architecture.md) — daemon, worker, notebook, and persistence boundaries
- [Development](packages/coding-agent/docs/development.md) — build and run from source

## Acknowledgements

Our agent and TUI is built on top of [`pi`](https://github.com/earendil-works/pi). We thank the authors of `pi` for their valuable work.

## License

Prime Agent is fully open source and released under the [MIT License](LICENSE).
