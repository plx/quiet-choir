# Scriptable workflow commands

Place flags after the command name. `workflow execute FILE --json` and `workflow inspect ID --json`
each write one single-line JSON document. Validate, typecheck, and check-resume use the same failure
contract, including argument parsing errors. Request human help without `--json`. Use
`npm run --silent cli -- …` when invoking through npm; quiet-choir cannot suppress its parent
process's banner.

Success documents retain their shapes, except for the run commands described below: inspect returns
a run with current ownership diagnostics, validate returns workflow metadata, typecheck returns its
compiler result, and check-resume returns a compatible comparison in `check`.
`inspect --json --summary` returns the compact dashboard, including the completed run's `output`
(null otherwise) and an `agents` roll-up. `workflow list --json` returns
`{kind, ok, stateDir, runs, warnings}` with compact rows: `id`, `workflow`, `status`,
`recordedStatus`, `counts`, `updatedAt`, `ownership`, `nextWakeAt`, `cwd`, `stateDir`, `warnings`
and a six-field `usage`; `--full` restores whole run summaries. `validate --json` and
`list-defs --json` omit each `harnesses[].options` JSON Schema, at every depth of `children`, unless
`--harness-schemas` is given. `list --all` discovers registered XDG projects without imports; rows
include `cwd` and `stateDir`. `execute --resume --run-id ID` may omit FILE and use stored launch
paths, as does `resume ID`. A supplied different FILE is refused before import. See
[storage](storage.md). `inspect --watch --json` emits JSONL per checkpoint/ownership change, ending
with a snapshot and exit 0/1/75/130/3 for completed/failed/suspended/cancelled/stale (an interrupted
run ends as suspended). It does not add an error document for an observed failure. An interrupted
watcher emits an error document and leaves the observed run untouched. Three opt-in flags bound the
watch for hosts with time limits. `--timeout DURATION` is measured from the first successful read: a
run still running then ends the watch with `watch.timeout` (exit 79), whose error document carries
the last observed `status` (`running`) and `details.timeoutMs`; the run keeps running.
`--wait-created DURATION` is measured from the start of the watch: until the first successful read,
a missing record is retried at the interval instead of failing with `run.not_found` (exit 3), and
when the bound expires the watch fails with `watch.record_not_created` (exit 66), `status: null` and
`details.waitCreatedMs`. A record that disappears after it was read stays `run.not_found`. Both take
`ms`, `s`, `m` or `h` durations up to 2147483647 ms and sleep at most until their deadline, then
read once more, so a run that finishes at the deadline is reported as finished and the watch ends
within one read after it. `--final` prints only the final snapshot, or only the error document on a
bound, an interrupt or a missing record. With `--summary`, inspect error documents carry the compact
`summary` instead of the whole `run`. 79 is the first exit after the sysexits block and has no
meaning in sh, Node, `timeout(1)` or xargs; 124 stays `start.timeout`, so a host can tell "runner
stopped without a record" from "run still running". See [run observability](observability.md) for
polling, stale detection, and partial usage. Non-watching inspect exits 0 for any readable
checkpoint status, including `failed`, `cancelled`, and `running`. `workflow pending --json` returns
`{kind:"workflow.pending.result", ok, pending, hidden}`, and `workflow answer --json` without
`--resume` returns `{kind:"workflow.answer.result", ok, delivery}`.

