# quiet-choir

quiet-choir is a local TypeScript workflow engine for agents. Workflows use ordinary loops and
branches around durable named effects: local callbacks, Claude Code calls, Codex calls, and sleeps.
Zod schemas define the data contracts. The installed harness CLIs provide authentication and agent
execution; quiet-choir owns checkpointing and replay.

This is a private, version 0.0.0 prototype. Resume restarts the workflow body and reuses completed
effects; it does not restore a JavaScript continuation or a native agent conversation. Effects are
at least once, and filesystem edits are not rolled back. There is no service, scheduler, distributed
worker, or automatic worktree isolation.

The public boundary is `src/index.ts`. The core owns orchestration and depends on the `Harness`
interface; adapters depend on that contract. CLI commands translate arguments into plain-data
plans/results and leave execution to framework-independent executors. See
[architecture](docs/architecture.md) and [decisions](docs/decisions/README.md) before changing these
boundaries.

Start with [README.md](README.md) for a runnable local example and
[CONTRIBUTING.md](CONTRIBUTING.md) for development checks. The
[agent reference skill](plugins/agents/quiet-choir/skills/quiet-choir/SKILL.md) routes to
operational details. Agent Plugins and Claude packages intentionally keep separate copies of their
skills; see [marketplace setup](docs/plugins.md). Keep instructions about the current runtime
distinct from proposals in research notes.
