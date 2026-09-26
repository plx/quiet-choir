---
name: quiet-choir
description: >-
  Reference for quiet-choir TypeScript agent workflows. Use when authoring, running, inspecting,
  resuming, or extending quiet-choir workflows, or choosing its Claude Code and Codex call options.
  Covers this local engine, not generic orchestration or Claude's native workflow system.
---

# quiet-choir

quiet-choir runs ordinary TypeScript control flow around durable, named local effects and fresh
Claude Code/Codex sessions. Zod schemas validate inputs and results; local JSON checkpoints let an
interrupted run replay its body and reuse completed effects. `ctx.step`, `ctx.claude`, `ctx.codex`,
`ctx.map`, and `ctx.sleep` are the workflow API. The CLI typechecks, validates, executes, and
inspects runs. This is a private 0.0.0 prototype with at-least-once effects, not a distributed
service.

Use this as a reference: load the topics needed for the task, rather than every file. Installing
this skill supplies documentation, not the runtime or harness binaries. Locate the user's
quiet-choir checkout or installed dependency before running commands; the plugin cache is not the
workflow workspace.

## Reference contents

| Reference                                              | Read when                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [Setup and CLI](references/setup-and-cli.md)           | Locating the runtime, running a first workflow, choosing commands and flags                    |
| [Workflow authoring](references/workflow-authoring.md) | Defining schemas, composing steps, branching, mapping, and retrying local effects              |
| [Claude Code calls](references/claude.md)              | Choosing tools, budgets, turns, structured output, or diagnosing Claude failures               |
| [Codex calls](references/codex.md)                     | Choosing sandbox and reasoning settings, or diagnosing Codex protocol failures                 |
| [Durability and resumption](references/durability.md)  | Designing repeatable effects, resuming after failure, or investigating compatibility and locks |
| [Progress inspection](references/inspection.md)        | Reading checkpoints, observing live progress, or interpreting usage and errors                 |
| [Embedding and extensions](references/extensions.md)   | Implementing a harness, reusable workflow helpers, or agent plugin documentation               |

## Essential constraints

- Keep orchestration deterministic and await durable operations. Put nondeterminism and side effects
  inside steps; do not nest durable operations inside a step callback.
- Use stable, unique step IDs. Resume with the same run ID, working directory, code, version, and
  input. Native harness session IDs cannot resume a workflow.
- An external action may repeat after a crash. Use idempotency keys where supported; checkpoints
  cannot undo workspace mutations or guarantee exactly-once effects.
- Harness calls inherit CLI authentication/configuration. The workflow itself is trusted executable
  code; harness permission flags do not sandbox it.
