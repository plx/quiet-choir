# Progress inspection

## Inspect without executing

From the runtime checkout, read a run while it is executing or after it stops:

```sh
npm run --silent cli -- workflow inspect recovery --json
# For a run stored elsewhere:
npm run --silent cli -- workflow inspect recovery --state-dir /path/to/runs --json
```

Inspection does not import the workflow or take the writer lock. Each read sees a persisted
checkpoint, not the live JavaScript stack. There is no watch command; repeat inspection if needed.
For embedding, `await readRun({ runId, cwd, stateDir })` returns the same validated record. Like
`runWorkflow`, it defaults to `<cwd>/.quiet-choir/runs` and resolves relative `stateDir` paths
against `cwd` (default: `process.cwd()`). `resolveStateDir({ cwd, stateDir })` returns the absolute
directory. A missing CLI inspection names that directory and lists the run IDs present; embedded
`readRun` retains the filesystem error's `code: 'ENOENT'`.

Checkpoints are `<stateDir>/<runId>.json`, with a sibling `<runId>.json.lock/` while owned. Prefer
`inspect` or `readRun` to validate data. A JSON inspection result has these useful fields:

| Field                                     | Interpretation                                                     |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `id`, `workflow.name`, `workflow.version` | Run and workflow identities                                        |
| `status`                                  | Last saved `running`, `completed`, or `failed` state               |
| `error`                                   | Last run failure message, or null                                  |
| `cwd`, `input`                            | Original execution directory and validated input                   |
| `createdAt`, `updatedAt`                  | Creation and last checkpoint timestamps; not heartbeats            |
| `steps`                                   | Object keyed by durable step ID; absent IDs have not been recorded |
| `output`                                  | Final workflow result; use only when the run is completed          |

Each step records `kind` (`step`, `claude`, `codex`, `sleep`), `status`, total `attempts`,
`fingerprint`, `output`, `error`, and `wakeAt` (epoch milliseconds for sleep, otherwise null). For
completed agent steps, `output` is the full `{ output, sessionId, usage }` wrapper: the model's
answer is at `steps[stepId].output.output`.

## Interpreting apparent stalls

`running` is a persisted state, not proof of a live process. A crash or checkpoint-write failure can
leave `status: "running", error: null`, even after an external action finished. A long agent call or
sleep also leaves `updatedAt` unchanged. Inspect process/lock ownership and the sleep deadline
before deciding a run is abandoned. Follow [recovery](durability.md) for locks and orphaned
children; timestamps alone do not justify removing a lock.

A failed run can have completed sibling effects. Those effects replay on a compatible resume; an
uncheckpointed external action may repeat. Failed steps contain error messages, not full transcripts
or guaranteed partial output. Run-level failures (for example final schema validation) need not
imply any step failed.

## Live events

Run with `--log-level debug` to log `step.started`, `step.completed`, `step.replayed`, and
`step.failed` events to stderr. `runWorkflow` also accepts an `onEvent(event)` callback returning
`void | Promise<void>`:

```ts
onEvent: (event) => {
  process.stderr.write(`${event.type} ${event.stepId} attempt=${String(event.attempt)}\n`);
},
```

An event includes `type`, `runId`, `stepId`, and `attempt`. Notifications reflect persisted step
state; `step.replayed` refers to the existing completion and does not increment attempts. Observer
synchronous exceptions and asynchronous rejections are ignored so they cannot invalidate execution.
Observers are not awaited and cannot delay effects or hold the run lock. Notifications are not
durably queued or guaranteed to be delivered. `onEvent` is not a token stream, tool trace, or
run-lifecycle event API; use the returned record or checkpoint for final status.

Usage values come from the harness and may be null. Codex cost is always null in this adapter.
Stored successful-call usage does not include every failed/abandoned call and is not a complete
spending ledger. Replaying saved usage does not indicate a new charge.

## Checkpoint and cleanup diagnostics

`CheckpointError` distinguishes storage operations (`save` or `release`) from workflow failures.
When both fail, the domain error leads the message; an `AggregateError` retains the checkpoint
errors in `errors` and the primary error in `cause`. Brief transient write errors are retried, but
persistent errors stop new effects. A successful action is never retried in-process because its
completion write failed. A later save can recover it; inspect the actual saved step before resume,
since an uncheckpointed action can repeat.

A persisted completion still succeeds if lock cleanup fails with `EACCES` or `ENOENT`. The CLI
prints a warning to stderr and includes `warnings` in the returned run (`--json`); embedding callers
receive `WorkflowRun.warnings`. These cleanup warnings belong to that invocation and are not saved
after ownership is released. Repair permissions or inspect the lock before another run. Changed or
unknown ownership remains an error. A removed state directory is named explicitly and is not
silently recreated. See [durability](durability.md) for recovery precautions.
