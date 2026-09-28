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
failures never become fallback values. Configuration failures are a missing harness or process
adapter, plus a `ConfigurationError` thrown by an adapter or worktree isolation for validation that
fails before launch. Retry filtering remains policy; retain every attempt's diagnostics. Do not
infer handling from JavaScript error identity/cause chains. See
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
settled identity hashes original mapper source and resolved keys. Unscoped IDs retain their
spelling; storage format 7 preserves replay contract 6. Agent identity now pins configuration
isolation, so pre-isolation completed agent calls cannot be reused merely by accepting source
changes. Flat format 6 migrates automatically; original format 1 verifies legacy identities during
migration. Formats 2–5 stay read-only. See
[ADR 0009](../../../docs/decisions/0009-scoped-step-ids.md).

Agent admission is run-wide (or shared explicitly across runs). Uncapped calls acquire only around
Harness.invoke. Budgeted calls reserve before durable attempt setup, check the run gate before
recording an attempt, and release before response validation/outcome saves. Never acquire in a
mapper, generic local effect, sleep, replay path or retry backoff. See ADR 0025 for this refinement.
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

Journal batches commit every observable outcome before resolving their waiters. Ordinary starts may
be unsynced, but sleep deadlines and questions may not. Commit snapshots before truncating covered
journal bytes; validate gaps/corruption and repair only a torn final line under ownership. Readers
must retry compaction sequence races and must not fall back to a completed migration marker when
current state is missing. Acquire legacy guards before current locks, hold both through
drain/release, and register all new children in the current lock. Keep storage sequence/version and
informational engine versions out of effect identity. See
[ADR 0019](../../../docs/decisions/0019-journal-storage-and-project-state.md).

Waits pin timing/source identity, persist one winner, and never checkpoint timer naps. In each scan,
an eligible signal precedes the poll, then deadline; after a missed deadline give the poll one final
check. A signal timestamped after the pinned deadline is quarantined like an invalid delivery, since
the deadline can never move to admit it, and tick must not keep rewaking the run over it. Poll
observers run under the nested-operation guard. Due-within-1000ms waits remain active; long waits
park under the same quiescence contract as questions. Error draining stops new checks without
aborting active siblings. Tick must claim the ordinary writer before importing source and transfer
that ownership to the runtime. See
[ADR 0020](../../../docs/decisions/0020-durable-waits-and-tick.md).

Exec depends on ProcessRunner, never a native spawn import. It shares durable registration with
agents but never their admission slots, grants, or usage. Keep command/cwd/env/input/exit contract
in identity and limits/retry in policy. Plain capture is bounded head/tail; structured output must
reject truncation. File receipts contain hashes, not write content; reads remain memoized snapshots.
Conditional rename is optimistic, not protection from unrelated writers. Guard bodies have terminal
journaled outcomes so an already replayed restore cannot be followed by a rerun mutation. See
[ADR 0021](../../../docs/decisions/0021-durable-commands-and-files.md).

Worktree isolation belongs above harness adapters and uses ProcessRunner for tracked Git commands.
Pin the logical base before any invocation; retries never reuse failed per-call directories. Shared
handle and integration locks span durable outcome saves, not only callbacks. A valid result after
abort still gets captured. Forks may reuse immutable changes, never another run’s handle ownership.
Git merge computations leave checkouts alone; only an explicit clean checkout target may update its
tree. Cleanup touches only ledger-owned caches/refs, and failed cleanup cannot repeat valid work.
See [ADR 0022](../../../docs/decisions/0022-runtime-owned-worktree-isolation.md).

Resolve restricted/inherit mode before agent identity and preserve it through checkout preparation.
Host environment values never enter semantic identity; explicit edits do. Persist only environment
names/digests in request diagnostics and capability manifests, keeping the private resolved profile
for live execution. Original format-one migration must not invent a completed agent’s isolation
mode. See [ADR 0023](../../../docs/decisions/0023-restricted-harness-configuration.md).

Persist predicted Claude UUIDs and first observed native IDs per attempt. Own private transcripts
and retain raw response/validation evidence before local validation. Transcript/session write errors
remain infrastructure failures; on-failure cleanup happens only after durable success and flushes
the deletion to the containing directory before marking the receipt unretained. Bound transcript
close/discard: a close that never settles is an infrastructure failure, a stalled discard only a
warning. Agent progress is not journaled. Keep extensible diagnostic keys and resource caps outside
identity; see [ADR 0024](../../../docs/decisions/0024-stream-attempt-evidence.md).

Usage normalization is runtime validation, separate from the frozen usage identity schema. Preserve
custom JSON extras and raw provider evidence; unknown measurements are never free work. Sum attempt
history once, exclude fork reuse, and flag legacy fallback. Budget refusals latch per execution and
wait for admitted agent outcomes before rejecting; never abort paid siblings or settle the stop as
workflow data. Resume marks prior running agent attempts interrupted. See
[ADR 0025](../../../docs/decisions/0025-attempt-usage-and-run-budgets.md).
