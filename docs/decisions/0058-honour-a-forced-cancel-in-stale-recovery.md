# 0058: Honour a forced cancel in tick's stale recovery

- Status: accepted
- Issue: #293
- Amends the Waiting and Force decisions and the Consequences of
  [ADR 0039](0039-cancel-a-live-run-through-a-token-bound-request.md), which left a force-killed
  owner's `running` record for stale recovery to resume.

## Context

ADR 0039's `workflow cancel` signals a verified owner and leaves a request bound to that owner's
lock token. The owner turns its first signal into a cancellation and saves `cancelled`. Two cases
skip that save. `--force` escalates to a second SIGINT after the timeout. A plain cancel whose
SIGINT reaches an owner already draining an earlier signal counts as that owner's second signal. In
both, the CLI's second-signal handler force-kills the owner's process groups and exits 130 without
waiting for checkpoints. The record usually stays `running` behind the dead owner's lock. Cancel
then removed its request and reported `run.unowned` with `forced`. The next tick's stale recovery
reclaimed the lock and resumed the run the operator had asked to cancel.

## Decision

The request outlives the owner it names, and tick's stale recovery honours it.

- **Binding.** The match is against the exact lock tick reclaims, never a lock-free read.
  `acquireLock` records the token of the dead or released owner it retired itself in the iteration
  immediately before its successful publish. It clears the value whenever a publish is contended
  again, so a lock that another process published in between is never inherited. `lockRun` exposes
  the primary lock's value as the internal `OwnedRunLock.reclaimedOwnerToken`; the legacy guard's is
  ignored. The internal helper `reclaimedOwnerToken(owned)` in `run-store.ts` reads it from the file
  store. The public `OwnedRunStore` and `RunStore` types are unchanged. A request matches only when
  its `token` equals that reclaimed token. Every acquisition draws a fresh token, so a request from
  an earlier acquisition never cancels a later execution.
- **Cancel keeps the request.** When the owner is gone without a terminal status, cancel looks at
  the lock once more. If the lock still carries the targeted owner's token (a dead or released lock
  left by a force-kill), cancel keeps its request and reports `run.unowned` with
  `details.requestKept: true`. The message says the next workflow tick ends the run as cancelled
  instead of recovering it. When the lock is gone or re-owned (for example an embedder owner that
  suspended and released its lock), cancel removes the request as before and reports
  `requestKept: false` with the existing "may resume" note. Cancel still never reclaims a dead
  owner's lock ([ADR 0057](0057-end-an-unowned-run-as-cancelled.md)).
- **Where tick checks.** For an unfinished run (stale `running`, or a due `suspended` run behind a
  dead lock, which an owner that saved its interruption just before the kill leaves), tick reads a
  lock-free hint after the held and orphans classification: a schema-valid request whose token is
  the token in the current `owner.json`. When the hint matches, tick skips the pre-open crash-loop
  and source checks. A forced cancel should stick even for a crash-looping or source-changed run,
  and cancelling needs no workflow code. The orphans skip and the claim-margin check stay, since
  tick never signals. After taking the lock and re-reading the record, tick honours the request if
  the record is `running` or `suspended` and the request on disk names exactly the reclaimed token.
  The hint only decides whether the pre-open checks are skipped; a request written after the hint
  was read still counts under the lock. Otherwise tick falls through to the existing post-open path
  (classification, the source check, the harness configuration preflight and the crash-loop
  decision).
