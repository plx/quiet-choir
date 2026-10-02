# 0038: A code-free event follower derived from the run record

- Status: accepted
- Issue: #140

## Context

`--events` (ADR 0037) writes one compact line per transition, but only for a run launched with the
flag, and only from the process that runs it. A host that follows a run it did not launch, or one
started without the flag, can only poll `inspect --watch` snapshots of several kilobytes each. The
record already holds what a follower needs: `readRun` applies journal entries without the writer
lock, the record keeps the run's lifecycle, phase and log entries (the newest 500), every step's
attempt history with times, durations and usage, and each question's notification time. Live-only
`agent.*` events are never persisted.

The Claude plugin's `/quiet-choir:run` command needs such a follower: after `answer --resume` starts
in the background, a follower started from the current end usually reads the run while it is still
`suspended` (the resume is still importing workflow code), so a plain follower would stop at once on
the old status.

## Decision

`workflow events RUN [--follow]` prints `--events` lines derived from the record, read through the
same code-free `inspectRun`/`watchRun` path as `inspect`, and never imports workflow code.

- **One formatter.** `src/workflow/loader/event-line.ts` holds the only line formatter,
  `formatEventFields`: ordered fields, omission of absent values, the attempt rule, the 200-byte
  `msg` budget and the 512-byte fit. The live sink maps a `WorkflowEvent` to those fields and the
  follower maps record entries to them, so the two streams cannot drift. The formatter and the
  follower's derivation (`event-follow.ts`) are pure modules under an ESLint purity block.
- **Record sources.** Run events map one to one. Completed attempts become `step.completed`, failed
  ones `step.failed`, and the final attempt of a settled failure `step.settled`, matching what the
  runner emits; cancelled and interrupted attempts and fork-reused steps write nothing, as
  `--events` drops `step.cancelled` and `step.reused`. A notified question becomes `wait.opened`
  with the question in canonical key order, as the live payload has it. Lifecycle messages are the
  runner's fixed texts; an older execution's `run.suspended` omits `msg`, because only the latest
  interruption is recorded. Fields the record cannot supply are omitted, never guessed: `ms` is the
  recorded attempt or execution duration (the live sink's is process-observed), `harness` comes from
  the step's kind and registration, and `costUsd` appears only on `step.completed`.
- **Identity, not position.** Run events key on execution, time, type and content with an occurrence
  counter for identical entries; attempts on step, attempt number and outcome; questions on step and
  notification time. The set of seen keys is replaced on every read by the keys of that record, so
  it stays proportional to the record, and eviction past 500 events neither repeats nor hides newer
  lines. Lines of one read are sorted by time, stably, with the latest execution's terminal run line
  last.
- **Start and stop.** `--follow` starts at the current end (the first read is a baseline);
  `--from-start` prints the record first. `--after-execution N` prints only entries of executions
  after `N` and, through a new optional `done` predicate on `watchRun`, ignores a terminal status
  until a later execution reaches one. A follower exits with `watchExitCodes`, and `--interval`,
  `--timeout` and `--wait-created` are the watch's own bounds (the watch's rule for a record that
  does not exist yet is reused, not duplicated). Without `--follow` it prints once and exits 0.
- **Output.** Lines are always JSONL, one write per line through the stdout writer `--events -`
  uses; `--json` only selects the `workflow.error` document for failures, with the compact summary.
  A reader that closes the pipe stops the follower.

## Consequences

- A host can follow any run by ID with `workflow events RUN --follow | grep --line-buffered …`,
  including after the workflow file moved or stopped compiling. `/quiet-choir:run` uses it for
  Monitor and, with `--after-execution`, for the answer loop.
- Polling coalesces transitions between reads, and phase and log payloads evicted past the 500-event
  cap before a slow follower reads them are never printed. The live `--events` file remains the
  complete stream for a run launched with it.
- `WorkflowEvent`, the `--events` line shape, `MAX_RUN_EVENTS` and the storage format are unchanged.
