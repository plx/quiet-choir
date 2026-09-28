# Progress inspection

## Inspect without executing

After the [recovery example](durability.md), reuse its absolute `qc_state_dir` in the same shell:

```sh
npm run --silent cli -- workflow inspect recovery --state-dir "$qc_state_dir" --json
```

For another project, launch from that project and use
`node /absolute/path/to/quiet-choir/bin/run.js workflow inspect RUN_ID --state-dir /absolute/path/to/runs --json`,
substituting the actual paths and run ID. `npm run cli --` launches from the checkout even when
called in a subdirectory. Its launch directory is the base for relative paths, the run's recorded
`cwd`, and agent calls; resume must use the original directory. There is no CLI `--cwd` flag.

Inspection does not import the workflow or take the writer lock. Each read sees a persisted
checkpoint plus current OS ownership observations, not the live JavaScript stack. There is no watch
command; repeat inspection if needed. For embedding, `await readRun({ runId, cwd, stateDir })`
returns the validated checkpoint alone; `inspectRunOwnership({ runId, cwd, stateDir })` returns the
separate current ownership view. Like `runWorkflow`, it defaults to `<cwd>/.quiet-choir/runs` and
resolves relative `stateDir` paths against `cwd` (default: `process.cwd()`).
`resolveStateDir({ cwd, stateDir })` returns the absolute directory. A missing CLI inspection names
that directory and lists the run IDs present; embedded `readRun` retains the filesystem error's
`code: 'ENOENT'`.

Checkpoints are `<stateDir>/<runId>.json`, with a sibling `<runId>.json.lock/` while owned. The lock
also survives a hard kill, so it does not prove a live owner. A same-host resume checks durable
child records before recovering a dead/released owner. Live or unverified children refuse execution
(exit 3); explicit `--resume --kill-orphans` stops only birth-identity-confirmed survivors. A reused
PID is not signaled. Text inspection names the owner PID and state (`dead: stale lock` when
appropriate), then child binary, PID/group, step, attempt and state. JSON adds
`ownership: { locked, owner, processes, warning? }`; this field is not saved in the checkpoint.
Missing identities and malformed records are reported, never permission to kill. Foreign-host or
incomplete ownership needs inspection. Prefer `inspect` or `readRun` to validate data. `inspect`
exits 0 even for `failed` or `running` records; check `status`. A JSON inspection result has these
useful fields:

| Field                                     | Interpretation                                                     |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `id`, `workflow.name`, `workflow.version` | Run and workflow identities                                        |
| `status`                                  | Last saved `running`, `completed`, or `failed` state               |
| `error`                                   | Last run failure message, or null                                  |
| `cwd`, `input`                            | Original execution directory and validated input                   |
| `createdAt`, `updatedAt`                  | Creation and last checkpoint timestamps; not heartbeats            |
| `steps`                                   | Object keyed by durable step ID; absent IDs have not been recorded |
| `output`                                  | Final workflow result; use only when the run is completed          |

Checkpoint keys, events, and policy matches use the full scope/map/item/leaf ID. Local
`idempotencyKey` is `runId/fullId`; ID helpers do not hide or truncate checkpoint keys.

Each step records `kind` (`step`, `claude`, `codex`, `sleep`), `status`, total `attempts`,
`fingerprint`, `output`, `error`, and `wakeAt` (epoch milliseconds for sleep, otherwise null). For
completed agent steps, `output` is the full `{ output, sessionId, usage }` wrapper: the model's
answer is at `steps[stepId].output.output`.

Current records include run `policy`, `allowModelOverride`, and `policyWarnings`. Each step has
component `identity` hashes and `attemptHistory`: each attempt records its fingerprint, resolved
`policy`, value `sources`, `requestedModel`, `reasoningEffort`, `startedAt`, `finishedAt`, `status`,
and `error`. A `running` attempt has no saved settlement. Redefined unfinished steps retain old
hashes and change times in `redefinitions`; unvisited unfinished steps become `superseded` after a
successful body replay. Existing terminal outcomes still must be visited. Versions 1, 2, 3, and 4
can be inspected, but this format-5 runtime refuses their resumption or fork reuse.

`workflow.identity` holds code/schema/file hashes and engine metadata. `forkedFrom` identifies a
source snapshot, reuse mode, invalidation globs, intentional differences, and progress; each copied
step records `reusedFrom`. Its attempts/history describe the source work, not fresh target calls.
`seq` records first-use order in the target. `codeChanges` audits explicit source/schema acceptance;
`replayWarnings` captures ordering or lost-fork-source warnings. `recoveryHint` identifies a failed
run whose recorded effects all have terminal outcomes, so a tail-only fix may re-finalize with no
repeated work. Use `workflow check-resume FILE --run-id ID --json` to compare run gates without a
writer lock; it imports trusted source but does not call its body. Unlike inspection alone, it can
identify changed source files and schemas.

A `settled-failed` step is terminal: `settledError` saves `message`, `kind`, and total `attempts`.
Failed `attemptHistory` entries retain `errorKind`. A run may complete with settled failures.
`step.settled` follows a committed outcome; `replay.divergence` can include `healedStepId` and later
`skippedStepIds`.

