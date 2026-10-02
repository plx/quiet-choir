---
name: quiet-choir
description: >-
  Author, run, monitor, and recover quiet-choir TypeScript workflows, including cross-project
  execution, Claude/Codex options, checkpoint inspection, and custom harness integration. Use for
  this local durable workflow engine; in Claude, also compare it with native Workflow.
---

# quiet-choir

## Run a first workflow against a project

The **directory you launch the CLI from is the run's working directory** and the default working
directory for agent calls. Relative workflow, state, and call paths resolve from it. Resume from
that same directory. `npm run cli` changes to the runtime checkout; use the absolute launcher below
for another project. Workflow paths are realpath-normalized, so equivalent path spellings work.

Installing this skill supplies documentation, not the runtime or harness binaries. Locate the user's
quiet-choir checkout; the plugin cache is not a workflow workspace. For initial build and imports,
see [setup](references/setup-and-cli.md#run-against-another-project).

Set `QC_CHECKOUT`, `QC_TARGET`, `QC_WORKFLOW`, and `QC_RUNS` to absolute paths: a built runtime
checkout, the target project, a trusted workflow file, and a state directory **outside the target
worktree**. Start with the local-only workflow below, which accepts `{}` and makes no paid calls.
Use a fresh run ID for each run; retain these paths for inspection and recovery. `workflow start`
runs the workflow in the background and returns once its record exists, so the `inspect` after it
reads the run; a failure before that (such as a type error) is reported by `start` itself. The
runner's result document and log go to `$QC_RUNS/first/launch/`, owner-only, and can hold plaintext
workflow output. `start` creates a missing `$QC_RUNS` owner-only but does not repair an existing
directory's permissions, so use a new or owner-only one.

<!-- skills-check: example golden-path -->

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow validate "$QC_WORKFLOW" --json || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow start "$QC_WORKFLOW" \
  --run-id first --state-dir "$QC_RUNS" --input '{}' --json || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow inspect first --state-dir "$QC_RUNS" --json --summary
```

Save this as `first.workflow.mts` outside the target worktree; replace its import with the absolute
checkout path. Import `z` from the runtime too; the target need not install Zod.

<!-- skills-check: example first-workflow -->

```ts
import { defineWorkflow, z } from '/absolute/path/to/quiet-choir/dist/index.js';

export default defineWorkflow({
  name: 'first',
  version: '1',
  input: z.object({}),
  output: z.object({ message: z.string() }),
  async run(ctx) {
    return ctx.step('greeting', {
      input: {},
      schema: z.object({ message: z.string() }),
      run: () => ({ message: 'Hello from a durable local step.' }),
    });
  },
});
```

Read [operating a run](references/operating-runs.md) next: inspection's exit 0 means it read a
record, not that the workflow completed. Use saved `status` and ownership to decide whether to wait,
recover, or inspect a failure.

<!-- skills-difference: claude-host -->

## quiet-choir, native Workflow, or inline?

In Claude Code, invoke `/quiet-choir:quiet-choir`. Every workflow-created harness session is
separate from the current conversation.

Choose quiet-choir for checkpoints in a directory you control, recovery from another shell, Claude
and Codex in one workflow, real Node I/O in durable steps, and Zod/compiler checks before agent
calls. Choose inline work for a few calls that will not need durable recovery.

Claude's [native Workflow](https://code.claude.com/docs/en/workflows) has integrated launch and
session-local management ([setup comparison #53](https://github.com/plx/quiet-choir/issues/53)) and
the `/workflows` progress surface ([progress #50](https://github.com/plx/quiet-choir/issues/50)).
Its scripts cannot directly access files, run shell commands, or use `import()`. Saved results can
be reopened by resuming their Claude session; a fresh session does not recover that journal. Native
replay reuses an unchanged call prefix; failed/stopped agents become `null`. quiet-choir now has
[code acceptance/forks #41](https://github.com/plx/quiet-choir/issues/41),
[settled fan-out #43](https://github.com/plx/quiet-choir/issues/43), a CLI dashboard/watch, and
[shared agent limits #47](https://github.com/plx/quiet-choir/issues/47).

Native Workflow limits total agent calls to 1,000 and parallel/pipeline lists to 4,096; its
concurrency is configurable. Its documented token-size warning is advisory, not a hard token
ceiling. quiet-choir now offers sticky run-wide gates on reported cost and agent attempts
([usage and budgets](references/usage-budgets.md)), checked before new work is admitted; attempts
with unknown cost are not counted toward the cost gate. The per-call Claude USD limit still applies,
and there is still no run-wide token ceiling.

## Launch in the background from Claude Code

To wait for a run without polling, start it and a bounded watch in one Bash call with
`run_in_background: true`. Claude Code notifies you when that command exits; read its output then
instead of checking in a loop. Give the watch a `--timeout` shorter than the background task's own
timeout (`8m` below is only an example), so the watch reports before the host stops it.

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow start "$QC_WORKFLOW" \
  --run-id review-42 --state-dir "$QC_RUNS" --input '{}' --json &&
  node "$QC_CHECKOUT/bin/run.js" workflow inspect review-42 --state-dir "$QC_RUNS" \
    --watch --final --json --summary --timeout 8m
```

`--final` makes the watch print one line. Read the **last stdout line**, not only the exit: a
document with `kind: "workflow.error"` is a failure, so branch on its `error.code`; otherwise it is
the watch's final snapshot, so branch on its `status`. A snapshot or failure that has a runnable
follow-up lists it in `next`; for 79 and 66, `next` is empty, so use the table below.

| Exit | Meaning                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| 0    | `completed`; the snapshot's `output` is the workflow output                                                   |
| 1    | `failed`; inspect the root cause, fix, and resume                                                             |
| 75   | `suspended`; answer its questions or deliver signals, or `workflow tick` when a wait is due                   |
| 130  | `cancelled`, or the watcher (or start) was interrupted (`workflow.interrupted`); the run may still be running |
| 3    | `stale`: the runner died; tick or resume it. From start, `run.exists` means the run ID was already used       |
| 79   | `watch.timeout`: the run is still running and continues; start another bounded watch the same way             |
| 66   | `watch.record_not_created`: only a watch without start, using `--wait-created`, for a run launched elsewhere  |

`workflow start`'s own failures end the `&&` chain before the watch runs, so the last line is then
start's error document: a usage error (2), `run.exists` (3), a type or import error (4),
`start.exited` (70) or `start.timeout` (124). That is why the exit alone is not enough. See
[operating a run](references/operating-runs.md) for the suspended-run loop and recovery.

<!-- /skills-difference: claude-host -->

## Choose the next task

| Task                                                                          | Reference                                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Locate/build the runtime, import it into another project, choose CLI flags    | [Setup and CLI](references/setup-and-cli.md)                   |
| Launch in the background, poll, diagnose stalls, recover orphaned children    | [Operating a run](references/operating-runs.md)                |
| Locate a run, classify its state, act on exact errors                         | [Inspection and triage](references/inspection.md)              |
| Park for readiness, a deadline, or an external signal                         | [Durable waits and tick](references/waits.md)                  |
| Write loops, fan-out, failure handling, or waits                              | [Verified patterns and traps](references/patterns.md)          |
| Isolate overlapping writers, share a checkout, integrate pinned changes       | [Worktrees](references/worktrees.md)                           |
| Run durable commands, publish text, or guard a mutation                       | [Commands and files](references/commands-files.md)             |
| Compose typed children, inspect frames, discover definitions by name          | [Child workflows and discovery](references/child-workflows.md) |
| Define schemas, compose steps, branch, map, and retry                         | [Workflow authoring](references/workflow-authoring.md)         |
| Control native configuration, environment, and checkout trust                 | [Harness isolation](references/harness-isolation.md)           |
| Select profiles, shared call options, identity, usage, or process limits      | [Agent calls](references/agent-calls.md)                       |
| Observe native activity, inspect transcripts, retain failed response evidence | [Agent streaming](references/agent-streaming.md)               |
| Inspect spend, understand token categories, stop new work at a run cap        | [Usage and budgets](references/usage-budgets.md)               |
| Select provider-specific controls or diagnose native protocol failures        | [Claude](references/claude.md), [Codex](references/codex.md)   |
| Rehearse with fixtures/dry-run before paying                                  | [Rehearsal](references/rehearsal.md)                           |
| Resume after failure, accept code edits, fork completed work                  | [Durability and resumption](references/durability.md)          |
| Embed the engine, log responses, implement a harness                          | [Embedding and extensions](references/extensions.md)           |

For exit 75, use the
[suspended-run answer loop](references/operating-runs.md#answer-a-suspended-run) or
[tick for due timers/polls](references/waits.md). Route human questions to the human; resume the
same run after delivery.

## Keep the execution contract

- Await durable operations and keep orchestration deterministic. Put nondeterminism and effects in
  `ctx.step`; do not nest durable calls inside its callback. Use stable, unique IDs and scopes.
- Resume with the same run ID, launch directory, state directory, name, version, and input. Omit
  `--input` to reuse saved input. Source/schema edits need explicit acceptance or a fork; native
  session IDs cannot resume the workflow.
- Rehearse agent work with `--dry-run --json`. Commands are synthesized; files/local
  callbacks/imports still run unless a step is explicitly stubbed. For worktree effects, use a
  fixture harness in a temporary repository instead: dry-run cannot simulate Git isolation. Native
  calls retain native authentication and default to restricted configuration; see
  [harness isolation](references/harness-isolation.md).
- Effects are at least once. Pass `idempotencyKey` to systems that support deduplication; native
  CLIs do not deduplicate edits with it. Checkpoints cannot undo mutations.
- This private 0.0.0 engine executes trusted TypeScript locally. Harness permission flags do not
  sandbox workflow code; there is no service or scheduler. Worktree isolation is explicit.
