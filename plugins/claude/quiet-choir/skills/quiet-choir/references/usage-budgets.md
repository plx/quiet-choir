# Usage and run budgets

Use `summarizeUsage(run)` outside the replayed workflow body, or inspect the run without importing
its code. `workflow inspect RUN --json` adds `usageSummary`; `--json --summary` exposes the same
projection as `usage`. Text output includes attempt outcomes, known cost, unknown counts and
harness/model groups.

## Read the numbers

- Current Claude input totals sum `modelUsage` uncached input, cache reads and writes. The recorded
  2.1.283 example is 22,605 inputs, not the top-level 19. Cost remains `total_cost_usd`.
- Codex preserves total input, cached input, cache-write input, output and reasoning. A real 0.157.1
  CLI against a local fake API passed through nonzero values for all five. Its disjoint uncached
  category remains null because the cache-write partition is not established. Cost and effective
  model stay null when native output does not identify them.
- `tokens` contains `uncachedInput`, `cacheRead`, `cacheWrite`, `output`, and `reasoning`. Reasoning
  is already inside output. Never sum it twice. Null is unknown, never free work.
- `model.requested` records the resolved option; effective models come only from native evidence.
  `byModel` attributes categories and cost; `reported` retains raw usage including cache TTLs.
- Custom harnesses may omit usage/measurements. Valid JSON extensions survive; invalid known
  measurements become null with a diagnostic. Session IDs still use a value or explicit null.

`attemptHistory` retains usage from successes, protocol failures, nonzero exits, and responses which
failed local validation. Timeouts/cancellations keep whatever was available. Resume marks prior
running agent attempts `interrupted`; their actual end time and unreported spend are unknown. Every
retry is another attempt. Replaying one is not a new charge, and copied fork history is excluded
from the target's local total.

Totals are sums of known portions. `unknownUsageAttempts`, `unknownCostAttempts`, `unknownTokens`
and outcomes explain gaps. A wholly unknown metric is null; no attempts gives zero. Model-group
attempt counts can overlap when one call used several models. `(unknown)` is an explicit group.
Legacy history fallback sets `undercounted`; `legacyTokenAttempts` warns that older input counts
retain provider-specific meanings. This is not an invoice, price calculator or subagent reconciler.

## Gate new work

```sh
quiet-choir workflow execute review.workflow.ts --run-id review \
  --max-run-cost-usd 5 --max-run-agent-attempts 30
quiet-choir workflow inspect review --json
quiet-choir workflow resume review --max-run-cost-usd 10 --max-run-agent-attempts 60
```

The corresponding embedded options are `maxRunCostUsd` and `maxRunAgentAttempts`. Caps are sticky
run policy outside identity: omission on resume retains them, `off` (embedded null) clears one, and
execute's `--policy-reset` clears both along with other sticky policy. Zero permits replay and local
work but no new agents. A fork starts with its own caps and local spend.

A reached gate refuses new attempts without adding a step/attempt record, cancels queued admissions,
drains admitted work and throws `RunBudgetExceededError`. The run is failed even if the body catches
it; `onError: 'return'` and settled maps cannot consume this operator stop. Inspect `budgetStop` and
reported/unknown usage, then choose a higher cap to continue the same run. Completed calls replay.

With a run cap enabled, a limiter reservation includes durable attempt setup and native invocation;
release precedes result validation/outcome saves. This prevents queued calls crossing a newly
reached threshold. An admitted setup failure counts as an attempt even before native inference. Cost
is not a hard ceiling: active calls can overshoot and unknown/Codex costs are not priced. Pair cost
with attempts and concurrency limits. Custom harnesses must still enforce timeouts and settle on
abort so the run can drain.

Usage validation is outside the frozen prior usage schema used for identity. This upgrade preserves
fingerprints from the preceding runtime; it does not remove older isolation/diagnostics upgrade
boundaries. Do not read live totals inside workflow control flow to choose replay-sensitive
branches.