- **One transition.** `saveCancelledUnderLock(owned, record, reason)` in `run-cancellation.ts` holds
  the under-the-lock body that `cancelUnownedRun` had. It reports a run that already ended, refuses
  an unfinished format-1 record and formats 2 to 5 with `run.incompatible`, applies `cancelRecord`
  with `{kind: "cancelled"}`, and saves durably, restoring the record if the save fails. Cancel of
  an unowned run and tick both use it, so a tick-cancelled record matches one the runner or cancel
  saved. It has `cancelled` status, the reason as `error`, a step-less `rootCause`,
  `recoveryCause: {kind: "cancelled"}`, settled child frames, and a new execution entry with a
  `run.cancelled` event. Steps and worktrees are left as they are. The reason is
  `Run <id> cancelled by workflow cancel (requested <at>); its owner PID <pid> exited before saving, so stale recovery ended it instead of resuming it.`
  Tick then removes the request by its `requestId`. A `run.incompatible` refusal reaches tick's
  existing catch and is reported as an `incompatible` skip, with the record left unchanged. As in
  ADR 0057, no notification command or event stream is delivered, because no execution runs.
- **Reporting.** `TickSkipReason` gains `cancelled`, with a message naming the request time and the
  dead PID. It is final, and `--run` exits 1, as for any run saved cancelled. Honouring a request
  uses no `--max-runs` attempt, writes no `staleRecovery` count and imports nothing. A `resumed`
  entry would claim that a resume started, and the `observed` count would hide what happened.
- **Scope.** Only tick honours the request. An explicit `workflow resume`, `execute --resume` or
  `start --resume` that reclaims the dead lock is a later operator decision: it retires the token,
  and the request becomes inert. So does `workflow unlock`, after which the lock is gone and nothing
  is reclaimed. Plain signals, tick deadlines and embedders write no request, so they keep
  [ADR 0029](0029-persist-interruptions-as-resumable-suspensions.md)'s resumable behaviour. The
  runtime still never reads cancel requests: `lockRun` only reports the reclaimed token, and the
  loader's tick decides.

## Alternatives

- **Cancel finalizes the run after the kill.** Cancel could take the dead owner's lock and save
  `cancelled` itself. ADR 0057 keeps dead-owner lock recovery (child inspection and lock retirement)
  out of cancel on purpose. Tick can also win the lock between the owner's death and any cancel-side
  claim, so tick would need the check anyway. And the cancel process may not be around: its wait can
  be aborted, or the operator's cancel was the second signal.
- **A lock-free match.** Comparing the request with whatever `owner.json` tick happened to read
  before taking the lock would let an acquisition that published and released in between inherit the
  old match. Binding to the token that `acquireLock` itself retired right before its publish closes
  that gap.
- **Honour the request in explicit resumes too.** An explicit resume is an operator choosing to
  continue the run after the cancel, and an `unlock` is an operator clearing the lock for a later
  writer. Treating either as a cancel would override that later decision.

## Consequences

- After a forced cancel, or a cancel whose SIGINT was the owner's second signal, the next tick ends
  the run as `cancelled` and does not resume it. A later tick only observes it.
- A narrow window remains between tick's retire of the dead lock and its own publish. Another writer
  could publish, run and release cleanly entirely inside it, so tick's publish is never contended
  and the reclaimed token still names the force-killed owner. A clean release leaves the record
  `running` only if that writer was interrupted before the runtime reopened the run
  ([#206](https://github.com/plx/quiet-choir/issues/206)), so its execution never ran the body. Tick
  then honours the request for that run. A writer still holding its lock when tick publishes
  contends the publish and clears the value. Like the PID-reuse window in
  [process lifecycle](../process-lifecycle.md), this is accepted.
- Skipping the pre-open crash-loop and source checks on a matching hint means a hint that no longer
  matches under ownership falls through to the post-open checks. A crash-looping run may then have
  its dead lock retired, where before it was left untouched. This is rare and harmless: the run is
  skipped as `crash-loop` all the same.
- The tick JSON contract gains the `cancelled` skip reason and the cancel failure gains
  `details.requestKept`, deliberate changes at version 0.0.0. There is no record format or schema
  revision change.
- A request left inert (after an explicit resume or `unlock`) stays on disk until a later cancel
  replaces it; it never matches. Showing pending requests in `inspect` and cleaning up inert ones
  remain out of scope, as do embedder owners that consult requests and remote-host cancel.

See the [CLI contract](../cli-contract.md) and [process lifecycle](../process-lifecycle.md).
