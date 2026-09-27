# Run observability

`workflow inspect ID` is a read-only dashboard. It shows the owner PID/liveness, latest body
execution's start and elapsed time, last persisted activity, current phase progress, status counts,
ordered running/failed/cancelled/settled-failed steps, resolved call limits, root cause, reported
usage, and recent phase/log entries. `-v` adds the saved failure stack. It does not import workflow
code or acquire the writer lock.

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
`steps`, `rootCause`, `error`, `errorStack`, `usage`, `recent`, `harnesses`, and `warnings`,
alongside run/workflow identities. Completed step payloads are omitted from the summary. Older
records lack some measurements; inspection leaves those fields unknown rather than reconstructing
execution.

A saved `running` run with no lock or a dead/released owner is shown as `stale`. Remote or
unverifiable ownership remains `running` with its ownership diagnostics. A lock alone does not prove
liveness. Inspection uses the existing same-host PID and available birth-identity checks; it never
signals a process or recovers a lock. Timestamps are not heartbeats. A quiet agent call can leave
`updatedAt` unchanged for minutes.

## Watch and list

`--watch` polls every two seconds by default; `--interval` accepts an `ms`, `s`, or `m` suffix, from
1ms through 2147483647ms. Text redraws on changes in a terminal and appends snapshots through a
pipe. JSON mode is **JSONL**, one document per checkpoint/ownership change; elapsed time alone does
not produce another line. Use `--summary` for compact status snapshots. Intermediate writes between
polls can be missed: this is an inspection loop, not a durable event stream.

Watch ends with a final snapshot and exits 0 for completed, 1 for failed, 130 for cancelled, or 3
for stale. It emits no extra error document merely because the observed run failed. A missing or
unreadable run uses the ordinary JSON error contract. Interrupting the watcher exits 130 with an
error document after any prior snapshots, and leaves the observed workflow running. Non-watching
inspection exits 0 for every readable status. Exit 75 remains reserved for future suspension.

`workflow list` reads checkpoint filenames, sorts newest `updatedAt` first, and supports `running`,
`failed`, `completed`, `cancelled`, and `stale` filters. Unreadable checkpoints are skipped with a
stderr warning. JSON returns `{ kind: 'workflow.list.result', ok: true, stateDir, runs, warnings }`;
`runs` contains summary objects. A missing state directory gives an empty list. Neither list nor
watch imports source.

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

Only the most recent **500** lifecycle/phase/log payloads are retained. Compact signature/count
entries survive eviction to preserve replay detection. That count ledger and attempt histories can
still grow; high-volume logging remains unsuitable for this whole-file checkpoint store. The future
journal work is separate. There is no token or tool transcript here.

## Timing, requests, errors, and usage

New format-6 records extend the existing `seq`, cancellation status, and `attemptHistory` fields.
They do not add a duplicate `history` array or `cancelled` boolean. Each step records its latest
`phase`, `startedAt`, `finishedAt`, monotonic `durationMs`, resolved `request`, and `errorStack`.
Attempts retain execution number, timing, reported usage, request, outcome, error, and stack, along
with their existing policy and provenance. The latest attempt duration includes admission and
checkpoint-start waiting; the call's timeout starts only when admitted. Inspection labels these
separately. A crash can leave a running attempt with no finish time. Earlier history stays
unchanged.

Request summaries contain provider, explicit model (null means inherited native configuration),
profile, effective timeout/turn/budget/sandbox/cleanup limits, tools, cwd, structured-output flag,
SHA-256 of the UTF-8 prompt, and its first 200 UTF-16 code units. These diagnostics are outside
semantic identity. **Checkpoints contain prompt previews, log data, and stack paths; treat them as
sensitive.** They are local private files under the existing storage permissions.

`executions` records each actual workflow-body invocation, its PID, start/end, outcome, error and
stack. Reading a completed run through the resume fast path adds no execution. Historical `running`
entries are not rewritten as guessed crashes. `events` records run lifecycle, phase, and log
entries; step transitions remain live notifications backed by step/attempt state. All
`WorkflowEvent`s carry `at`, `execution`, and `runId`. Run/phase/log notifications use attempt 0 and
a null `stepId`, except `run.failed` can name the root effect. Debug lines include timestamp, run
ID, and event type. Notification data is copied; observer mutation or failure cannot invalidate
committed work, and observer promises are not awaited.

`rootCause` uses error identity and cause chains, not message matching. It attributes diagnostics;
it never decides durable error handling. Explicitly cancelled siblings keep `status: 'cancelled'`,
while valid late callback results still commit as completed. Run interrupts have no root effect.
`WorkflowRunError` exposes `runId`, `stepId`, saved `run`, and original `cause`, with a message such
as `Step word/1 (claude) failed: …`. `-v` on execute or inspect prints the stored stack/cause chain.

Usage totals sum locally started agent attempts, including reported usage from failed calls and
responses that failed schema validation. Replayed attempts are counted once; copied fork history is
excluded from the target's local total. Known portions of each metric are summed; an entirely
unknown metric stays null (zero when there were no agent attempts). `incompleteAttempts` identifies
partial coverage. Legacy records use their existing successful/failed usage where available. This is
not a billing ledger: abandoned calls and unreported usage remain unknown, and provider token
definitions differ. No prices are inferred.

Storage format 7 retains replay contract 6. Flat format-6 runs migrate automatically on resume;
original format 1 migrates by verifying its legacy step identities and must migrate before fork
reuse. Formats 2–5 remain inspection-only here. See [storage migration](storage.md#legacy-records).
Effect IDs and semantic fingerprints are unchanged by the added diagnostics.