## Interpreting apparent stalls

`running` is a persisted state, not proof of a live process. A crash or checkpoint-write failure can
leave `status: "running", error: null`, even after an external action finished. A long agent call or
sleep also leaves `updatedAt` unchanged. Inspect process/lock ownership and the sleep deadline
before deciding a run is abandoned. Follow [recovery](durability.md) for locks and orphaned
children; timestamps alone do not justify removing a lock.

A failed run can have completed sibling effects. Those effects replay on a compatible resume; an
uncheckpointed external action may repeat. Failed steps contain error messages, not full transcripts
or guaranteed partial output. Run-level failures (for example final schema validation) need not
imply any step failed. Start from `rootCause: { stepId, error }`, also shown by human inspection. A
map's initiating step stays `failed`; an interrupted sibling is `cancelled`, with a distinct
cancellation message and `cancelledBy` set to the initiating step ID (null for a mapper-body failure
or run interrupt). First Ctrl-C/SIGTERM/SIGHUP records run status `cancelled` and root cause
`{ stepId: null, error: 'Workflow interrupted.' }`. Completed or handled failures leave `rootCause`
null when the run completes. Resolved, validated actions still save success after abort.

`maps[id]` contains settled-map identity, status, and ordered item journals. Each committed item
stores `{ ok, value/error }` and its owned step/nested-map IDs. Those outcomes replay as a unit; a
child's `failed` status inside a committed item is diagnostic history, not a pending retry. Partial
journals retry only uncommitted mappers. Forks create new journals.

## Live events

Run with `--log-level debug` to log `step.started`, `step.completed`, `step.replayed`, and
`step.failed`, `step.cancelled`, `step.settled`, `step.redefined`, `step.superseded`, and
`step.reused` events to stderr. `runWorkflow` also accepts an `onEvent(event)` callback returning
`void | Promise<void>`. `replay.divergence` adds a message and `skippedStepIds`, and the CLI logs it
as a warning before live work; `--strict-replay` stops before the next live effect:

```ts
onEvent: (event) => {
  process.stderr.write(`${event.type} ${event.stepId} attempt=${String(event.attempt)}\n`);
},
```

An event includes `type`, `runId`, `stepId`, and `attempt`. Step notifications reflect persisted
step state; `step.replayed` refers to the existing completion and does not increment attempts.
Observer synchronous exceptions and asynchronous rejections are ignored so they cannot invalidate
execution. Observer promises are not awaited and do not keep the run lock held; synchronous observer
work still runs inline. Notifications are not durably queued or guaranteed to be delivered.
`onEvent` is not a token stream, tool trace, or run-lifecycle event API; use the returned record or
checkpoint for final status.

Usage values come from the harness and may be null. Codex cost is always null in this adapter.
Completed agent results store successful-attempt usage; failed protocol attempts can also store
available `sessionId` and `usage` in `steps[id].failedAttempts` after
[#33](https://github.com/plx/quiet-choir/issues/33). This still omits some failed/abandoned work and
is not a complete spending ledger. Replaying saved usage is not a new charge. Claude's top-level
input count excludes cache reads/writes and does not sum per-model usage; Codex's cache-inclusive
interpretation is inferred, not verified by a live cache comparison. See [Claude](claude.md) and
[Codex](codex.md) before comparing counts.

Both synchronous observer throws and observer promise rejections are handled, and `readRun` shares
execution's path resolution. Neither guarantee covers unowned async work that a workflow creates.

## Checkpoint and cleanup diagnostics

`CheckpointError` distinguishes storage operations (`save`, `release`, or `process`) from workflow
failures. When both fail, the domain error leads the message; an `AggregateError` retains the
checkpoint errors in `errors` and the primary error in `cause`. Brief transient write errors are
retried, but persistent errors stop new effects. A successful action is never retried in-process
because its completion write failed. A later save can recover it; inspect the actual saved step
before resume, since an uncheckpointed action can repeat.

A persisted completion still succeeds if the lock directory is already gone, if its removal fails
with `EACCES` or `ENOENT` after ownership was verified, or when unreaped child records retain a
released-owner lock. The CLI prints a warning to stderr and includes `warnings` in the returned run
(`--json`); embedding callers receive `WorkflowRun.warnings`. These cleanup warnings belong to that
invocation and are not saved after ownership is released. Repair permissions or inspect the lock
before another run. Changed ownership, or missing or unreadable ownership metadata in a remaining
lock, remains an error. A removed state directory is named explicitly and is not silently recreated.
See [durability](durability.md) for recovery precautions.

`agent.queued` and `agent.admitted` are live admission notifications, not checkpoint transitions.
They include `provider`, `inFlight` reserved-slot counts, `queued` waiter count, and `waitedMs`
(zero when requesting admission, actual monotonic wait when admitted). An immediate admission can
report queued=0. With an explicitly shared limiter, counts cover all sharing runs. A queued step is
already persisted as running; checkpoints do not distinguish waiting from native execution. Use
`limiter.snapshot()` for embedded live monitoring. Observer failures never own a slot.
