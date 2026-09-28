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

Names are captured at invocation, before policy resolution or asynchronous work. Scope and named-map
prefixes compose explicit leaves; never allocate IDs from completion-order counters. Keep naming
separate from cancellation ownership. Bound views preserve nested prefixes only inside their own
binding, and never snapshot the current signal. Named-map keys are all validated before work starts;
settled identity hashes original mapper source and resolved keys. Legacy unscoped IDs/fingerprints
remain semantically compatible with format-5 identities; execution gates require format 6. See
[ADR 0009](../../../docs/decisions/0009-scoped-step-ids.md).

Agent admission is run-wide (or shared explicitly across runs). Only Harness.invoke holds a slot;
never acquire in a mapper, local effect, sleep, replay path, retry backoff, or checkpoint write.
Queued cancellation follows the captured scope. Release in finally before processing responses.
Admission events are live diagnostics, not durable transitions. See
[ADR 0012](../../../docs/decisions/0012-agent-admission.md).

HarnessInvocation owns durable child registration under the run lock and carries run/step/attempt
identity. Register before task input; registration failure aborts scheduling as infrastructure,
never retry/settled data. Preserve successful results while retaining uncertain cleanup records.
Inspect and recover recorded children before deleting a dead/released owner's lock. Never signal
unverified recovery identities or a known reused PID. Signal handlers remain a CLI/embedder concern;
live supervision stays outside serializable plans. See
[ADR 0013](../../../docs/decisions/0013-process-ownership.md).

Phase/log observations have no durable IDs or fingerprint components. Own and drain their saves,
including late callbacks, before releasing the writer. Keep scoped phase attribution separate from
names/cancellation and capture it before asynchronous request preparation. Retain kth-occurrence
replay counts after payload eviction; never claim a completion that failed to commit. Read-only
stale status is derived from ownership, not written into a checkpoint. See
[ADR 0015](../../../docs/decisions/0015-observe-runs-without-changing-effect-identity.md).

Questions pin their full identity even while waiting. Registration, non-question effects, and
checkpoint writes count as active; a promise blocked on an external answer does not. Suspend only
after stable quiescence and a final inbox scan. Never reject questions to signal suspension or abort
siblings for a human wait. Close leftover continuations, stop polling, drain writes, save
suspension, and release ownership. Body completion withdraws open questions; real failure retains
waiting questions. Keep abandoned promises excluded from error-path drains after close. Only the
owner ingests inbox files with the actual Zod schema; lock-free writers validate early from stored
JSON Schema and publish exclusively. See
[ADR 0018](../../../docs/decisions/0018-durable-questions.md).
