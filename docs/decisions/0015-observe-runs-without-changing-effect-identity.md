# 0015: Observe runs without changing effect identity

Status: Accepted

## Context

Supervisors need timing, resolved requests, progress, usage, and root-cause attribution without
parsing full checkpoints or treating every resumed log as new work. The runtime already has
first-use sequence, attempt history, identity-based root causes, and cancellation status. The
issue's older format-2 proposal predates the format-5 contracts introduced by earlier tickets.

## Decision

Advance the checkpoint format to 6. Extend existing attempt history and cancellation status instead
of duplicating them. Read formats 1–5 without permitting resume/fork reuse. Keep semantic IDs and
fingerprints stable; observations are outside identity. Record latest step timing/request/stack,
per-attempt usage and execution, and a body-execution ledger. Retain reported usage after response
validation errors; distinguish unknown usage from measured zero and fork reuse from local work.

Implement synchronous `phase` and `log` with owned asynchronous saves. Scoped phases use a separate
AsyncLocalStorage context, independent from name and cancellation scopes. Phase/log signatures and
maximum occurrence counts identify kth-entry replay across executions without depending on order.
Cap payloads at 500 entries, retaining compact counts after eviction. Drain observation writes with
owned work; failure to persist remains infrastructure failure. A failed final completion save must
not leave a claimed completion event in a later failure snapshot.

Extend WorkflowEvent with timestamps, execution IDs, and lifecycle/phase/log notifications. The
existing observer contract remains unawaited and failure-isolated. Persist stacks/cause chains and
name the root effect in WorkflowRunError; preserve original inside-body rejections. FailureOrigins
continues to attribute diagnostics only. Valid late results remain completed after cancellation.

Derive dashboards from checkpoints plus read-only ownership checks. Stale is a projection, never a
new saved status. Unknown or remote owners are not assumed dead. Commands supply plain-data
inspect/watch/list plans; the framework-independent executor accepts live watch output separately.
Watch JSON is an explicit JSONL exception to one-document output, with terminal exits 0/1/130/3.
Elapsed-time ticks alone are not changes; no claim of lossless transition delivery is made.

## Consequences

Supervisors can block on a run, list stale owners, and inspect compact progress without importing
trusted workflow code. Whole-file writes still make high-volume logging expensive; compact counts
and histories can grow until the separate journal work. Prompt previews and log data make checkpoint
privacy salient. Elapsed attempt time includes admission/start-write waiting and is not a call
budget. Usage stays partial when providers omit metrics or execution dies before saving them.

The prototype deliberately refuses old execution epochs rather than silently filling guessed
metadata. New exported context methods require custom context implementations to forward them. The
Workflow Lab's shared helpers now use persisted phase/log observations without changing original
sources, prompts, effort settings, or fixture outputs. See [observability](../observability.md).
