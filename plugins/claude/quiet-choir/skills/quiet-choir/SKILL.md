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

Claude's [native Workflow](https://code.claude.com/docs/en/workflows) runs JavaScript scripts of
Claude subagents inside the session. Choose by need:

| Need                 | Choose quiet-choir when                                                                                                                                                                                                                                                                                                                                     | Choose native Workflow when                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durability           | The run must outlive the session: its journal is in a state directory you choose, and any shell resumes it by run ID                                                                                                                                                                                                                                        | Resuming in the same Claude session is enough: `resumeFromRunId` reuses the session's journal, and a fresh session does not recover it                                                                                                                            |
| Harnesses            | Claude and Codex, or a custom harness, work in one workflow                                                                                                                                                                                                                                                                                                 | Claude subagents are all the workflow needs                                                                                                                                                                                                                       |
| I/O                  | Durable steps read files, run commands and call `gh` from Node                                                                                                                                                                                                                                                                                              | Agents can do all the I/O: a script has no filesystem, shell or `import()`, so each command needs an agent                                                                                                                                                        |
| Contracts            | Zod input, output and agent schemas are typechecked, and `workflow validate` runs before any paid call                                                                                                                                                                                                                                                      | A JSON Schema per agent, checked at its tool call, is enough                                                                                                                                                                                                      |
| Launch and observe   | You launch and follow from a shell or this session: `workflow start`, `inspect --watch`, `--events` with Monitor, or `/quiet-choir:run`                                                                                                                                                                                                                     | You want the integrated launch and the in-session `/workflows` progress view                                                                                                                                                                                      |
| Agent context        | Calls should see only what you give them: Claude runs [restricted](references/harness-isolation.md) by default, without CLAUDE.md or project instructions, MCP servers, user plugins or skills, or auto-memory, unless a profile opts back in with `mcpServers`, `settings`, `plugins`, `agents`, `systemPrompt`, `appendSystemPrompt` or an `inherit` role | Agents should get CLAUDE.md and the session's MCP tools                                                                                                                                                                                                           |
| Spend                | Sticky run-wide caps on reported cost and agent attempts fit; a reached cap is an operator stop that fails the run resumably, and a higher cap continues it. Cost is not a hard ceiling, and there is no token ceiling ([usage and budgets](references/usage-budgets.md))                                                                                   | You want a hard token ceiling: native `budget` is a hard ceiling, not advisory; once its total is spent, `agent()` throws, and the script can read `budget.remaining()`. Native also caps a run at 1,000 agents and 4,096 items per `parallel` or `pipeline` call |
| Failures             | A failure should throw and fail the run resumably, or settle as a recorded `Settled` with `onError: 'return'`                                                                                                                                                                                                                                               | A failed `agent()`, `parallel` thunk or `pipeline` stage should become `null`                                                                                                                                                                                     |
| External waits       | CI, reviews or a person: `ctx.poll`, `ctx.wait` or `ctx.ask` suspend the run (exit 75), and `workflow tick` or `workflow answer` resumes it ([durable waits](references/waits.md))                                                                                                                                                                          | Agents can wait in the session, looping until the condition holds                                                                                                                                                                                                 |
| Script edits mid-run | Edits should be explicit: `--accept-code-change` with identity checks, or a fork ([durability](references/durability.md))                                                                                                                                                                                                                                   | Relaunching should reuse the longest unchanged prefix of agent calls                                                                                                                                                                                              |
| Worktrees            | Each attempt gets a fresh checkout with `worktree: true`, changes are captured, and `ctx.merge` integrates them ([worktrees](references/worktrees.md))                                                                                                                                                                                                      | `isolation: 'worktree'` on an agent is enough                                                                                                                                                                                                                     |
| Rehearsal            | You want to try paths first with fixtures or `--dry-run`, at no model cost ([rehearsal](references/rehearsal.md))                                                                                                                                                                                                                                           | Runs are cheap enough to try live                                                                                                                                                                                                                                 |

Choose inline work, neither engine, for a few calls that need no recovery. To move a native script
to quiet-choir, read [porting native workflows](references/porting-native-workflows.md).

## Drive a run from Claude Code

