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
Use a fresh run ID for another independent run; retain these paths for inspection and recovery. The
redirected result and log can hold plaintext workflow output. `umask 077` affects only new paths, so
the recipe also tightens an existing `$QC_RUNS` and recreates the output files, keeping them
owner-only like the 0600 checkpoints.

<!-- skills-check: example golden-path -->

```sh
umask 077
mkdir -m 700 -p "$QC_RUNS"
chmod 700 "$QC_RUNS" || exit 1
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow validate "$QC_WORKFLOW" --json || exit 1
rm -f "$QC_RUNS/first.result.json" "$QC_RUNS/first.log" || exit 1
nohup node "$QC_CHECKOUT/bin/run.js" workflow execute "$QC_WORKFLOW" \
  --run-id first --state-dir "$QC_RUNS" --input '{}' --json \
  >"$QC_RUNS/first.result.json" 2>"$QC_RUNS/first.log" < /dev/null &
qc_runner_pid=$!
printf 'Runner PID: %s; log: %s/first.log\n' "$qc_runner_pid" "$QC_RUNS"
node "$QC_CHECKOUT/bin/run.js" workflow inspect first --state-dir "$QC_RUNS" --json --summary \
  || printf 'Record may still be loading; inspect again and read first.log.\n' >&2
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

Read [operating a run](references/operating-runs.md) next: startup can precede the first checkpoint;
inspection's exit 0 means it read a record, not that the workflow completed. Use saved `status` and
ownership to decide whether to wait, recover, or inspect a failure.

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
ceiling. quiet-choir's remaining run-wide spend/token controls are tracked in
[#62](https://github.com/plx/quiet-choir/issues/62); current limits are per call.

<!-- /skills-difference: claude-host -->

## Choose the next task

| Task                                                                       | Reference                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Locate/build the runtime, import it into another project, choose CLI flags | [Setup and CLI](references/setup-and-cli.md)                 |
| Launch in the background, poll, diagnose stalls, recover orphaned children | [Operating a run](references/operating-runs.md)              |
| Locate a run, classify its state, act on exact errors                      | [Inspection and triage](references/inspection.md)            |
| Park for readiness, a deadline, or an external signal                      | [Durable waits and tick](references/waits.md)                |
| Write loops, fan-out, failure handling, or waits                           | [Verified patterns and traps](references/patterns.md)        |
| Isolate overlapping writers, share a checkout, integrate pinned changes    | [Worktrees](references/worktrees.md)                         |
| Run durable commands, publish text, or guard a mutation                    | [Commands and files](references/commands-files.md)           |
| Define schemas, compose steps, branch, map, and retry                      | [Workflow authoring](references/workflow-authoring.md)       |
| Select profiles, shared call options, identity, usage, or process limits   | [Agent calls](references/agent-calls.md)                     |
| Select provider-specific controls or diagnose native protocol failures     | [Claude](references/claude.md), [Codex](references/codex.md) |
| Rehearse with fixtures/dry-run before paying                               | [Rehearsal](references/rehearsal.md)                         |
| Resume after failure, accept code edits, fork completed work               | [Durability and resumption](references/durability.md)        |
| Embed the engine, log responses, implement a harness                       | [Embedding and extensions](references/extensions.md)         |

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
  calls inherit installed CLI authentication and permissions.
- Effects are at least once. Pass `idempotencyKey` to systems that support deduplication; native
  CLIs do not deduplicate edits with it. Checkpoints cannot undo mutations.
- This private 0.0.0 engine executes trusted TypeScript locally. Harness permission flags do not
  sandbox workflow code; there is no service or scheduler. Worktree isolation is explicit.
