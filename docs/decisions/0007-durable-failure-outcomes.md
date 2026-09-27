# 0007: Explicit durable failure outcomes

**Status:** Accepted. Extends ADR 0005/0006; supersedes their current checkpoint-format choice.

## Context

A caught effect failure is not replayed by the original throwing API. When that failure heals on
resume, the body can choose a different fallback or pass different data into a completed effect.
Recording successful effects alone cannot preserve these decisions. JavaScript races introduce the
same problem through timing, and draining a losing effect does not cancel it.

## Decision

Add `onError: 'return'` to local and agent calls. Success returns `Settled<T>` with `ok: true` and
the normal validated value. Final failure, after applicable retries, commits a `settled-failed` step
with a plain `StepError` (`message`, `kind`, total `attempts`) before returning `ok: false`. Replay
returns the saved failure with no callback/harness invocation. `onError` participates in identity.
Both completed success and settled failure are terminal: their identities are immutable, they must
be visited on replay, and matching fork reuse can copy them with provenance. Prefix invalidation
provides the deliberate way to reconsider a saved failure and its downstream decisions.

Cancellation is not a settled outcome. External abort, sibling cancellation, and typed cancellation
errors reject and leave retryable failures. Authoring/identity errors occur before invocation and
reject. Configuration failures reject too, leaving the step unfinished so a corrected configuration
runs it live on resume: a missing harness, and any validation a harness adapter performs before
launch. Adapters signal the latter with the exported `ConfigurationError` (`CliHarness` does so for
a relative `cwd`, invalid options, and output schemas its provider cannot enforce); any other
adapter error is an ordinary effect failure. Checkpoint failures also reject; no uncommitted outcome
is returned to the body, and domain error precedence remains as specified in ADR 0003.

The existing runtime retry loop accepts `retry.on` categories. Omission retains opt-in retry of all
ordinary effect errors; an empty list disables retries. Filters and attempt limits remain policy,
outside identity. Save every attempt's error/category and available failed-call usage. Categories
come from structured protocol metadata, error types, or process codes; unclassified prose remains
`unknown`. Adapters can supply `HarnessErrorDetails.kind`. Retries use fresh sessions and never roll
back earlier edits.

Do **not** infer automatic stickiness from which Error object or cause chain escaped the body. A
wrapper error or an ordinary exhausted retry loop makes that inference ambiguous and can turn
retryable work into a permanently replayed failure. Throwing remains retryable and handled throwing
failures remain the author's responsibility. There is no `--retry-failed` or
`RunOptions.retryFailed`: explicit terminal decisions are reconsidered via a new fork and
invalidation, preserving the source.

Do **not** ship `ctx.race` in this change. Winner journaling, branch-scoped cancellation and
terminal loser rules are explicitly deferred to [#57](https://github.com/plx/quiet-choir/issues/57).
Forbid `Promise.race`/`Promise.any` over durable operations in author guidance. Use `timeoutMs` with
a settled agent call for replayable timeout decisions; tests flip the agent's would-be timing on
resume and verify the recorded timeout still selects the same downstream path.

Warn as soon as a previously failed step completes when later recorded IDs exist, naming both the
healed step and later IDs. Strict replay allows saved terminal outcomes but stops before the next
live effect. The end-of-body skipped-step error names healed steps too. This is a launch-order
heuristic: already running concurrent work can finish and a warning need not imply actual drift.

New checkpoints use format 4 because older readers cannot interpret the new terminal status. Formats
1–3 remain inspectable and are refused for resume/fork without changing their data. No implicit
migration is safe across the identity/error-mode change.

## Consequences

Explicit fallback and best-effort map results replay deterministically after failures heal. Existing
try/catch code must opt in when failures steer later work; generic JavaScript races remain unsafe. A
settled failure can let a run complete successfully and is not automatically retried even when retry
policy increases. Per-attempt diagnostics remain available independently of terminal outcome. The
upcoming map settle mode (#43) can build on the same terminal failure representation.
