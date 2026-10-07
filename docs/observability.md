# Run observability

`workflow inspect ID` is a read-only dashboard. It shows the owner PID/liveness, latest body
execution's start and elapsed time, last persisted activity, current phase progress, status counts,
ordered running/failed/cancelled/settled-failed steps, resolved call limits, root cause, reported
usage, and the last five phase, log and tolerated poll error (`wait.tolerated`) entries; a tolerated
error prints its wait ID and the same message as its [event line](#event-stream). `-v` adds the
saved failure stack. It does not import workflow code or acquire the writer lock.

```sh
quiet-choir workflow inspect review-42 --state-dir /absolute/path/to/runs
quiet-choir workflow inspect review-42 --state-dir /absolute/path/to/runs --json --summary
quiet-choir workflow inspect review-42 --state-dir /absolute/path/to/runs --watch --interval 2s
quiet-choir workflow inspect review-42 --state-dir /absolute/path/to/runs --watch --json --summary
quiet-choir workflow list --state-dir /absolute/path/to/runs --status stale --json
```

`--json` alone retains the full checkpoint plus ephemeral `ownership`. `--json --summary` returns
the dashboard projection: `status`, `recordedStatus`, `execution`, `startedAt`, `elapsedMs`,
`updatedAt`, `lastActivityAt`, `lastActivityAgeMs`, `ownership`, `phase`, `counts`, ordered problem
`steps`, `rootCause`, `error`, `errorStack`, `output`, `agents`, `usage`, `recent`, `harnesses`, and
`warnings`, alongside run/workflow identities. `output` is the workflow's output once the recorded
status is `completed` and null otherwise, so a watch's final snapshot carries it. `agents` is
`{ total, byRequest, recent }` for claude, codex and agent calls (fork-reused calls excluded):
`byRequest` counts steps and sums reported cost per requested harness, model, effort and profile;
`recent` holds the last 50 calls as
`{ id, status, harness, model, effort, profile, elapsedMs, costUsd }`. `model` is the requested
model, never assumed effective, and null means native configuration; `effort` can be `inherited` or
null for older records. Completed step payloads are omitted from the summary, and text shows a
completed command on one line (`completed ID  git status 2s`) and only the last 20 completed agent
calls; `-v` restores the two-line command form, with absolute argv and cwd, and every recent agent
row. Failed, running and waiting commands always print in full. Older records lack some
measurements; inspection leaves those fields unknown rather than reconstructing execution.

A saved `running` run with no lock or a dead/released owner is shown as `stale`, and
[`workflow tick`](waits.md#suspension-and-tick) recovers it unless live or unverified children
remain, up to its crash-loop cap. Remote or unverifiable ownership remains `running` with its
ownership diagnostics. A lock alone does not prove liveness. Inspection uses the existing same-host
PID and available birth-identity checks; it never signals a process or recovers a lock. Timestamps
are not heartbeats. A quiet agent call can leave `updatedAt` unchanged for minutes.

## Watch and list

`--watch` polls every two seconds by default; `--interval` accepts an `ms`, `s`, or `m` suffix, from
1ms through 2147483647ms. Text redraws on changes in a terminal and appends snapshots through a
pipe. JSON mode is **JSONL**, one document per checkpoint/ownership change; elapsed time alone does
not produce another line. Use `--summary` for compact status snapshots. Intermediate writes between
polls can be missed: this is an inspection loop, not a durable event stream.

Watch ends with a final snapshot and exits 0 for completed, 1 for failed, 75 for suspended, 130 for
cancelled, or 3 for stale. A run interrupted by a first signal or a tick deadline is saved as a
resumable suspension, so its watcher ends as suspended with exit 75, and the summary's
`interruptedBy` (text: `Interrupted at …`) names the reason. It emits no extra error document merely
because the observed run failed. A missing or unreadable run uses the ordinary JSON error contract.
Interrupting the watcher exits 130 with an error document after any prior snapshots, and leaves the
observed workflow running. Non-watching inspection exits 0 for every readable status.

Watch has no time bound unless asked. `--timeout DURATION` (an `ms`, `s`, `m` or `h` suffix) stops a
watch whose run is still running that long after the first successful read: it exits 79 with a
`watch.timeout` error document whose `status` is the last observed one (`running`) and whose
`details.timeoutMs` is the bound. The run keeps running and is never touched; start another bounded
watch to keep waiting. `--wait-created DURATION`, measured from the start of the watch, retries a
missing record at the interval until the first successful read, for a watch started right after a
detached launch. When it expires the watch exits 66 with `watch.record_not_created`, `status: null`
and `details.waitCreatedMs`; a record that disappears after it was read is still `run.not_found`
(exit 3). Each bound sleeps at most until its deadline and reads once more there, so a run that
finishes at the deadline is reported as finished and the watch ends within one read after it.
`--final` prints only the final snapshot, or only the error document on a bound, an interrupt or a
missing record, so a host can read the outcome from one line. With `--summary`, error documents
carry the compact `summary` instead of the whole `run`.

`workflow list` reads checkpoint filenames, sorts newest `updatedAt` first, and supports `running`,
`failed`, `completed`, `cancelled`, and `stale` filters. Unreadable checkpoints are skipped with a
stderr warning. JSON returns `{ kind: 'workflow.list.result', ok: true, stateDir, runs, warnings }`;
`runs` contains compact rows (`id`, `workflow`, `status`, `recordedStatus`, `counts`, `updatedAt`,
`ownership`, `nextWakeAt`, `cwd`, `stateDir`, `warnings` and `usage` with `attempts`, `costUsd`,
`inputTokens`, `outputTokens`, `unknownTokenAttempts` and `unknownCostAttempts`); `--json --full`
returns whole summary objects. A missing state directory gives an empty list. Neither list nor watch
imports source.

## Event stream

`--events FILE` on `workflow execute`, `start`, `resume`, `tick` and `answer --resume` appends one
compact JSON line per step, phase, log, wait and run event, so a host can follow a run with a
line-buffered filter instead of polling snapshots. `--events -` writes the lines to stdout instead
(not on `start`, and not with `--json`; see [the CLI contract](cli-contract.md#event-stream)).

```sh
quiet-choir workflow execute review.workflow.ts --run-id review-42 --events /abs/review-42.events.jsonl
tail -n +1 -F /abs/review-42.events.jsonl | grep --line-buffered '"ev":"step.failed"'
```

```json
{
  "t": "2026-10-01T12:00:03.512Z",
  "run": "review-42",
  "ev": "step.failed",
  "step": "review/2",
  "attempt": 1,
  "harness": "claude",
  "ms": 5120,
  "phase": "verify",
  "msg": "Schema validation failed: expected an array of findings"
}
```

| Field     | Meaning                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t`       | ISO event time                                                                                                                                                                                                                                                                                                                                                      |
| `run`     | Run ID                                                                                                                                                                                                                                                                                                                                                              |
| `ev`      | Event type                                                                                                                                                                                                                                                                                                                                                          |
| `step`    | Full step ID; on `run.failed`, the root effect when known; on `wait.tolerated`, the wait ID                                                                                                                                                                                                                                                                         |
| `attempt` | Persisted attempt count, on `step.failed` and `step.settled` only                                                                                                                                                                                                                                                                                                   |
| `harness` | The event's harness, or the one last seen on an agent event for this step in this process                                                                                                                                                                                                                                                                           |
| `ms`      | Step events: time since the step's latest start in this process. Terminal run events: time since this execution's `run.started`. Omitted when no start was seen in this process                                                                                                                                                                                     |
| `costUsd` | Reported cost of a completed agent step, when known                                                                                                                                                                                                                                                                                                                 |
| `phase`   | Phase at the call site                                                                                                                                                                                                                                                                                                                                              |
| `msg`     | The run error, phase title or lifecycle message; on `step.failed` and `step.settled`, the step's error text (single line, no stack); for `log`, the message plus the compact JSON of its data; for `wait.opened`, the compact JSON of the question; for `wait.tolerated`, `tolerated N/LIMIT: message`, with ` [code]` after LIMIT when the error had a string code |

Fields are written in this order, and absent or null fields are omitted. The written types are
`run.started`, `run.completed`, `run.failed`, `run.cancelled`, `run.suspended`, `step.completed`,
`step.failed`, `step.settled`, `wait.opened`, `wait.tolerated`, `phase` and `log`; agent admission
and progress, child, `step.started` and `step.cancelled` events are not written. `msg` is cut at a
code point with a trailing `…` to about 200 bytes, so a typical line is near 300 bytes, and no line
exceeds **512 bytes** (UTF-8, without the newline): a longer line shrinks `msg` further, then
shortens `step` and `phase` in the middle, then `run`. A `step.failed` or `step.settled` line
carries the step's error text as `msg` (the message of the failure, never its stack). The runner
first bounds it to one line, with newlines and whitespace runs collapsed to single spaces, anything
from the first stack-frame line (`at ...`) on dropped, and at most 500 characters (code points,
ending in `…` when cut); the usual 200-byte `msg` budget then applies. An empty message writes no
`msg`. The full text and the stack stay in the run record and `inspect`. The text is whatever the
step threw, so a workflow that puts a sensitive value in an exception message now sees it in the
events file (created owner-only) as well as in the record. Another error a line carries is a poll
error that the poll's `onError` tolerated: each one writes a `wait.tolerated` line naming the wait,
the consecutive count and the `tolerate` limit, such as `tolerated 2/3: HTTP 502: Bad Gateway`
([tolerated poll errors](waits.md#checks-and-outcomes)). The error past the limit is not tolerated
and writes no such line; it fails the wait as before.

Replay echoes are dropped: a resume does not write `step.replayed`, `step.reused` or a replayed
phase or log entry, because the earlier execution already wrote them to the same file. Each
execution writes its own `run.started` and terminal run line.

The file is opened for append and created owner-only (0600); an existing file keeps its mode, so use
a new path or one in an owner-only directory. Each line is one write, flushed at once without an
fsync: the stream is an observation, not durable state. If the file cannot be opened or a write
fails, the command logs one `Events: …; further events are not written.` warning and the run's
outcome and exit code are unchanged. The flag is per invocation and is not saved with the run: pass
it again to every `resume`, `tick` and `answer --resume` that should continue the stream. It works
with `--dry-run`, for rehearsing a filter. See [ADR 0037](decisions/0037-compact-event-stream.md).

### Following a run without its events file

`workflow events RUN [--follow]` prints the same lines for a run this process did not launch, or one
started without `--events`. It reads the run record with the code-free reader `inspect` uses, never
imports the workflow, and derives each line from what the record keeps:

- **Run events.** Every entry of the record's event list (run lifecycle, `phase` and `log`) becomes
  one line. `run.failed` carries its root step and error message.
- **Tolerated poll errors.** Each tolerated poll error is a `wait.tolerated` entry in the same event
  list, saved with the wait's `lastError`, so it becomes one line in order before the wait settles.
  It shares the 500-entry cap below with phase and log entries.
- **Step attempts.** Every completed attempt becomes `step.completed`, every failed one
  `step.failed`, and the final attempt of a settled failure `step.settled`, as the runner emits
  them, the failed ones with that attempt's recorded error as `msg`, bounded as above, so two
  attempts show their own messages. Cancelled and interrupted attempts write nothing, and
  fork-reused steps are skipped. Questions and waits, which have no attempt history, settle from the
  step itself.
- **Questions.** A question whose notification was recorded becomes `wait.opened` at that time, with
  the question as `msg`.

Fields the record cannot supply are omitted, not guessed. Live-only `agent.*` events are not
persisted, so `harness` comes from the step's kind and registration rather than an agent event, and
`ms` is the **recorded** attempt or execution duration, where `--events` measures time in its own
process. `costUsd` appears on `step.completed` of an agent step that reported a cost. The message of
an older execution's `run.suspended` is omitted, because only the latest interruption is recorded.

The follower polls every two seconds by default (`--interval`). Several transitions that happen
between two reads, including several attempts of one step, all appear on the next read, sorted by
time with the latest execution's terminal run line last. Lines are deduplicated by identity (run
event content, wait ID and time, step and attempt, question and notification time), not by position,
so a long run whose oldest entries are evicted neither repeats nor hides newer lines. The record
keeps only the latest **500** run events: on a very long run, phase, log and tolerated poll error
payloads can be evicted before a slow follower reads them, and those lines are then never printed; a
poll that tolerates errors often over a long time adds to that pressure. Step and question lines are
not subject to that cap. See [the CLI contract](cli-contract.md#event-follower) for the flags and
exit codes and [ADR 0038](decisions/0038-code-free-event-follower.md) for the design.

## Phases and logs

```ts
ctx.phase('discover', { total: 2 });
ctx.log('Scanning inputs', { count: inputs.length });
await ctx.phase(
  'verify',
  async () => {
    await ctx.map('items', inputs, { concurrency: 4 }, async (item) => {
      await ctx.claude.text('review', { prompt: item });
    });
  },
  { total: inputs.length },
);
```

The synchronous phase lasts until the next phase in that phase context. The scoped overload uses
AsyncLocalStorage, so concurrent scoped phases and their map workers remain independent. A bound
`ctx.within` forwards these methods without capturing a stale phase. Steps capture phase attribution
at invocation, before asynchronous request preparation. The run's current phase is the most recently
entered active scoped phase, or the root phase after scopes leave. Progress counts completed and
running steps carrying the same label; use distinct labels when separate counters matter. `total` is
descriptive, not an execution constraint. A scoped phase's returned promise is owned like other
workflow operations: await it to handle failures.

Phase/log calls are observations, not durable effects: no IDs, fingerprints, skipped-step checks, or
fallback decisions. Log data must be lossless JSON. Invalid phase/log calls are authoring errors
that fail the run even inside a settled map, so the item reruns on resume; a scoped phase body's own
errors remain ordinary failures. The runner owns their asynchronous writes, coalesces synchronous
bursts into a snapshot, drains writes before releasing the lock, and treats storage failure as
infrastructure failure. They are echoed to stderr at info level and delivered through `onEvent`
after a successful save.

On resume, the kth identical phase/log entry is a replay if an earlier execution recorded a kth
entry with the same type, message, data, and phase metadata. It is echoed with `(replay)` and
`replayed: true`, without appending another payload. Counts are independent of concurrent ordering;
logs inside a mapper skipped by a settled-map replay do not execute or echo. Changing observations
does not change effect identity, though source changes still need the ordinary resume code gate.

Only the most recent **500** lifecycle/phase/log/tolerated poll error payloads are retained. A
`wait.tolerated` entry is a runtime observation, not a body call: it never enters the count ledger
and is never replayed. Compact signature/count entries survive eviction to preserve replay
detection. That count ledger and attempt histories can still grow; high-volume logging remains
unsuitable for this whole-file checkpoint store. The future journal work is separate. There is no
token or tool transcript here.

## Timing, requests, errors, and usage

New format-6 records extend the existing `seq`, cancellation status, and `attemptHistory` fields.
They do not add a duplicate `history` array or `cancelled` boolean. Each step records its latest
`phase`, `startedAt`, `finishedAt`, monotonic `durationMs`, resolved `request`, and `errorStack`.
Attempts retain execution number, timing, reported usage, request, outcome, error, and stack, along
with their existing policy and provenance. The latest attempt duration includes admission and
checkpoint-start waiting; the call's timeout starts only when admitted. Inspection labels these
separately. A crash can leave a running attempt with no finish time. Earlier history stays
unchanged.

Request summaries contain harness, explicit model (null means inherited native configuration),
profile, effective timeout/turn/budget/sandbox/cleanup limits, tools, cwd, structured-output flag,
SHA-256 of the UTF-8 prompt, and its first 200 UTF-16 code units. These diagnostics are outside
semantic identity. **Checkpoints contain prompt previews, log data, and stack paths; treat them as
sensitive.** They are local private files under the existing storage permissions.

`executions` records each actual workflow-body invocation, its PID, start/end, outcome, error and
stack. Reading a completed run through the resume fast path adds no execution. Historical `running`
entries are not rewritten as guessed crashes. `events` records run lifecycle, phase, and log
entries; step transitions remain live notifications backed by step/attempt state. All
`WorkflowEvent`s carry `at`, `execution`, and `runId`. Run/phase/log notifications use attempt 0 and
a null `stepId`, except `run.failed` can name the root effect. `step.failed` and `step.settled` also
carry `error`, the step's error text bounded to one line of at most 500 characters
(`STEP_EVENT_ERROR_MAX_CHARS`, ending in `…` when cut) with no stack, and absent when the message is
empty; `message` keeps its other meanings. Debug lines include timestamp, run ID, and event type.
Notification data is copied; observer mutation or failure cannot invalidate committed work, and
observer promises are not awaited.

`rootCause` is `{ stepId, error, errorKind, effect }`: `errorKind` is the classified kind of the
root effect's failure, null for a body failure, and absent in records from before the field.
`effect` is the root step's call-site effect kind (the harness name for an agent call, otherwise the
step kind such as `step`, `exec` or `read-file`), recorded even when the failure came before the
step had a record; it is null for a body failure or interruption and absent in older records. It
uses error identity and cause chains, not message matching. It attributes diagnostics; it never
decides durable error handling. Explicitly cancelled siblings keep `status: 'cancelled'`, while
valid late callback results still commit as completed. Run interrupts have no root effect; a marked
interruption saves no `rootCause` or `error` at all, only `interruptedBy`. `WorkflowRunError`
exposes `runId`, `stepId`, saved `run`, and original `cause`, with a message such as
`Step word/1 (claude) failed: …`; the kind comes from the step record, then `rootCause.effect`. `-v`
on execute or inspect prints the stored stack/cause chain.

Usage totals come from exported `summarizeUsage(run)`: one entry per local agent attempt, including
failed and interrupted work, with replay counted once and fork reuse excluded. Text includes
harness/model breakdowns and unknown counts. Full `inspect --json` adds `usageSummary`; compact JSON
retains `usage`. Known portions are summed, all-unknown stays null, and no attempts totals zero.
`unknownUsageAttempts`, `unknownTokenAttempts` (no input or output count), `unknownCostAttempts`,
and per-category `unknownTokens` describe gaps. The text headline says
`(partial; N/M attempts without token usage)` when tokens are missing, adding
`; cost unreported for K/M` for cost gaps, and `(tokens complete; cost unreported for K/M attempts)`
when only cost is missing. Legacy history fallback sets `undercounted`; legacy token semantics warn
separately. Requested model aliases are never assumed effective. See
[usage and budgets](usage-and-budgets.md) for measurement categories, raw evidence, caps, and their
limitations.

Storage format 7 retains replay contract 6. Flat format-6 runs migrate automatically on resume;
original format 1 migrates by verifying its legacy step identities and must migrate before fork
reuse. Formats 2–5 remain inspection-only here. See [storage migration](storage.md#legacy-records).
Effect IDs and semantic fingerprints are unchanged by the added diagnostics.
