# 0013: Bound process cleanup and retain child ownership across runner death

## Status

Accepted. Extends ADR 0002's lock recovery and ADR 0003's cleanup warning policy.

## Context

A detached harness group can survive its runner, and inherited output pipes can survive their
leader. Waiting only for stdio `close` could overrun timeouts indefinitely. Reclaiming a dead
owner's lock without examining children could launch paid or editing work beside the original calls.

## Decision

Keep process ownership distinct from checkpoint replay. Each harness receives `HarnessInvocation`
with scope signal, run/step/attempt identity and a durable registration port. The CLI adapter
registers immediately after spawn and before task input; version probes use the same port with the
run's shared discovery signal. The lock stores exclusive, flushed child records until reaping is
confirmed. An explicit in-memory supervisor supports synchronous second-signal cleanup without
importing an adapter into the core. Shared platform process helpers live in `src/processes/`.

Leader exit stops the deadline. Drain output for at most two seconds; stop leftover groups on all
exit paths with TERM, a configurable three-second default grace, and KILL. A further 500ms backstop
closes inherited pipes and settles. Valid results survive cleanup warnings; unconfirmed process
records survive lock release with an explicit released-owner marker. Registry write failure aborts
scheduling as infrastructure failure and cannot be retried or settled as workflow data.

Use persistent INT/TERM/HUP handlers in the command adapter. First signal requests graceful drain;
second signal force-kills tracked groups synchronously and exits 130. Tolerate closed-terminal
EIO/EPIPE. Embedders explicitly own their own handlers and may supply a supervisor.

Recovery claims the existing exclusive recovery guard before examining child records. Refuse live or
unverified children (exit 3, `run.orphans`). An explicit `killOrphans` request stops only
identity-confirmed groups and verifies reaping before replacement work. Start-time mismatch marks
PID reuse and never authorizes a signal. Unknown identities are retained, including leaderless
surviving groups. Inspection reports owner and process liveness without changing checkpoint data.

## Consequences

This closes the common SIGKILL/relaunch double-execution path and preserves successful output when a
background helper inherits a pipe. It changes the prototype Harness port but preserves the format-5
checkpoint contract and completed-only zero-call replay. Native calls hold admission slots through
cleanup; process-free effects and callbacks retain their existing cancellation semantics.

Process groups do not contain escaped sessions, and a spawn-to-record crash gap remains. OS birth
checks have platform resolution and check-to-signal races; they are not pidfds or distributed
leases. Linux uses boot ID/start ticks, macOS boot time plus second-resolution ps birth time,
Windows process creation time. Unknown observations refuse automatic recovery. The prototype still
cannot promise exactly-once work, rollback filesystem effects, or interrupt arbitrary JavaScript.

See [process lifecycle](../process-lifecycle.md) for flags, the migration and recovery procedure.
