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
For embedding, `await readRun(stateDir, runId)` returns the same validated record.

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

`running` is a persisted state, not proof of a live process. After a crash it may stay that way. A
long agent call or sleep also leaves `updatedAt` unchanged. Inspect process/lock ownership and the
sleep deadline before deciding a run is abandoned. Follow [recovery](durability.md) for locks and
orphaned children; timestamps alone do not justify removing a lock.

A failed run can have completed sibling effects. Those effects replay on a compatible resume; an
uncheckpointed external action may repeat. Failed steps contain error messages, not full transcripts
or guaranteed partial output. Run-level failures (for example final schema validation) need not
imply any step failed.

## Live events

Run with `--log-level debug` to log `step.started`, `step.completed`, `step.replayed`, and
`step.failed` events to stderr. `runWorkflow` also accepts a synchronous `onEvent(event)` callback:

```ts
onEvent: (event) => {
  process.stderr.write(`${event.type} ${event.stepId} attempt=${String(event.attempt)}\n`);
},
```

An event includes `type`, `runId`, `stepId`, and `attempt`. Notifications reflect persisted step
state; `step.replayed` refers to the existing completion and does not increment attempts. Observer
exceptions are ignored so they cannot invalidate execution. Notifications are not durably queued or
guaranteed to be delivered. `onEvent` is not a token stream, tool trace, or run-lifecycle event API;
use the returned record or checkpoint for final status.

Usage values come from the harness and may be null. Codex cost is always null in this adapter.
Stored successful-call usage does not include every failed/abandoned call and is not a complete
spending ledger. Replaying saved usage does not indicate a new charge.
