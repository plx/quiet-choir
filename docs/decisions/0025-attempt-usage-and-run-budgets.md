# 0025: Preserve attempt usage outside identity and gate new admissions

## Status

Accepted. Refines the budget-enabled admission window in [0012](0012-agent-admission.md).

## Context

Provider usage shapes differ, and Claude's top-level counters are not session totals. Extending the
fingerprinted result wrapper would invalidate completed work; rejecting missing metadata would
discard paid answers. Existing attempt history can retain usage without a second ledger. Run-wide
gates must preserve paid siblings even when a map uses abort-on-failure.

## Decision

Normalize measurements independently from the frozen current usage identity schema. Preserve raw
native measurements and custom JSON extensions. Use Claude model totals; retain Codex's five
reported fields without guessing unknown partitions, effective models, or prices. Reuse
`attemptHistory`; mark prior running agent entries interrupted on owned resume. Pure exported
`summarizeUsage` computes known partial totals, unknown counts and provider/model groups, excluding
fork reuse and warning on legacy fallback. Inspection uses this projection.

Save cost/attempt limits as sticky run policy outside all fingerprints. Compare them before a new
agent attempt; replays are exempt. When caps are enabled, reserve a limiter slot before the
attempt's durable setup and check cost/count again on admission. This deliberately extends 0012's
invocation-only window to include budgeted attempt setup (metadata, transcript, and checkout
preparation). Release before output validation and outcome writes. Uncapped runs keep 0012's
existing window. A refused queued request leaves no step or attempt record.

Latch a run-level refusal, cancel only queued admissions, drain all admitted attempts through their
outcome saves, and then throw `RunBudgetExceededError`. No active scope is aborted by the budget.
The execution ends failed even if workflow code catches the refusal. Resume can raise or explicitly
clear policy without rerunning completed calls. Unknown costs never become synthetic zeros in the
summary; the cost gate can only compare reported spend.

## Consequences

The attempt cap covers missing cost and startup failures, while the cost cap permits in-flight
overshoot. Budgeted setup can occupy capacity longer than an uncapped call; generic local effects,
maps, retry delay and outcome checkpointing still do not own invocation slots. No service, pricing
engine, subagent reconciliation, billing guarantee or deterministic usage effect is introduced.
Storage 7 and replay 6 remain unchanged. Usage extensions preserve the preceding agent schema
fingerprint; older isolation/diagnostic compatibility boundaries still apply.
