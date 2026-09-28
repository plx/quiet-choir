# 0018: Suspend at quiescence for external question answers

Status: accepted

Storage/layout and migration details below are superseded by
[ADR 0019](0019-journal-storage-and-project-state.md); the orchestration contracts remain.

## Context

Human decisions need the same durable IDs and replay guarantees as agent results. Throwing until an
answer arrives conflates an external wait with failure. Returning state for a new run can recompute
the very plan an operator approved. Catchable suspension exceptions can select durable fallback
branches or activate map cancellation.

## Decision

Add `ask` and `approve` as question effects, with fingerprinted presentation, subject, and schema.
Persist question data separately under `step.question` so agent request diagnostics retain their
existing contract. Questions pin identity even when unfinished. Their single registration counts as
one effect attempt; they have no adapter execution policy or adapter attempt-history entries.

Count active leaves, question registration, and checkpoint writes separately from tracked
continuations. Stable quiescence across two event-loop turns, followed by an inbox scan and a second
stability check, permits suspension. Waiting promises remain unresolved. Close the run, drain owned
writes/children, save `suspended`, and release ownership. `finally`/`using` in an abandoned body do
not run. Pure microtask chains drain before the check; non-effect I/O is outside this ownership
model. Operation drains can exclude registered waiting questions without losing registration or
unobserved-error checks. Successful bodies withdraw remaining questions; failures retain them.

Use a union result for embedders and exit 75 plus a self-describing document for the CLI. Reuse the
discriminated lifecycle event model for `run.suspended`; `step.waiting` follows question
persistence. Save minimal launch metadata now for resume by ID; retain flat checkpoint/inbox storage
until #56. Retain format 6 for this additive prototype slice. Its older readers have closed
kind/status enums and reject question records. Versions 1–5 remain readable but non-executable, as
before. #56 owns the next storage-version migration. No existing non-question effect identity
changes.

Deliver through private flushed files and exclusive hard links, without taking the run lock. The
owner alone consumes the inbox and writes checkpoints. Validate twice: stored JSON Schema without
code, then the real Zod schema at ingestion. Reject stale/malformed deliveries into retained
quarantine files and save bounded rejection diagnostics. Poll live at 200 ms so a question can
continue while unrelated effects run. Accepted files stay as audit data. Names are encoded IDs with
a hash fallback for filesystem limits.

Audience is a routing hint with a self-asserted human attribution guard, not authentication. Answers
stay untrusted data. Decline/stop decisions belong in the schema. New forks ask fresh questions; a
prior run's approval is not copied as authority for a new run.

## Consequences

Started siblings finish and checkpoint before suspension, preventing paid reruns caused solely by a
human wait. Resume replays plans and accepted answers before continuing under the same run ID.
Blocked mappers retain slots. Existing `sleep` remains active; general waits belong to #57.
Embedders must narrow the result union. CLI answer success reports delivery, not consumption, and
can race with withdrawal. Filesystem permissions remain the trust boundary and effects remain at
least once. Deadlines/defaults, blocking answerers, special SIGINT suspension, and a no-import
resume fast path remain later work.
