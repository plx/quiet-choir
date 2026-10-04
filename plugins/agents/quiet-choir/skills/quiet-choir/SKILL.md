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
| Port a native Workflow script: map agent, parallel, pipeline and budget       | [Native ports](references/porting-native-workflows.md)         |

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
- Rehearse agent work with `--dry-run --json`. Commands are synthesized unless the fixture file has
  exec rules (`workflow fixtures RUN` exports them from a real run); files/local callbacks/imports
  still run unless a step is explicitly stubbed. Fresh isolated agent calls and merges of their
  unchanged changes are synthesized (marked `worktree.synthesized` and listed under `merges`) with
  only a read-only `git rev-parse`; `ctx.worktree` and handle isolation still need a fixture harness
  in a temporary repository. Native calls retain native authentication and default to restricted
  configuration; see [harness isolation](references/harness-isolation.md).
- Effects are at least once. Pass `idempotencyKey` to systems that support deduplication; native
  CLIs do not deduplicate edits with it. Checkpoints cannot undo mutations.
- This private 0.0.0 engine executes trusted TypeScript locally. Harness permission flags do not
  sandbox workflow code; there is no service or scheduler. Worktree isolation is explicit.
