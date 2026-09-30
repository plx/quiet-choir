# 0008: Scope map cancellation and journal settled items

## Status

Accepted. Extends [0004](0004-operation-ownership.md) and [0007](0007-durable-failure-outcomes.md).
Checkpoint format 5 supersedes format 4 for execution.

## Context

Run-wide cancellation on any mapper rejection kills unrelated work, prevents recovery through a
catch, and leaves partial writer edits. Recording cancellation as the initiating error obscures the
cause. Discarding valid results returned after abort also repeats work unnecessarily on resume.

Durable leaf failures alone cannot make a settled map replay consistently. A mapper can throw before
launching an effect, catch a child failure, or combine multiple effects into one outcome. Retrying
that mapper after a later run failure can change a downstream decision.

## Decision

Each map owns a cancellation scope combined with its parent's signal. AsyncLocalStorage carries the
current scope; effects capture its signal at launch and `ctx.signal` reads it dynamically. A map
never aborts the run controller. Run interruption and fatal checkpoint failure still reach every
scope.

Maps default to `drain`: stop scheduling after the first observed mapper rejection, let started
mappers and their owned descendants finish without signalling them, then throw `FanOutError`.
`failures` retain input positions, originating step IDs, and in-process errors; `unscheduled` lists
unstarted positions. Explicit `abort` signals only the map subtree and still drains it. A body-level
rejection also drains pending operations without cancelling them. Closed workflows refuse new work.

An action that resolves and validates is checkpointed as completed even after its signal aborts.
Actions that reject in an aborted scope are cancelled, with `CancelledError` and `cancelledBy`,
rather than inheriting the initiating step's message. Run `rootCause` attributes the escaping
failure; handled failures do not poison a later successful run. Error identity/cause tracking is
diagnostic, not the implicit durable handling inference rejected in decision 0007. CLI interruption
retains `Workflow interrupted.` as the run cause with a null step ID. (Since
[ADR 0029](0029-persist-interruptions-as-resumable-suspensions.md), a marked interruption saves a
resumable suspension with `interruptedBy` and no run cause; unmarked aborts keep this rule.)

`onError: 'settle'` requires an explicit run-unique map journal `id`. This deliberately adds
identity to the illustrative API in issue #43: unnamed completion-order counters cannot safely
distinguish concurrent/nested mapper-body outcomes. Drain and abort retain the existing positional
API and no collection journal. Map IDs do not change or prefix leaf IDs; broader ID composition is
issue #44.

A settled map hashes JSON item inputs, mapper source, optional version, and cwd, excluding
concurrency. Every item saves its whole JSON `Settled` outcome and the IDs of owned leaves/nested
journals, after draining and checking unobserved child failures. Failure values extend the existing
`StepError` with `stepId`. Ordinary mapper errors are durable; cancellation, infrastructure
(checkpoint and configuration) failures, and authoring guards reject. Resume returns committed items
without calling their mappers, claims owned records as visited, and retries only incomplete items.
Duplicate IDs, changed terminal map identity, and missing terminal maps remain replay errors. Each
journal takes a `seq` from the step counter, so a skipped committed map also triggers the pre-live
`replay.divergence` check before later live effects. Even an empty completed map has identity/path
protection.

Format 5 stores run `rootCause`, run/step/attempt cancellation states, and map item journals. Old
formats 1–4 remain inspectable but cannot resume or provide fork reuse. Forks start fresh map
journals and apply normal per-step reuse/invalidation rules; they do not silently reuse mapper-body
outcomes. Tail-recovery diagnostics recognize failed children contained by a committed map outcome.

## Consequences

Drain preserves completed sibling work and avoids interrupting concurrent writers because another
item failed. It can wait for the slowest mapper; callbacks that never settle can hold the lock
indefinitely. Explicit abort, deadlines, and interrupts can still leave partial edits.
First-interrupt draining and worktree isolation remain separate work (#48 and #59).

Settled maps trade larger checkpoints for stable aggregate decisions. Captured values and helper
implementations remain invisible to callback hashing; declare dependencies in items or bump version.
A committed item's child can remain failed/cancelled as diagnostic history while the item outcome
replays. Standalone ordinary catches outside a settled item still do not persist branch decisions.
Durable race winners remain out of scope (#57).

[ADR 0020](0020-durable-waits-and-tick.md) adds one recorded winner among signal/poll/deadline
sources. Races among arbitrary durable effects remain unsupported.
