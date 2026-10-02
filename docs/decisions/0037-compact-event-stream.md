# 0037: A compact JSONL event stream behind --events

- Status: accepted
- Issue: #139

## Context

The runner already notifies every transition an agent host needs (`WorkflowEvent` through
`RunOptions.onEvent`), but the CLI exposed it only as debug-level stderr text mixed with admission
noise and workflow console output, as `inspect --watch` snapshots of about 4.5 KB each that can miss
transitions between polls, or as `--notify-command`, which forwards four run-level events. A host
such as Claude Code's Monitor tool turns each output line into a notification, so it needs one short
line per meaningful transition, filterable with `grep --line-buffered`, and readable while the run
is still writing.

`WorkflowEvent` has no duration field, `--json` reserves stdout for the result document, and a
resume replays completed work, re-notifying it with `replayed: true` or as `step.replayed`.

## Decision

`--events FILE|-` on `workflow execute` (and so `start`), `resume`, `tick` and `answer --resume`
appends one JSON line per event to FILE, or writes it to stdout for `-`. A pure formatter and a
small best-effort sink in `src/workflow/loader/events.ts` observe the executor's existing `onEvent`
callback, beside rehearsal and the notification hook.

- **Line shape.** An ordered object `{t, run, ev, step, attempt, harness, ms, costUsd, phase, msg}`;
  absent or null fields are omitted. `attempt` appears only on `step.failed` and `step.settled`, so
  retries stay distinguishable. `harness` is the event's own, or the one last seen on an `agent.*`
  event for that step in this process. `costUsd` is `usage.costUsd` when it is a number. `msg` is
  the event message when non-empty; for `log` it is the message plus the compact JSON of its data,
  and for `wait.opened` the compact JSON of the question.
- **Event set.** `run.started`, `run.completed`, `run.failed`, `run.cancelled`, `run.suspended`,
  `step.completed`, `step.failed`, `step.settled`, `wait.opened`, `phase` and `log`. No `agent.*`,
  `child.*`, `step.started` or `step.cancelled` lines.
- **Bounds.** `msg` is cut at a code point with a trailing `…` to a 200-byte budget, so a typical
  line stays near 300 bytes. A hard cap of 512 UTF-8 bytes per line (without the newline) is
  enforced by shrinking `msg` further, then middle-truncating `step` and `phase`, then `run`. Run
  IDs are at most 128 characters, so the cap is always reachable.
- **Sink-derived `ms`.** The sink computes durations from event timestamps instead of changing
  `WorkflowEvent`: for `step.completed`, `step.failed` and `step.settled`, the time since that
  step's latest `step.started` in this process; for the terminal run events, the time since this
  execution's `run.started`. It is omitted when no start was seen, such as a step that began in an
  earlier execution. Tracking entries are deleted on terminal step and run events.
- **Replay echoes are dropped, not marked.** Events with `replayed: true`, `step.replayed` and
  `step.reused` are not written. The file is opened for append and is meant to be reused across
  `start`, `resume` and `answer --resume`, so the earlier execution's lines are already there; one
  line per real transition needs no consumer-side deduplication.
- **Warning-only writes.** The file is opened with mode 0600 for append (an existing file keeps its
  mode) and each line is one `writeSync`, flushed but never fsynced: the file is observational, not
  durable state. An open or write failure logs one `Events: …; further events are not written.`
  warning, disables the sink and never changes the run outcome or exit code, the same rule as
  notification hooks. The file is closed in the executor's cleanup path.
- **Stdout channel.** With `--events -` (or `--events=-`) before `--`, the command applies the same
  stdout redirect as `--json`: workflow console output and the human result go to stderr, and the
  sink writes through the saved stdout, so stdout carries only event lines. The command layer passes
  that writer to the executor, which never touches `process.stdout`. `--events -` together with JSON
  output (including answer's `--json VALUE` alias) is refused with `usage.flag` (exit 2) before any
  run work. `workflow start --events -` is always refused, because the detached runner's stdout is
  the launch result file; `--events FILE` passes through to the runner unchanged.
- **Per invocation.** The flag is not saved in the launch policy (ADR 0035); a resume, tick or
  `answer --resume` passes it again, like `--notify-command`. It is allowed with `--dry-run`.

## Consequences

- Hosts can follow a run with `tail -n +1 -F FILE | grep --line-buffered '"ev":"step.failed"'`: a
  line is visible as soon as the runner emits it, and the Claude skill's "Drive a run from Claude
  Code" recipe uses that with `run_in_background` and Monitor.
- The stream is best effort. A crash can lose the event of a transition that was saved, and a line
  carries no step error text; the checkpoint and `inspect` remain the source of truth.
- `WorkflowEvent`, the notification hook and the debug logger are unchanged. Adding a step error
  message or failure categories is separate work; `workflow events --follow` followed in
  [ADR 0038](0038-code-free-event-follower.md).
