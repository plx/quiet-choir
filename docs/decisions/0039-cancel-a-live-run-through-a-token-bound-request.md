# 0039: Cancel a live run through a token-bound request

- Status: accepted
- Issue: #288 (the cancel half of #142); amends the Consequences of
  [ADR 0029](0029-persist-interruptions-as-resumable-suspensions.md); the unowned refusal is
  superseded by [ADR 0057](0057-end-an-unowned-run-as-cancelled.md); a forced cancel's request
  outliving its killed owner is amended by
  [ADR 0058](0058-honour-a-forced-cancel-in-stale-recovery.md)

## Context

Since ADR 0029 the CLI's first SIGINT, SIGTERM or SIGHUP aborts a run with `RunInterruptedError`,
and the runner saves a resumable `suspended` run with `interruptedBy` that the next tick resumes.
That is right for a host going away, but it removed the only way to stop a run on purpose: an
operator who sends `kill -INT` to the owner PID shown by `inspect` now gets a suspension, not a
`cancelled` run. A signal also carries no data, so the owner cannot tell an operator's cancel from
an ordinary interruption, and signalling a PID read from a lock risks hitting a reused PID.

## Decision

`workflow cancel RUN [--force] [--timeout 30s] [--json] [--state-dir DIR]` ends a live local run as
`cancelled`. Cancel is distinct from an interruption: it is a durable request that only the
execution it names honours, delivered by a signal that only wakes that owner.

- **Guard.** Cancel reads the run record first. A run that already ended (`completed`, `failed` or
  `cancelled`) is a no-op success with `signalsSent: 0` and `owner: null`, so cancel is idempotent.
  An unfinished run that no lock holds is refused with the new `run.unowned` (exit 3): no live
  process owns it, so there is nothing to stop. (Superseded by
  [ADR 0057](0057-end-an-unowned-run-as-cancelled.md): cancel now saves such a run `cancelled` under
  its lock, and `run.unowned` means only that the owner exited.) A lock whose `owner.json` is
  unreadable, on a foreign host, released, dead or unobservable, without a recorded `osStartTime`,
  or whose recorded `osStartTime` differs from the live process's birth identity is refused with
  `run.locked` (exit 3); `error.details` carries
  `{lockPath, pid, host, state, osStartTime, reason}`, and the message points a dead owner at
  `workflow unlock`. No refusal writes anything or sends a signal.
- **Token-bound request.** For a verified owner, cancel atomically writes `cancel.json` in the run
  directory (`<runId>.cancel.json` beside a flat legacy checkpoint, like the inbox) with
  `{version: 1, requestId, token, pid, host, osStartTime, requestedAt}`, where `token` is the
  owner's current lock token. Every lock acquisition draws a fresh token, so a request left over
  from an earlier execution never matches a later one, in the same process (`tick --watch`) or a new
  one. The runtime never deletes a request before it holds the lock; a stale request is simply
  inert.
- **Signal.** Immediately before each signal, cancel re-reads `owner.json` and re-verifies the
  token, host, liveness and birth identity, then sends SIGINT to the PID only, never a group. The
  sender is `WorkflowExecutorOptions.sendSignal` (default `process.kill`), which tests stub.
- **Owner side.** `signals.ts` is unchanged: its handler is installed before the run ID is known,
  and tick executes many runs in one process. Instead, the executor wraps a live `workflow.execute`
  signal once, before type checking, with `cancellableRunSignal`. When the outer signal aborts with
  `RunInterruptedError` and a request names this process and the token in the run's current
  `owner.json`, the wrapper aborts the run signal with an unmarked
  `Error('Run <id> cancelled by workflow cancel (requested <at>).')`; any other reason, or no
  matching request, is forwarded unchanged. The check uses synchronous reads inside the abort
  listener and treats any read error as no request. The runner's existing unmarked-abort path then
  saves `cancelled` and emits `run.cancelled`, and the executor maps it to `workflow.interrupted`,
  so the owner exits 130. A request honoured before the runtime starts (tick holds the lock while it
  imports source) does not stop the executor: the runtime opens the run with the aborted signal and
  saves `cancelled` before the body starts.
