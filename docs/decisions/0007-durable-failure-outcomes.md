# 0007: Explicit durable failure outcomes

**Status:** Accepted. Extends ADR 0005/0006; supersedes their current checkpoint-format choice.
Extended by [0008](0008-scoped-fan-out.md) for durable aggregate outcomes and scoped cancellation.
Amended by #274 (invalid-request, overloaded and the transient retry alias). Amended by #144
(healed-step dependents use launch and failure stamps, with a `seq` fallback).

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

Warn as soon as a previously failed step completes when recorded steps launched after its failure
exist, naming both the healed step and those IDs. A recorded step qualifies when its `launchStamp`
is at least the healed step's `failureStamp` (the settlement stamp of its first terminal failure
since it last completed; ADR 0006 describes the counter), so a sibling launched in the same tick as
the failing step is not flagged whichever settled first. When either stamp is missing (checkpoints
written before #144, or a failure saved between retries), that pair falls back to the earlier
launch-order rule: a higher `seq` qualifies. Strict replay allows saved terminal outcomes but stops
before the next live effect. The end-of-body skipped-step error names healed steps too. The rule is
a conservative watermark, not proof of dependence: a step launched after the failure by unrelated
control flow is still flagged, already running concurrent work can finish, and a warning need not
imply actual drift. `healedDependents` in `replay-decision.ts` encodes it.

New checkpoints use format 4 because older readers cannot interpret the new terminal status. Formats
1–3 remain inspectable and are refused for resume/fork without changing their data. No implicit
migration is safe across the identity/error-mode change.

## Consequences

Explicit fallback and best-effort map results replay deterministically after failures heal. Existing
try/catch code must opt in when failures steer later work; generic JavaScript races remain unsafe. A
settled failure can let a run complete successfully and is not automatically retried even when retry
policy increases. Per-attempt diagnostics remain available independently of terminal outcome. The
upcoming map settle mode (#43) can build on the same terminal failure representation.

[ADR 0020](0020-durable-waits-and-tick.md) adds one recorded winner among signal/poll/deadline
sources. Races among arbitrary durable effects remain unsupported.

## Amendment: invalid-request, overloaded and the transient alias (#274)

Provider failures that need different responses all classified as `unknown`: a misspelled model or
invalid effort (HTTP 400/404), an overloaded provider (500/529), and a Codex rate limit reported
only as prose. `retry.on` therefore could not mean "transient failures only", and a `retry` without
`on` retried a request that can never succeed.

Two kinds join `ErrorKind`. `invalid-request` covers HTTP 400, 404 and 422; `overloaded` covers 500,
502, 503 and 529. 408/504 stay `timeout`, 429 stays `rate-limit`, and other statuses stay `unknown`.

`ProtocolFailure` gains an optional, adapter-owned `kind` for failures whose protocol metadata is
insufficient. `HarnessError.kind` is `HarnessErrorDetails.kind`, else `failure.kind`, else the
status and terminal-reason mapping. The prose exception lives in the built-in adapters' protocol
layer (`src/harnesses/protocol.ts`), never in generic runtime code: Codex's own terminal errors that
begin `rate limit exceeded`, and a notice-only failure whose last notice is a
`Reconnecting... n/m (rate limit exceeded ...)` reconnect, are `rate-limit`; a Codex
`invalid_request_error` and Claude Code's `[claude-code:unrecognized_model]` stderr tag are
`invalid-request`. These are fixed prefixes that codex-cli and Claude Code print themselves
(recorded on codex-cli 0.157.1 and Claude Code 2.1.283), so text quoted inside an unrelated error
cannot change its kind; if the CLIs change the wording, classification degrades to `unknown`.
`errorKind()` still trusts only structured kinds.

`retry.on` accepts the alias `transient`, which stands for `rate-limit`, `overloaded` and `timeout`.
It is a filter, not a kind: saved failures and attempt kinds never contain it, and resolved and
persisted policies keep it unexpanded, so the expansion happens only in `classifyAttemptFailure`.
Omitting `on` now retries every non-fatal kind except `invalid-request`; an explicit
`on: ['invalid-request']` still retries it. Retry remains policy, so step identities do not change.

The checkpoint format does not change. Older records validate under the widened enums; records that
contain the new kinds or the alias need this runtime, which the 0.0.0 prototype accepts.