Each `pending` row keeps the question or wait fields and adds `runStatus` (the owning run's
checkpoint status), `delivery` and `next`. `delivery` is `{state, at, by}`: `state` is `queued` when
an answer file is already in the run's inbox, with `at` and `by` read from its envelope (both null
when the file is unreadable), and `none` otherwise; it is null for a poll or deadline wait that
accepts no answer. Delivery is advisory: while an owner is consuming the file a row can read `none`
for a moment, and `answer` stays the authoritative first-answer check. `next` follows the
[next commands](#next-commands) shape: a queued row of a suspended or failed run that has launch
metadata gets one `resume` entry (repeating the run's recorded launch policy) so the owner ingests
the answer; every other row gets `[]`, because a running owner ingests the answer itself.

By default `pending` lists only rows that still need an answer: it hides rows whose delivery is
`queued` and rows of `failed`, `cancelled` or `completed` runs, and reports how many it hid in
`hidden`. Rows of running runs stay, so a `--wait-mode block` run's live question is listed. `--all`
lists every row (`hidden` is then 0). The library `listPending` is not filtered: it returns every
waiting row, with `runStatus` and `delivery` added.

`answer.invalid` (exit 2) carries `error.details.issues`, an array of `{code, path, message}` where
`path` locates the offending field in the answer (`["approved"]`; `[]` for the whole value). A value
that does not match the question's schema reports one issue per Zod issue (`code` is the Zod code
such as `invalid_type`), and `error.message` is one line, for example
`Answer does not match the question schema: approved: Invalid input: expected boolean, received string`.
A refusal with no schema location has one issue with path `[]` and a synthetic code:
`answer_not_json` (not JSON, or not representable as JSON), `question_schema_invalid` (the stored
schema cannot be used), `answer_author` (`--by` is missing or wrong for a human question, or is
invalid) and `answer_too_large` (the envelope exceeds 1 MiB). Re-ask from `issues`; nothing was
written.

## Run results of execute, resume and answer --resume

These three commands print a compact, constant-shape result by default, so an agent session reads
the status and output of a long run without its checkpoint. A run that completes returns

```json
{
  "kind": "workflow.run.result",
  "ok": true,
  "exitCode": 0,
  "runId": "...",
  "stateDir": "...",
  "status": "completed",
  "output": {},
  "usage": { "costUsd": 0.18, "attempts": 180, "undercounted": false },
  "counts": {
    "total": 180,
    "completed": 180,
    "running": 0,
    "failed": 0,
    "cancelled": 0,
    "settled-failed": 0,
    "superseded": 0,
    "waiting": 0,
    "withdrawn": 0
  },
  "rootCause": null,
  "warnings": []
}
```

`output` is the run's output unchanged. `usage` sums the recorded agent attempts: `costUsd` is the
harness-reported estimate (null when none was reported) and `undercounted` is true when the cost or
attempt totals may be low, because of legacy checkpoints or attempts with unknown cost or tokens.
`counts` is the step total by status, `rootCause` the failing effect as `{stepId, error, errorKind}`
(`errorKind` is null for a body failure and for a record from before the kind was stored without an
attempt to read it from) or null, and `warnings` the run's warnings, de-duplicated and capped at 20
followed by a note that says how many more exist.

A suspension (exit 75) returns
`{kind:"workflow.run.suspended", ok:true, exitCode:75, runId, stateDir, pending, resumeCommand, summary}`,
where `summary` is the same projection (`runId`, `stateDir`, `status`, `output`, `usage`, `counts`,
`rootCause`, `warnings`) and each `pending` entry keeps its `answerCommand`.

`--full` prints the whole record instead, exactly as earlier releases did: `{...run, stateDir}` for
a successful run (no `kind` or `ok`; `answer --resume --full` now includes `stateDir` too), and the
suspension and failure documents with `run` in place of `summary`. Use `workflow inspect` to read a
saved run later. `--full` is detected from argv before parsing, so a failure that occurs before
argument parsing completes honours it as well. The `--json` alias of `answer`'s `--value` is
unaffected: pass `--json VALUE --full`.

`execute --dry-run` documents are not compacted: a rehearsal deletes its temporary state, so the
embedded `run` is the only copy. This section applies to success and suspension documents of the
three commands and to their failure documents; every other command keeps its shapes.

`workflow unlock ID [--force-remote] --json` clears an abandoned run lock without importing workflow
code and returns `{kind:"workflow.unlock.result", ok:true, runId, stateDir, forceRemote, locks}`.
`locks` lists every lock found, primary first, as
`{kind:"primary"|"guard", path, owner, recovery, processes, warning?, action:"removed"|"absent"}`,
where `owner` and `recovery` are `{pid, host, state}` (the local judgment) or null, and `warning`
reports missing or unreadable metadata; it is empty when the run was not locked. It refuses with
exit 3 and removes nothing: `run.locked` while an owner or recoverer is alive or unverifiable, or is
on a foreign host without `--force-remote` (`error.details` has `lockPath`, `kind`, `role`, `pid`,
`host` and `state`); `run.orphans` while a recorded child is alive or unverifiable (`error.details`
has `processes` and `owner`); and `run.not_found` when the run has neither a lock nor a checkpoint.
See [process ownership](process-lifecycle.md).

`workflow cancel ID [--force] [--timeout 30s] --json` ends a live local run as `cancelled` without
importing workflow code
([ADR 0039](decisions/0039-cancel-a-live-run-through-a-token-bound-request.md)). It signals only a
lock owner on this host that is alive and still has the OS start time it recorded: it writes a
cancel request bound to that owner's lock token, re-verifies the owner, sends one SIGINT to its PID
(never a group), and waits for the run to end. Success (exit 0) returns
`{kind:"workflow.cancel.result", ok:true, runId, stateDir, status, signalsSent, owner}`: `status` is
`cancelled`, or `completed`/`failed` when the run ended first; `owner` is the signalled
`{pid, host, osStartTime}`. A run that already ended is a no-op with `signalsSent: 0` and
`owner: null`. Refusals exit 3 and send nothing: `run.not_found`; `run.locked` for an unreadable,
foreign-host, released, dead or unobservable owner, or one without a recorded or with a mismatched
`osStartTime` (`error.details` has `lockPath`, `pid`, `host`, `state`, `osStartTime` and `reason`);
and `run.unowned` for an unfinished run that no lock holds (`details.reason: "unlocked"`). After the
signal, an owner that exits without saving a terminal status is `run.unowned` with
`details.reason: "owner-exited"`, `signalsSent` and `forced`, and the next tick may resume the run.
The wait is bounded by `--timeout` per signal: past it, `watch.timeout` (exit 79) with
`details: {timeoutMs, signalsSent, forced, pid}` and the last saved `status`; the request stays for
the owner to honour late. With `--force`, cancel first sends a second SIGINT if the same verified
owner still holds the run at the deadline; the owner then force-kills its groups and exits 130,
usually leaving `running` for tick's stale recovery. The cancelled owner itself exits 130 with
`workflow.interrupted` and a saved `cancelled` status, which tick observes and never resumes.

`execute --dry-run --json` returns a `workflow.rehearsal` document with `ok:true`, calls, replays,
provider counts, nominal Claude ceiling, warnings, and its in-memory run record. Failures retain the
usual error document and exits, adding `rehearsal` and `error.stack`. Temporary state has already
been removed on normal exit; dry-run never overwrites the requested/default state directory.
`workflow fixtures ID --json` returns version-1 fixture JSON from a completed run: its agent outputs
and settled agent failures. See [workflow rehearsal](rehearsal.md).

Failures have these fields:

| Field                         | Meaning                                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`, `ok`, `exitCode`      | `"workflow.error"`, `false`, and the process exit code                                                                                                                  |
| `error.code`, `error.message` | Stable code and diagnostic naming the root effect when available                                                                                                        |
| `error.stepId`                | Root failing effect, or null for a body failure or interruption; never an aborted sibling                                                                               |
| `error.details`               | Structured context: lock PID/host, schema issues, input source/position, compatibility comparison, or available run IDs; `{errorKind, retryable}` for `workflow.failed` |
| `runId`, `stateDir`           | Requested/generated ID and absolute storage directory when known; otherwise null                                                                                        |
| `status`                      | Actual saved checkpoint status, or null when unavailable                                                                                                                |
| `summary`                     | execute, resume and answer without `--full`, and inspect with `--summary`: the compact run result, or null when unavailable                                             |
| `run`                         | Saved record, or null when unavailable. Every other command, inspect without `--summary`, a `--dry-run` failure, or `--full` on execute/resume/answer                   |
| `failedSteps`                 | Saved failed/cancelled steps with ID, kind, attempts, error, `errorKind` (last attempt, or null) and `retryable` (the kind is `rate-limit`, `overloaded` or `timeout`)  |
| `diagnostics`                 | Compiler diagnostics, or an empty array                                                                                                                                 |
| `next`                        | Runnable follow-ups `{why, argv}`, or an empty array; see [next commands](#next-commands)                                                                               |
| `launch`                      | `workflow start` only: `{runId, pid, log, result, exitCode, signal}`; see [workflow start](#workflow-start)                                                             |

The error codes map to numeric exits in one CLI table:

| Exit | Codes                                                                                                                                                                                                                                                   | Next step                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `workflow.failed`                                                                                                                                                                                                                                       | A failed checkpoint was saved. Fix the workflow or execution policy and resume.                                                                                                                         |
| 2    | `usage.flag`, `usage.file_not_found`, `usage.entrypoint`, `usage.run_id`, `usage.input_json`, `usage.input_file`, `usage.input_schema`, `usage.resume_requires_run_id`, `answer.invalid` (the answer was not written)                                   | Correct arguments/input. No execution checkpoint was written.                                                                                                                                           |
| 3    | `run.exists`, `run.not_found`, `run.locked`, `run.incompatible`, `run.input_changed`, `run.unreadable`, `run.orphans`, `run.unowned` (`workflow cancel` found no live owner), `answer.conflict` (the question is not waiting or already has a delivery) | Correct run/storage selection, wait for the owner, or explicitly resolve compatibility/ownership. No workflow body ran.                                                                                 |
| 4    | `load.typecheck`, `load.import`, `load.definition`                                                                                                                                                                                                      | Fix trusted source or its definition. No execution checkpoint was written.                                                                                                                              |
| 66   | `watch.record_not_created`                                                                                                                                                                                                                              | `inspect --watch --wait-created` saw no record within the bound. Check the run ID and `--state-dir`, or whether the launch failed.                                                                      |
| 70   | `start.exited`                                                                                                                                                                                                                                          | The `workflow start` runner exited without a record or a readable result document; read `launch.log`.                                                                                                   |
| 74   | `workflow.storage`                                                                                                                                                                                                                                      | Inspect saved state and fix storage/ownership before deciding how to resume. External effects may already have happened.                                                                                |
| 75   | `workflow.run.suspended`                                                                                                                                                                                                                                | Saved suspension with pending waits, including a run that `inspect --watch` saw end suspended; answer questions, deliver signals, or tick when due.                                                     |
| 79   | `watch.timeout`                                                                                                                                                                                                                                         | `inspect --watch --timeout`, `events --follow --timeout` or `cancel --timeout` stopped waiting while the run had not ended; the run continues. Wait again, inspect it later, or retry `cancel --force`. |
| 130  | `workflow.interrupted`                                                                                                                                                                                                                                  | A first signal saved a resumable `suspended` run; the next tick or `resume` continues it. An owner stopped by `workflow cancel` saved `cancelled` instead.                                              |
| 124  | `start.timeout`                                                                                                                                                                                                                                         | `workflow start` stopped a runner that owned no record within `--start-timeout`; read `launch.log`.                                                                                                     |

Typechecking and import are distinct from workflow execution. Imports can have arbitrary side
effects; no exit status promises to undo them. Run-ID and input-JSON validation happen before
import. Schema validation needs the imported workflow definition. Resume with a schema-invalid
replacement input is usage failure; valid but changed input is `run.input_changed`.

A first SIGINT, SIGTERM or SIGHUP drains owned work and, when storage permits, saves a resumable
`suspended` run with `nextWakeAt` set to now and `interruptedBy: {reason, at}` (for example
`Workflow interrupted by SIGTERM.`), then still exits 130 with `workflow.interrupted`. The next
`workflow tick` treats the run as due and resumes it, reusing completed steps; `resume` works too.
Explicit or workflow-scoped cancellation still saves `cancelled`, which tick never retries. See
[ADR 0029](decisions/0029-persist-interruptions-as-resumable-suspensions.md). A second signal kills
tracked groups and writes the last readable checkpoint synchronously before exit 130;
`error.details.forced` is true and `status` may still be `running`, which tick recovers as a stale
run. SIGKILL, process crashes, and a closed output pipe cannot deliver a JSON document. Failure
documents, like success documents, are written in full before the process exits, including when
stdout is a pipe. Storage failures use exit 74 so that a failed save never masquerades as exit 1,
and a storage failure during an interrupt keeps exit 74 rather than 130 because the interruption
checkpoint may not have been saved. A run whose saved status is `failed` reports `workflow.failed`
(exit 1) even when a signal arrived, because the runner saves an interrupted suspension (or
`cancelled`) only when the interrupt caused the failure. Saved completion with a known cleanup
warning still succeeds under the [process ownership contract](process-lifecycle.md), as does a
completion or suspension (exit 75) that `execute`, `resume`, or `answer --resume` saved before a
late signal, or an answer that `workflow answer` already delivered. Inspect, validate, typecheck,
and check-resume report `workflow.interrupted` after a first signal even when their work finishes.

`check-resume` incompatibility uses exit 3 with the full comparison in `error.details`. Its
compatible success retains `check`. `execute --resume --accept-code-change` (and
`resume --accept-code-change`) first replays the accepted body against a disposable copy of the
record. When that replay reaches a completed or settled-failed step whose identity changed, the
command refuses with `run.incompatible` (exit 3) before writing anything: `error.details.divergent`
is `[{stepId, components}]` for the first such step, and `error.details.next` holds one argv array,
`LAUNCHER workflow execute FILE --fork-from RUN --reuse matching --invalidate STEP --run-id <NEW_RUN_ID> --state-dir DIR`,
built behind the same launcher as `resumeCommand` with a placeholder for the new run ID.
`execute --dry-run --resume --accept-code-change` returns the same code, message and details. A
missing run includes `details.runId` (the run that was not found, which is a `--fork-from` source
when that is what is missing), `details.stateDir`, sorted `details.available` (at most 20 IDs),
`details.count`, and `details.candidates`: at most 10 other runs containers that hold the ID, as
`{stateDir, cwd}` sorted by `stateDir`, or an empty array. The search covers every registered XDG
project root and its legacy `.quiet-choir/runs`, plus the default and legacy roots of the current
directory and its ancestors; it never lists the root already searched, and an unreadable candidate
is skipped rather than changing the code. The message then ends with
`Found in DIR (project CWD); rerun with --state-dir DIR.` Resolution itself is unchanged: explicit
`--state-dir` and `QUIET_CHOIR_STATE_DIR` win, and the default root still hashes the exact working
directory. A resume whose stored entrypoint no longer exists (a moved checkout or deleted file) is
`run.incompatible` (exit 3) with `details: {storedEntrypoint, reason:"entrypoint_missing"}`; fork
from the new location. Storage resolves explicit options, environment, existing legacy runs, then
the external XDG project default; relative explicit paths resolve against the launch directory.

## Workflow start

`workflow start FILE [execute flags] [--start-timeout DURATION] [--json]` launches
`workflow execute` as a detached runner and returns once the run's record exists. It accepts
execute's flags except `--resume`, `--kill-orphans`, `--accept-code-change`, `--dry-run`,
`--stub-steps` and `--full`, which do not create a new persisted run. The run ID is generated when
`--run-id` is absent and the state directory is resolved as for execute, both before the runner
starts; start passes the rest of its argv through unchanged, appends `--run-id` and `--state-dir`
when absent, and always appends `--json`. The runner is
`[node, realpath(bin/run.js), "workflow", "execute", …]` (development mode keeps the tsx loader
flags), never a PATH lookup, in its own session with stdin from `/dev/null`. Its stdout and stderr
go to `<stateDir>/<runId>/launch/<n>.result.json` and `<n>.log`, created exclusively for the
smallest free `n` (0600 files, 0700 directories); `--input -` is read by start and passed as
`--input @<n>.input.json`.

Readiness: start polls every 50 ms. While the runner lives, start succeeds once the record is
readable and the run lock's owner is the runner's PID; another process's lock does not count. After
the runner exits, a readable record counts when its document is a success (a fast completion or
suspension) or a failure other than `run.exists` and `run.locked`. Success (exit 0) is

```json
{
  "kind": "workflow.start.result",
  "ok": true,
  "exitCode": 0,
  "runId": "x",
  "stateDir": "/abs/runs",
  "pid": 12345,
  "status": "running",
  "log": "/abs/runs/x/launch/1.log",
  "result": "/abs/runs/x/launch/1.result.json",
  "next": [
    {
      "why": "...",
      "argv": ["...", "workflow", "inspect", "x", "--state-dir", "/abs/runs", "--json", "--summary"]
    }
  ]
}
```

`status` is the saved status when start returned: `running`, or `completed`, `failed` or `suspended`
when the runner already finished. `next` holds `inspect --json --summary` and `inspect --watch`
entries. The text form prints `Started run ID (runner PID n, status s).` with `Log:`, `Result:` and
`Next:` lines. The runner's own exit and document stay in the result file.

Failures use the ordinary `workflow.error` document with an added `launch` field
`{runId, pid, log, result, exitCode, signal}`: the run ID passed to the runner, its PID (null when
it never spawned), the evidence paths, and how it exited (null while it was still running). A
failure before the record exists, such as `load.typecheck` (exit 4) or a `usage.*` refusal (exit 2),
carries the runner's error, diagnostics and `next`, the exit code of that error, and top-level
`runId: null`, so no run is reported as started. Top-level `runId` is set only when a record is
readable. An existing run (`run.json` or a legacy flat checkpoint) is refused with `run.exists`
(exit 3) before anything is launched, without `launch`. Without an owned record within
`--start-timeout` (default `60s`), start sends SIGTERM to the runner's process group, waits
`--kill-grace-ms` (default 3000) plus 2 s for it to save, sends SIGKILL if needed, and fails with
`start.timeout` (exit 124). A runner that exits without a record or a readable document is
`start.exited` (exit 70). A first signal to start stops the runner the same way and reports
`workflow.interrupted` (exit 130); a second one kills it at once. A runner that had saved a record
leaves a resumable suspension, reported with its `runId` and a resume entry in `next`. The launch
directory of a pre-record failure has no `run.json`, so `list` and `inspect` ignore it; a retry with
the same ID uses the next `n`. See [ADR 0036](decisions/0036-detached-start.md). Detached sessions
are POSIX behaviour; Windows is not covered.

## Event stream

`--events FILE|-` is accepted by `workflow execute`, `start`, `resume`, `tick` and, with `--resume`,
`answer` (without `--resume` it is a usage error). FILE resolves against the launch directory and
receives one JSON line of at most 512 bytes per step, phase, log, wait and run event, appended to an
owner-only file; see [run observability](observability.md#event-stream) for the fields, the event
set and the replay rule. A sink that cannot open or write its file warns once on stderr and never
changes the result document or the exit code. The flag is not saved with the run.

`-` writes the lines to stdout, which then carries only event lines: workflow console output and the
human result go to stderr, as under `--json`. `--events -` (or `--events=-`) together with JSON
output is refused with `usage.flag` (exit 2) before any run work, because `--json` reserves stdout
for the result document; this includes answer's `--json VALUE` form. `workflow start --events -` is
always refused with `usage.flag`, because the runner's stdout is the launch result file; start
passes `--events FILE` to its runner unchanged. `--events FILE` with `--json` leaves the stdout
document exactly as it is without the flag.

## Event follower

`workflow events RUN [--follow] [--from-start | --after-execution N] [--interval D] [--timeout D] [--wait-created D] [--state-dir DIR] [--json]`
prints a run's compact event lines (the [event stream](#event-stream) shape, at most 512 bytes each)
on stdout, derived from the persisted record without importing the workflow, so it works after the
workflow file moved or stopped compiling. See
[following a run without its events file](observability.md#following-a-run-without-its-events-file)
for what the record can and cannot supply.

- Without `--follow` it prints the record's lines once (all of them, or only those of executions
  after `N` with `--after-execution N`) and exits 0, like non-watching `inspect`.
- With `--follow` it starts from the current end: the first read prints nothing, and each later read
  prints the new lines as soon as it derives them, one write per line. `--from-start` prints the
  whole record first. `--after-execution N` prints only entries recorded by executions after `N` and
  ignores a terminal status until a later execution reaches one; pass the `execution` of a suspended
  snapshot so a follower started beside `answer --resume` waits for the resumed execution instead of
  stopping on the old `suspended` status. An attempt saved before executions were recorded counts as
  earlier.
- `--follow` exits like `inspect --watch` once the run is terminal: 0 completed, 1 failed, 75
  suspended, 130 cancelled, 3 stale. `--interval`, `--timeout` (exit 79, `watch.timeout`) and
  `--wait-created` (exit 66, `watch.record_not_created`) have the watch's syntax, range and rules;
  without `--wait-created` a missing record fails at once with `run.not_found` (exit 3).
  Interrupting the follower exits 130, and so does a reader that closes the pipe.
- Output is always JSONL. `--json` only turns a failure into a `workflow.error` document on stdout
  (with the compact `summary`, never the whole record); without it the failure message goes to
  stderr. `--from-start` with `--after-execution`, a negative `N`, and `--interval`, `--timeout` or
  `--wait-created` without `--follow` are `usage.flag` (exit 2).
- `--log-level debug` reports each read on stderr (`Events: read run …`).

## Next commands

Every failure document has a top-level `next` array, and `inspect --json --summary` (and
`list --full`) summaries carry one too; compact `list` rows do not. Each entry is
`{why: string, argv: string[]}`: run `argv` directly, without a shell, after substituting its
placeholders. Text inspect and human failure messages print each entry as
`Next: <shell-quoted argv>  (why)`.

| Source                                          | Entries                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `workflow.failed` with a saved failed run       | `resume RUN --state-dir DIR`                                                                          |
| `workflow.interrupted` with a saved suspension  | as for a suspended summary                                                                            |
| `start.timeout` with a saved suspension         | as for a suspended summary                                                                            |
| `run.orphans`                                   | `resume RUN --state-dir DIR --kill-orphans`                                                           |
| `run.incompatible`, code or schema change only  | `resume … --accept-code-change` (unless the run completed), then a fork                               |
| `run.incompatible`, other run-level changes     | a fork from the stored entrypoint; none when the workflow name changed or for a legacy checkpoint     |
| `run.incompatible`, divergent completed step    | the fork command from `error.details.next`                                                            |
| `run.incompatible`, different requested FILE    | `resume` with the stored entrypoint, then a fork from the requested FILE                              |
| `run.incompatible`, `entrypoint_missing`        | `execute <ENTRYPOINT> --fork-from RUN --run-id <NEW_RUN_ID> --state-dir DIR`                          |
| `run.not_found` with `details.candidates`       | `inspect RUN --state-dir CANDIDATE` for at most 5 candidates, RUN being `details.runId`               |
| Failed or stale summary                         | `resume RUN --state-dir DIR`                                                                          |
| Suspended summary                               | `answer RUN STEP --state-dir DIR --json <ANSWER_JSON>` for at most 5 waiting questions, then `resume` |
| Dry-run failures, embedded runs, any other case | `[]`                                                                                                  |

A fork is `execute ENTRYPOINT --fork-from RUN --run-id <NEW_RUN_ID> --state-dir DIR`; it records the
directory it is launched from as the new run's cwd. Placeholders are `<ANSWER_JSON>` (serialized
answer data), `<NEW_RUN_ID>` and `<ENTRYPOINT>` (the workflow file's new path). A human question
also needs `--by human:<name>`, added after asking the human. A run without stored launch paths (an
embedded run) gets no entries, since it cannot be resumed by ID.

Emitted argv, including `resumeCommand`, `answerCommand` and the divergence fork command, start with
the launcher of the invocation that produced them. When `process.argv[1]` is an installed
`quiet-choir` that a PATH lookup resolves to the same file, the launcher is `quiet-choir`.
Otherwise, including `node "$QC_CHECKOUT/bin/run.js"`, npx and `node_modules/.bin` shims, it is
`[node, realpath(bin/run.js)]` with absolute paths (development mode keeps the tsx loader flags), so
the commands run from any directory without `quiet-choir` on PATH. Embedders and in-process callers
that pass no `commandLauncher` keep `['quiet-choir']`. Commands are computed for each invocation and
never saved, so a later `pending` or `inspect` regenerates them for the current Node and checkout.
`resumeCommand` and every `resume` entry end with the run's recorded launch policy flags (below);
`answerCommand` and fork entries do not.

## Launch policy

Each execution records a non-secret launch policy in the run's launch metadata (`launch.policy`),
outside the workflow fingerprint and step identity: the global harness kind (`cli` or `fixture`),
each fixture file as its absolute path (resolved against the command's working directory) with the
SHA-256 of its bytes (unnamed for `fixture:<file>`, named for `name=fixture:<file>`), and the wait
mode. The latest execution's policy replaces the previous one, so an explicit flag becomes the new
sticky value. No `--harness-config` value is recorded; only its digest is, as before.

- `resume`, `execute --resume` and `answer --resume` without `--harness` use the recorded harness
  kind and fixtures, combined with this invocation's `--harness-config` (or its default); without
  `--wait-mode` they use the recorded wait mode. `tick` without `--harness` does the same for each
  run.
- Explicit `--harness` or `--wait-mode` replaces the recorded value. A different harness kind still
  needs `--allow-harness-change`.
- A recorded fixture file that is missing or unreadable fails the resume with `usage.flag`, naming
  the path; pass `--harness` explicitly. A fixture whose content changed is used with a warning that
  names the file and both digests, and its new digest is recorded.
- A run started with a custom `--harness-config` must be resumed with the same configuration: a
  plain `resume` or `tick` is refused (`run.incompatible`, naming `--harness-config`) before any
  agent starts, because the configuration is not recorded.
- `tick` always resumes with `suspend` for that execution only, so one run's waits never hold the
  batch; the recorded wait mode stays, and a later plain `resume` of a `block` run blocks again.
- A run recorded by an older build (or launched by an embedder, which supplies no policy) behaves as
  before: the default `cli` selection, with tick forwarding its `--harness-config` only to runs that
  last executed with the CLI harness.

Emitted resume commands carry `--harness fixture:<abs>`, `--harness <name>=fixture:<abs>` and
`--wait-mode block` as recorded; the defaults (`cli`, `suspend`) are omitted, and `--harness-config`
is never emitted. `answerCommand` only delivers an answer, so it carries none; the resume entry
after it does.

Workflow `console.log` and `process.stdout.write` during import/execution are redirected to stderr
in JSON mode. `Run ID:`, debug logs, warnings, and human diagnostics also use stderr. Redirecting
output does not sandbox trusted workflow code.

## File and stdin input

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute workflow.ts --input @input.json --json
cat input.json | node "$QC_CHECKOUT/bin/run.js" workflow execute workflow.ts --input - --json
```

File paths resolve against the shell's working directory. Unreadable files report
`usage.input_file`; invalid JSON reports `usage.input_json` with the source and zero-based character
offset. Omitting input retains `{}` for new runs and the saved/source input for resume/fork.

## Embedding migration

`runWorkflow` throws `WorkflowRunError` after saving a failed/cancelled run. Its `run` is the saved
snapshot, `runId` identifies it, `stepId` is the root effect, and `cause` is the prior rejection.
Match application errors, `HarnessError`, or `FanOutError` through `cause`. If checkpoint problems
were combined, that cause is the existing `AggregateError`, whose cause remains the original primary
failure. An unsuccessful failure save leaves the existing checkpoint-error behavior intact and does
not invent a saved run.

`RunRefusedError` has a stable `run.*` code, run ID, plain details, and an optional underlying
cause. `WorkflowInputError` has `usage.input_schema`, validation issues, and the validator cause.
`StepIdentityChangedError` (a `WorkflowRunError` cause) names the `stepId`, changed `components` and
terminal `status` of a replayed step whose identity changed; an embedded
`runWorkflow({ resume: true, acceptCodeChange: true })` has no preflight, so it records the
acceptance and then fails with this cause. `isValidRunId` and `CliErrorCode` are exported for
callers. `readRun` retains its low-level ENOENT contract. See [the changelog](../CHANGELOG.md) for
the prototype API break.

`workflow typecheck` lists effective compiler flags in human output. JSON success includes
`compilerOptions`; a typecheck failure includes it in `error.details`, alongside compiler version
and config path. Built-in defaults add `noUncheckedIndexedAccess` to strict Node/ES2023 checking;
`exactOptionalPropertyTypes` is enabled only by a project config. Resume also typechecks, so an
unchanged in-flight run can be blocked by these stricter defaults before import or effects.

## Tick

`workflow tick` returns a single aggregate JSON document: `resumed` entries with each started
resume's outcome (completed, suspended, failed, cancelled or incompatible), `skipped` entries with a
reason (not due, no longer due, locked, orphans, crash-loop, deadline, incompatible or unreadable),
and an `observed` count of already-terminal runs. Each run appears in at most one entry. Tick also
recovers `running` runs whose owner is gone, up to 3 consecutive times without a new completed step;
then it reports `crash-loop` with a message naming `workflow resume`. With --run, exits are 0
completed (now or earlier), 75 pending, interrupted, locked, orphans or deadline, and 1 failed,
cancelled, crash-loop, incompatible or unreadable; batch per-run failures remain data with exit 0.
Usage/infrastructure errors retain the command failure document. Every tick is bounded by --timeout
(default 540s), including --watch, with --max-runs limiting executed resumes. When the timeout
fires, tick interrupts in-flight resumes into resumable suspensions: each is reported `suspended`
with `message: "Tick timeout reached."` and is due on the next tick, which reuses its completed
steps. `--claim-margin` (same duration syntax; default 10% of --timeout, `0ms` disables it, and it
must be smaller than --timeout) stops new claims once less than the margin remains: a ready run is
then left untouched and reported as skipped `deadline`, and --watch ends there. `--harness-config`
supplies CLI harness configuration (JSON or `@file`) for resumed CLI runs, and omitting it means the
defaults. It must match the configuration digest the run recorded at its latest live execution:
otherwise the run is reported `incompatible` and left unchanged, unless
`--allow-harness-config-change` accepts the change for every run that tick resumes. `--harness`
(repeatable, the same values as on `resume`) selects the harness for every run that tick resumes;
without it, each run uses its recorded [launch policy](#launch-policy). `workflow resume`,
`execute --resume` and `answer --resume` refuse the same mismatch with `run.incompatible` (exit 3,
`error.details.previousConfigDigest` and `error.details.requestedConfigDigest`) and accept the same
flag. See [waits](waits.md) for due detection and notification hooks.