- **Waiting.** Cancel polls the record and lock about every 100 ms, bounded by `--timeout` and by
  its own signal. A terminal status is success (exit 0) with that status: `cancelled` when the
  cancel took effect, `completed` or `failed` when the run ended first. An owner that is gone (lock
  released, token changed, process dead) without a terminal status is `run.unowned` with
  `details.reason: 'owner-exited'`, `signalsSent` and `forced`, and the message says the next tick
  may resume the run. The deadline reuses `watch.timeout` (exit 79) with
  `{timeoutMs, signalsSent, forced, pid}`; the failure document carries `ok: false` and the last
  saved `status`. `watch.timeout` already means "a bounded wait stopped while the run keeps
  running", and exit 79 maps to that one code. Every non-success of the CLI is a failure document
  with `error.code`, so the timeout is not a `workflow.cancel.result` with `ok: false`. Cancel
  removes its own request (only while `requestId` still matches) once the end is confirmed; after a
  timeout it leaves the request, so an owner whose event loop was blocked still honours it late.
  (Amended by [ADR 0058](0058-honour-a-forced-cancel-in-stale-recovery.md): when the owner exited
  without a terminal status but its lock still carries the targeted token, as a force-kill leaves
  it, cancel also keeps the request and reports `details.requestKept: true`, and the next tick saves
  the run `cancelled`.)
- **Force escalates.** `--force` does not send two signals at once, which would almost always kill
  the owner before it saves `cancelled`. If the timeout passes and the same verified owner still
  holds the lock, cancel sends a second SIGINT, which force-kills the owner's process groups and
  exits 130, then waits up to another `--timeout`.
- **Ownership exposure.** `RunOwnership.owner` and `RunLockView.owner` gain
  `osStartTime: string | null`, the owner's recorded birth identity. The lock token stays private,
  and the text output of `inspect` is unchanged.

## Alternatives

- **Finalize the suspended record after the owner releases the lock.** Cancel could wait for the
  ordinary interruption and then rewrite the `suspended` record as `cancelled` under the run lock.
  That races tick claiming the due run in between, and rewrites child frames and lifecycle state
  outside the runner that owns those rules.
- **Decide in `signals.ts`.** The CLI's handler is installed in `WorkflowCommand.init`, before the
  run ID is known, and tick runs several runs in one process with one handler. The executor knows
  the run of each execution, so the decision lives there.
- **Send two SIGINTs immediately for `--force`.** The second signal force-kills and exits before the
  runtime can save `cancelled`, so a forced cancel would nearly always leave `running`.
- **A request without a token.** A request keyed only by run ID would cancel whichever execution
  next received a signal, including a later execution after the request went stale, and clearing it
  at startup would need to happen before the lock is held, where it could delete a request meant for
  another live owner.

## Consequences

ADR 0029 still holds for plain signals, tick deadlines and embedders: with no matching request, a
marked interruption saves a resumable suspension. Its note that there is no operator cancel is
superseded by this command.

- The identity re-check right before each signal narrows PID reuse to the unavoidable gap between
  the check and `kill`, like the recovery signals in [process lifecycle](../process-lifecycle.md).
- A forced cancel, and a cancel whose SIGINT reaches an owner already draining an earlier signal (it
  counts as the second signal), force-kill the owner and can leave a `running` record. Cancel then
  reports `run.unowned` with `forced` and the status. Since
  [ADR 0058](0058-honour-a-forced-cancel-in-stale-recovery.md) the request stays bound to the dead
  owner's lock, and the next tick's stale recovery saves the run `cancelled` instead of resuming it.
- An embedder (`runWorkflow`) owner does not consult the request; if its handler aborts with
  `RunInterruptedError` the run suspends, and cancel reports `run.unowned` honestly rather than
  claiming success.
- Cancelling a run that tick is executing signals the tick process: the run ends `cancelled` and
  that tick pass stops (exit 130), as with any signal. The next tick continues with other runs and
  observes the cancelled one without resuming it.
- Ending an idle `suspended` run that no process owns was out of scope here (`run.unowned`);
  [ADR 0057](0057-end-an-unowned-run-as-cancelled.md) now ends it as `cancelled` under the run lock.
  Remote-host cancel stays out of scope.

See the [CLI contract](../cli-contract.md) and [process lifecycle](../process-lifecycle.md).
