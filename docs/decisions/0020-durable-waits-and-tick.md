# 0020: Resolve external readiness in one durable wait

## Status

Accepted. Extends [ADR 0018](0018-durable-questions.md), retaining question identities and inbox
ownership. Supersedes the in-process-only sleep behavior in
[ADR 0002](0002-durable-external-workflows.md). Storage format 7 and replay contract 6 remain.

## Context

Memoized reads are correct for branch decisions but an occurrence-indexed step per nonterminal poll
accumulates irrelevant history. Throwing to wait fails a run. Racing durable promises can choose a
different winner on replay, and live-clock sleep calculations change identity on resume. A local
periodic caller must identify due runs without paying for source imports or starting competing
writers.

## Decision

Expose `now`, `wait`, `sleepUntil`, and bounded `poll`; new `sleep` calls use the same coordinator.
One wait stores its pinned identity, deadline, count, latest bounded note, and next check. An
eligible signal wins before a poll, then deadline. A missed deadline still permits one final
current-state poll; the winner commits before its promise resolves and is never re-evaluated on
replay. A signal delivered after the pinned deadline is quarantined like any other invalid delivery,
since the deadline is fixed and the late answer can never become eligible. Polls perform read-only
observations under the nested-operation guard. Timer naps never save state.

Quiescent waits suspend without unwinding or cancelling siblings. Waits due within 1000 ms stay
live; explicit block mode keeps all waits live. Run-level nextWakeAt is derived from open registered
waits. Clock injection controls durable time and timers. Preserve completed legacy sleep replay and
the blocking bridge for unfinished legacy sleep records.

Tick performs plain-data due and source-byte checks, then claims the existing writer lock before
loading the stored entrypoint. It rechecks under ownership and transfers that owner to the runtime.
No second lock, background service, distributed claim, or automatic source acceptance is added. A
bounded watch combines filesystem inbox events with deadline/fallback timers. Individual run
failures remain data in batch tick results.

Tick also recovers runs whose owner is gone. A pure classifier (`recovery-decision.ts`) shared with
the derived stale display decides whether a lock is free, reclaimable, blocked by live or unverified
orphans, or held. Reclaimable locks go through the ordinary lock recovery of
[ADR 0013](0013-process-ownership.md), without killing orphans. A record still `running` under the
new ownership is a stale recovery: before resuming, tick durably saves a `staleRecovery` counter
with the completed-step baseline. Three consecutive recoveries without a new completed step stop
automatic recovery until an explicit resume; a clean suspension or completion removes the counter.
Only tick writes it, under ownership; the stale status itself stays derived.

Tick's deadline interrupts in-flight resumes into resumable suspensions that are due at once, and a
claim margin (default 10% of the timeout) stops new claims near the deadline, reporting ready runs
as skipped `deadline`. See [ADR 0029](0029-persist-interruptions-as-resumable-suspensions.md).

Operator shell hooks receive committed wait-open and run lifecycle events. A persisted notifiedAt
marker deduplicates first-open attempts; delivery is best-effort and can be lost across a crash.
Hook failures cannot change workflow outcomes. Business messages remain explicit idempotent steps.

## Consequences

Readiness checks keep one wait record regardless of count, while existing body-execution diagnostics
still grow across resumes. There is no history compaction, continuation snapshot, or revalidation of
old decisions. Signal timestamps trust the existing filesystem boundary. Actual latency depends on
clock behavior and tick frequency. Trusted code may violate read-only guidance; the engine can
prevent nested context operations, not arbitrary JavaScript side effects.

Source changes can strand parked runs until an operator performs explicit recovery. Cron/launchd and
installed harness authentication are external concerns. No process means no active polling; tick
must be invoked by an operator or external scheduler. See [wait semantics](../waits.md).
