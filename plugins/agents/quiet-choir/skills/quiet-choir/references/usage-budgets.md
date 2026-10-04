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

Totals are sums of known portions. `unknownUsageAttempts`, `unknownTokenAttempts` (no input or
output count), `unknownCostAttempts`, `unknownTokens` and outcomes explain gaps. A wholly unknown
metric is null; no attempts gives zero. Model-group attempt counts can overlap when one call used
several models. `(unknown)` is an explicit group. Legacy history fallback sets `undercounted` and
follows the kind recorded with each redefinition; an attempt whose earlier kind is unrecorded is
excluded from totals but still counted in `legacyAttempts`. `legacyTokenAttempts` warns that older
input counts retain provider-specific meanings. This is not an invoice, price calculator or subagent
reconciler.

## Gate new work

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts --run-id review \
  --max-run-cost-usd 5 --max-run-agent-attempts 30 --max-window-utilization 0.9
node "$QC_CHECKOUT/bin/run.js" workflow inspect review --json
node "$QC_CHECKOUT/bin/run.js" workflow resume review \
  --max-run-cost-usd 10 --max-run-agent-attempts 60
```

The corresponding embedded options are `maxRunCostUsd`, `maxRunAgentAttempts` and
`maxWindowUtilization` ([the window gate](#gate-on-the-windows)). Caps are sticky run policy outside
identity: omission on resume or tick retains them, `off` (embedded null) clears one, and execute's
`--policy-reset` clears all three along with other sticky policy. Zero permits replay and local work
but no new agents. A fork starts with its own caps and local spend.

A reached gate refuses new attempts without adding a step/attempt record, cancels queued admissions,
drains admitted work and throws `RunBudgetExceededError`. The run is failed (or, for the window gate
with a known reset, suspended) even if the body catches it; `onError: 'return'` and settled maps
cannot consume this operator stop. Inspect `budgetStop` and reported/unknown usage, then choose a
higher cap to continue the same run. Completed calls replay.

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

## Subscription rate-limit windows

Claude Code reports the 5-hour and 7-day usage windows of a subscription login in a stream
`rate_limit_event`. quiet-choir keeps the latest valid event of an attempt in
`attemptHistory[].diagnostics.rateLimit` as `{ status, type, resetsAt, windows }`; `windows` maps a
name such as `five_hour` or `seven_day` to `{ utilization, resetsAt? }` (a 0 to 1 fraction). Every
`resetsAt` is Unix epoch seconds as reported. Strings are cut to 64 characters, at most 8 windows
are kept, the latest valid event wins, and a malformed event is ignored without failing the call.
`agent.finished` and `--progress` lines carry it (`rate-limit: 5h window 1%, 7d 84%`),
`inspect --json --summary` adds an optional per-harness `rateLimits` map (absent when nothing was
reported; the latest settled attempt wins, failed ones included), and text inspect prints
`Rate windows claude: 5h window 1%, 7d 84% (allowed_warning; seven_day resets <ISO time>)` after the
usage lines. Only Claude reports windows; Codex attempts are unchanged.

### Gate on the windows

`--max-window-utilization <0..1|off>` (embedded `maxWindowUtilization`) refuses a new agent attempt
while the admitting harness's latest report has a live window at or above the cap. A window's reset
is its own `resetsAt`, or the event's when the event's `type` names it; a window whose reset has
passed (by the runtime clock) is ignored, and one with no known reset never expires. The check is
per harness: Codex and a run with no report are never refused by it, and `status` is not consulted.
A refusal latches for every harness like the other caps. When every exceeded window has a known
reset, the run then ends `suspended` (exit 75) with `nextWakeAt` at the latest reset (or an earlier
wait deadline), `budgetStop` naming `maxWindowUtilization`, the harness, window, `resetsAt` and
observed utilization, and a `run.suspended` message such as
`Run suspended until 2026-10-07T08:00:00.000Z: claude seven_day window at 84% reached --max-window-utilization 0.5.`
`workflow tick` resumes it after that time; an earlier `resume` suspends it again without a new
attempt. An unrelated failure alongside the stop, such as a sibling mapper that throws, still fails
the run. It suspends even under `--wait-mode block`. With an unknown reset it fails with
`RunBudgetExceededError`; resume with a higher value or `off`.
