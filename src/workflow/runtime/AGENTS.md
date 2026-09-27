# Runtime invariants

The checkpoint is a ledger of named effects, not a saved call stack. On resume, the body replays;
completed effects return saved, revalidated JSON. Step IDs, fingerprints, and the check for skipped
recorded completed steps jointly guard replay compatibility. Execution limits and retry are policy,
not semantic identity; unfinished identities may be redefined with history. See
[ADR 0005](../../../docs/decisions/0005-step-identity-and-policy.md). The CLI supplies the source
fingerprint; an embedded caller must supply its own. Local effects also hash callback source and
version, without claiming to capture closed-over values. Explicit code acceptance retains completed
step checks. Fork sources are read-only; prefix reuse must close synchronously on a miss, before
awaits allow concurrent launches. See
[ADR 0006](../../../docs/decisions/0006-code-change-recovery.md).

An effect can succeed externally before its checkpoint commits. Preserve the at-least-once contract
and stable run/step idempotency keys; atomic checkpoint writes cannot make external actions atomic.

One local writer owns each run. Mapper and body failures drain active work without cancellation by
default. Explicit map aborts affect only that subtree; run interruption cancels every scope. Effects
capture the scope signal at launch, while ctx.signal reads it dynamically. Valid results resolved
after abort still commit. All paths drain owned work before releasing ownership. Observers cannot
invalidate a committed effect. Changes to scheduling, serialization, or locking should preserve
these relationships, including on failure paths. The durability rationale is in
[ADR 0002](../../../docs/decisions/0002-durable-external-workflows.md).

A settled failure is a terminal branch decision, just like a completed result: identity and path
checks must preserve it on replay and fork reuse. Cancellation, configuration, and checkpoint-write
failures never become fallback values. Configuration failures are a missing harness or a
`ConfigurationError` thrown by a harness adapter for validation that fails before launch. Retry
filtering remains policy; retain every attempt's diagnostics. Do not infer handling from JavaScript
error identity/cause chains. See
[ADR 0007](../../../docs/decisions/0007-durable-failure-outcomes.md).

Settled maps require explicit journal IDs. Each committed item owns its leaf and nested-map IDs;
replay must claim those identities without re-executing the mapper. Drain and check ignored
operation failures before committing an item. Cancellation, storage, configuration, and authoring
guards must never become settled map data. Error identity/cause tracking attributes diagnostics
only; it does not infer durable handling. See
[ADR 0008](../../../docs/decisions/0008-scoped-fan-out.md).