To follow a run without polling, launch it and a bounded watch in one Bash call with
`run_in_background: true`, and follow its events file with the Monitor tool. Claude Code notifies
you when the background command exits, and Monitor notifies you for each matching event line. Do not
wrap the launch in `nohup` or `&`: the Bash task would end at once, and its exit notification would
no longer mean the run finished. Give the watch a `--timeout` shorter than the background task's own
timeout (`8m` below is only an example), so the watch reports before the host stops it.

<!-- skills-check: example claude-launch -->

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow start "$QC_WORKFLOW" \
  --run-id review-42 --state-dir "$QC_RUNS" --input '{}' \
  --events "$QC_RUNS/review-42.events.jsonl" --json &&
  node "$QC_CHECKOUT/bin/run.js" workflow inspect review-42 --state-dir "$QC_RUNS" \
    --watch --final --json --summary --timeout 8m
```

`--events FILE` appends one JSON line of at most 512 bytes per step, phase, log, wait and run event,
such as `{"t":"…","run":"review-42","ev":"step.failed","step":"review/2","attempt":1,"ms":5120}`.
The file is created owner-only, and an existing file keeps its mode, so use a new path or one under
an owner-only `$QC_RUNS`. Then start Monitor on that file with a `timeout_ms` (re-arm it the same
way if it expires before the run ends). The filter passes step failures, settled failures, opened
questions and every terminal run state; `-n +1` replays lines written before Monitor started, and
`-F` waits for a file that does not exist yet.

<!-- skills-check: example claude-monitor -->

```sh
tail -n +1 -F "$QC_RUNS/review-42.events.jsonl" |
  grep --line-buffered -E '"ev":"(step\.failed|step\.settled|wait\.opened|run\.(completed|failed|cancelled|suspended))"'
```

When the background task's completion notification arrives, stop the monitor with TaskStop and read
the task's output. `--final` makes the watch print one line. Read the **last stdout line**, not only
the exit: a document with `kind: "workflow.error"` is a failure, so branch on its `error.code`;
otherwise it is the watch's final snapshot, so branch on its `status`. A snapshot or failure that
has a runnable follow-up lists it in `next`; for 79 and 66, `next` is empty, so use the table below.

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
`start.exited` (70) or `start.timeout` (124). That is why the exit alone is not enough.

On 75, list the open questions with
`node "$QC_CHECKOUT/bin/run.js" workflow pending --state-dir "$QC_RUNS" --run review-42 --json` (the
snapshot names waiting steps, not their questions), map each `pending[]` entry to an AskUserQuestion
question, then relaunch in the background the same way, with the answer and a new bounded watch, and
re-arm Monitor:
`workflow answer review-42 STEP --json 'VALUE' --resume --events "$QC_RUNS/review-42.events.jsonl"`
chained with `&&` to the same `inspect … --watch --final --json --summary --timeout 8m`. On answer,
`--json VALUE` is the answer and also requests JSON output, so a refused answer is the last line.
The events file is not saved with the run, so pass `--events` again to every `answer --resume`,
`resume` and `tick`; the stream then continues in the same file, and a resume never repeats a line
for work that earlier executions already finished. See
[operating a run](references/operating-runs.md) for the suspended-run loop and recovery.

The plugin's `/quiet-choir:run WORKFLOW [--input JSON] [--run-id ID]` command packages this recipe:
it rehearses, launches, follows and answers in one flow. To follow a run this session did not
launch, or one started without `--events`, use
`node "$QC_CHECKOUT/bin/run.js" workflow events RUN --state-dir "$QC_RUNS" --follow` with the same
`grep` filter: it prints the same line shape from the run record without importing the workflow,
starts from the current end (`--from-start` replays the record first), and exits with the watch
codes above. After `answer --resume`, add `--after-execution N` with the suspended snapshot's
`execution`, so the follower waits for the resumed execution instead of stopping on the old status.

<!-- /skills-difference: claude-host -->

## Choose the next task

| Task                                                                          | Reference                                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Locate/build the runtime, import it into another project, choose CLI flags    | [Setup and CLI](references/setup-and-cli.md)                   |
| Launch in the background, poll, diagnose stalls, recover orphans, remove runs | [Operating a run](references/operating-runs.md)                |
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
