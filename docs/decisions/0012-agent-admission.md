# 0012: Bound agent admission across each run

## Status

Accepted.

## Context

A map's worker count only bounds that map. Nested fan-out and parallel helper workflows can create
many simultaneous full CLI processes. Checkpoint latency is an accidental throttle, not a reliable
bound. Admission must apply to every harness without making nested mapper bodies hold scarce slots.

## Decision

The core owns one in-memory eligible-FIFO agent limiter per run invocation by default, with total
`min(8, max(1, availableParallelism() - 2))` and optional provider ceilings. Embedded callers can
share a limiter across runs or supply their own admission policy. CLI flags become plain limits in
the execution plan. Limits are fresh invocation policy and stay outside identity and checkpoints.

Acquire immediately around `Harness.invoke` and release in `finally`. No slot covers metadata, local
work, mappers, sleeps, replay, retry delay, response validation, or checkpoint writes. Cancellation
removes queued requests promptly; admitted calls retain capacity until they settle. One abort
listener per queued signal avoids listener growth on large fan-outs, and uses Node's resistant abort
subscription so another listener cannot suppress cancellation.

Emit live admission request/acceptance events with provider counts, queued count and monotonic wait
time. These are distinct from persisted step transitions: queued attempts are already `running`.
Keep observer failures outside permit ownership and preserve scope-specific cancellation metadata.

## Consequences

Nested fan-out cannot multiply live agents beyond the shared cap or deadlock by holding slots in
mappers. Provider ceilings do not block unrelated eligible work. Queueing does not consume native
call deadlines, and changing caps on resume does not rerun completed effects. Sharing requires the
same limiter object; separate CLI processes remain independent. Admission provides a future hook for
spend gating without implementing spending or machine-wide scheduling here.
