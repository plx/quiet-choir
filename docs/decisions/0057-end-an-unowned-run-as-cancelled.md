# 0057: End an unowned unfinished run as cancelled under the run lock

- Status: accepted
- Issue: #292
- Amends the Guard and the Consequences of
  [ADR 0039](0039-cancel-a-live-run-through-a-token-bound-request.md), which refused an unfinished
  run that no process owns with `run.unowned`.

## Context

ADR 0039 made `workflow cancel` end a live local run by signalling its verified owner. An unfinished
run that no lock holds was refused with `run.unowned` (`details.reason: "unlocked"`), because there
was no process to signal. Such runs are common: a `suspended` run parked on a sleep, wait, question,
retry backoff or budget window; a run someone interrupted on purpose (a resumable suspension with
`interruptedBy`, due now); and a `running` record left by a crashed owner whose lock was cleared.
Tick resumes every one of them once it is due or stale, and nothing short of editing state by hand
stopped that. The refusal protected nothing, since no process was running.

## Decision

`workflow cancel RUN` ends an unfinished run that no lock holds by saving it `cancelled` under the
run lock. There is no new flag: the command's intent is to stop the run.

- **Lock first.** When cancel observes no primary lock, it calls the runtime's internal
  `cancelUnownedRun`, which takes the legacy guard and the primary lock like any writer, re-reads
  the record under them, and saves the transition durably before releasing both. A record that is
  missing is `run.not_found`, and one whose schema revision is newer than this build is refused by
  the owned read as usual.
- **No dead-owner recovery.** The lock is taken with the new internal `RunLockOptions.reclaimStale`
  set to false. A dead or released previous owner's lock is then refused with `run.locked` and the
  `workflow unlock` command, and nothing is touched: cancel never inspects or stops recorded
  children, never retires a lock and never claims recovery. A dead owner that cancel observes
  directly keeps ADR 0039's `run.locked` refusal (`reason: "dead"` and the others, with
  `details.next` naming unlock). After `workflow unlock` clears it, a second `workflow cancel` ends
  the run.
- **One transition.** The record transition lives in `run-cancellation.ts` as `cancelRecord`, which
  the runner's accepted-replay preflight abort also uses, so both write the same record. It stamps
  storage format 7, the engine and the schema revision; drops `interruptedBy`; saves `cancelled`
  with the reason as `error` and a step-less `rootCause`; replaces the recovery cause
  (`{kind: "cancelled"}`) and hint; settles every running or suspended child frame as `cancelled`
  with `finishedAt`; and ends a new execution entry with a `run.cancelled` event. The reason is
  `Run <id> cancelled by workflow cancel (requested <at>) while it was <status> with no owner.`
- **Races.** A live owner, tick or another writer can take the lock between cancel's observation and
  its own attempt. Its `run.locked` makes cancel look again, up to three attempts: a terminal record
  is reported as it is, a live verified owner takes ADR 0039's signal path, and a dead, released or
  foreign owner gets its existing refusal. After three contended attempts cancel reports the last
  `run.locked`. A run that ended before cancel held the lock is reported with its status and is not
  written.
- **Result.** `workflow.cancel.result` gains `previousStatus: "running" | "suspended" | null`: the
  unfinished status that cancel itself ended under the lock, or null when an owner ended the run or
  it had already ended. Without it an idle cancellation and a no-op would both read
  `signalsSent: 0, owner: null`. The text output says
  `Run <id> was suspended with no owner; saved cancelled.` `run.unowned` now means only
  `reason: "owner-exited"`; `reason: "unlocked"` is no longer produced.
- **Format 1.** A format-1 record cannot be saved without the definition-driven migration, the same
  rule the runner applies, and cancel imports no workflow code. It is refused with
  `run.incompatible` (exit 3), unchanged; resume it once with this build, or remove it with
  `workflow rm`. Formats 6 and 7 are saved (a flat format-6 record migrates on that save). Formats 2
  to 5 are read-only history that no build resumes, so an unfinished record in one is also refused
  with `run.incompatible` (exit 3), unchanged, with the same message the runner gives; cancel never
  rewrites it into format 7. A run that already ended is reported in any format.
- **What stays.** Steps, worktrees and the run's other state are left as they are, as on the
  runner's definition-free preflight path. A suspended run already cleaned its worktrees when it
  parked. No notification command or event stream is delivered, because no execution is running.

`failed` is terminal and tick never resumes it, so cancelling a failed run stays an idempotent no-op
that reports `failed`.

## Alternatives

- **An `--idle` flag.** It would keep the refusal as the default, but the refusal protects nothing
  and every caller who wanted the run stopped would need the flag. One command whose intent is "stop
  this run" is simpler to script.
- **Reclaim a dead owner's lock in cancel.** Recovering the lock inspects and may stop recorded
  children of the dead owner. That belongs to `workflow unlock` and tick's recovery, whose refusals
  explain surviving children; making a forced cancel stick against stale recovery is separate work
  (#293).
- **Rewrite the record without the lock.** ADR 0039 rejected finalizing a record outside the runner
  because it races tick and rewrites child frames and lifecycle state elsewhere. Taking the lock
  removes the race (whoever holds it decides), and sharing `cancelRecord` with the runner keeps the
  child-frame and lifecycle rules in one place.

## Consequences

- An operator can stop any unowned unfinished run, and tick then observes it as terminal instead of
  resuming it.
- Scripts that relied on `run.unowned` with `reason: "unlocked"` as a harmless probe now end the
  run. This is a deliberate behaviour change at version 0.0.0, with no record format change.
- A cancelled stale `running` record can still show a step as `running` in `inspect`: cancel leaves
  steps as the crashed owner saved them rather than inventing step transitions outside the runner.
- A lock taken by cancel registers the default state root for the run's `cwd`, as tick does.
- Remote-host cancel and embedder owners that honour cancel requests remain out of scope.

See the [CLI contract](../cli-contract.md) and [process lifecycle](../process-lifecycle.md).
