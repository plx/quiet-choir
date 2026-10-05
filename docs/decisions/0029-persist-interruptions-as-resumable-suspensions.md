# 0029: Persist external interruptions as resumable suspensions

- Status: accepted
- Issue: #199; amended by #288 (`workflow cancel`, ADR 0039)

## Context

A run stopped by tick's own `--timeout` or by a first SIGINT, SIGTERM or SIGHUP was saved as
terminal `cancelled`, the same status as a deliberate cancel. Tick never retries `cancelled` runs,
so every such run needed a manual `resume`, and a long agent call under the documented every-minute
cron could never finish: each tick's deadline killed the in-flight attempt and stranded the run. The
abort reasons were plain `Error`s, so nothing distinguished "the host process is going away" from
"stop this run".

## Decision

An external interruption is marked, not inferred. `RunInterruptedError` is a public error class,
branded under [ADR 0028](0028-brand-public-errors-across-module-instances.md) so a second module
instance's marker still counts. The CLI's first signal aborts with
`RunInterruptedError('Workflow interrupted by <SIGNAL>.')`, and tick's deadline timer aborts with
`RunInterruptedError('Tick timeout reached.')`. Embedders opt in by aborting `RunOptions.signal`
with it; any other abort reason keeps the old behavior.

The runner keeps its existing test for an interrupt-caused failure (the run signal aborted and the
caught error is a cancellation) and its drain sequence unchanged. Only when that test holds and the
signal's reason is the marker does it save, after the drain:

- status `suspended` with `nextWakeAt` set to the clock's now, so tick's ordinary due check picks
  the run up without a new readiness rule;
- `interruptedBy: { reason, at }`, a new optional record field (no format bump, like
  `staleRecovery`), which a later execution clears when it starts;
- no `error`, `rootCause` or `recoveryHint`, because nothing failed, and a `run.suspended` lifecycle
  event and execution outcome.

The runner still rejects with `WorkflowRunError`, and the executor maps a saved `suspended` run with
`interruptedBy` to `workflow.interrupted` (exit 130), so `execute`, `resume` and embedders see the
same rejection and exit as before. A workflow-scoped `CancelledError`, an unmarked abort and an
explicit failure still save `cancelled` or `failed`, even when a marked signal also fired. The
forced second signal is unchanged; the `running` record it can leave is covered by tick's stale
recovery.

The interrupted suspension keeps `staleRecovery`. A clean suspension or completion removes it
because they show the run can progress; an interruption shows nothing. The counter only grows on a
stale `running` recovery and resets when completed steps grow, so keeping it is conservative and
otherwise harmless.

`nextWakeAt` is always now, even for a run interrupted while it was parking a long sleep or a
question-only wait. The next tick imports it and it parks again; one extra import is simpler than
reconstructing the parked wake time on an error path.

Tick reports a resume that ends in an interruption as `suspended` with the reason as `message` (exit
75 with `--run`), including a deadline that fires after the claim but before the runtime reopens the
run. To avoid starting work only to interrupt it, tick stops claiming once less than a claim margin
of its timeout remains (`--claim-margin`, default 10% of `--timeout`, `0ms` disables it). Ready runs
seen inside the margin are left untouched and reported as skipped `deadline`, and `--watch` ends
when the margin starts. Since #205 the scan does not let those reports overrun the timeout: inside
the margin tick reads each record but skips the lock, orphan, crash-loop and source checks, and
after the deadline it reads no more records, reporting each remaining run as skipped `deadline` with
a message instead of dropping it.

## Consequences

A long step under a periodic tick makes progress across ticks only through its completed steps: an
interrupted effect is re-run by the next tick under the usual at-least-once contract, and its
partial external effects remain. Operators size `--timeout` for the longest step one tick should
finish. `inspect --watch` on an interrupted run ends as suspended with exit 75, not 130. A deadline
that fires between tick's stale-recovery save and the runtime opening the run can leave a `running`
record, which the next tick counts as another stale recovery; the claim margin makes that rare.
There is still no operator `workflow cancel` (#142), so a run someone interrupted on purpose is
resumed by the next tick. (Amended by
[ADR 0039](0039-cancel-a-live-run-through-a-token-bound-request.md): `workflow cancel` now ends a
live local run as `cancelled` through a request bound to its owner's lock token; a plain signal
still suspends.) See [waits](../waits.md) and the [CLI contract](../cli-contract.md).
