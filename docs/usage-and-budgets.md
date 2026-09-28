# Usage and run budgets

`summarizeUsage(run)` reports all locally recorded agent attempts across executions, including
failures. Replay counts an attempt once; a fork excludes copied source attempts from its own spend.
`workflow inspect ID --json` adds this computed `usageSummary` to the checkpoint view. Text inspect
and `--json --summary` use the same data (`usage` in the compact view).

## Measurements

`AgentUsage.inputTokens` is total processed input for current native adapters; `outputTokens`
includes reasoning. `tokens` separates `uncachedInput`, `cacheRead`, `cacheWrite`, `output`, and
`reasoning`. The first four categories are disjoint where known. Reasoning is a subset of output, so
adding it again overcounts. Null means unavailable, including when an interrupted call might have
spent money. Zero is a reported value.

Claude token totals come from `modelUsage`, not the top-level `usage` block. The historical Claude
2.1.283 fixture has 937 uncached + 18,662 cache read + 3,006 cache write = 22,605 input tokens; the
top-level input field was only 19. `byModel` preserves each model's categories and `costUSD`; the
run-facing `costUsd` remains `total_cost_usd`. These are harness estimates, not invoices.

Codex preserves all five `turn.completed.usage` fields. The 0.157.1 local fake-API capture passes
through 100 input, 40 cached input, 20 cache-write input, 30 output and 12 reasoning tokens. The
[Responses documentation](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics#understand-the-response)
describes cached tokens within total input, and
[output accounting](https://developers.openai.com/api/docs/guides/agents-api/observability#what-contributes-to-cost)
includes reasoning. The disjoint cache-write partition is not established by that pass-through
capture, so Codex `uncachedInput` remains null. `costUsd` and effective model identity remain null
when the CLI does not report them. A requested model or alias is never assumed effective.

`model.requested` records the option after policy resolution; `model.effective` comes from native
evidence. `reported` retains native usage verbatim, including cache TTLs and cost basis, for later
reinterpretation. Custom harnesses may omit usage or individual measurements: the runtime fills
missing/invalid measurements with null and preserves JSON-compatible extra fields. Invalid non-JSON
fields produce normalization warnings. A usage typo does not discard a valid paid answer.

## Attempts and totals

Each `attemptHistory` entry is saved before invocation. Available usage survives a nonzero exit,
protocol error, timeout, cancellation, or rejected local output. Without a terminal usage report,
the entry remains unknown. After owner recovery, resume marks prior running agent entries
`interrupted`; their actual end time is unknown. A later success preserves earlier evidence.

The summary includes outcomes, known cost/input/output totals, category totals, unknown-usage and
unknown-cost counts, per-category unknown counts, and harness/model groups. Each metric sums its
known portion; all-unknown stays null and an empty group totals zero. Multiple effective models can
share one attempt, so model-group attempt counts are not additive. Model attribution is incomplete
when evidence is missing; `(unknown)` is an explicit bucket.

Older records fall back to saved step results and failed-attempt metadata and are flagged
`undercounted` when detailed history is absent. Such an attempt keeps the kind it ran under: each
redefinition records the earlier kind and attempt count. When an older redefinition lacks them, the
attempt is left out of provider totals but still counted in `legacyAttempts`. Old token counts
retain their historical semantics; `legacyTokenAttempts` warns against treating them as normalized
session totals. Uncheckpointed work cannot be recovered from counters. These summaries do not apply
price cards, reconcile subagents, or expose replay-sensitive `ctx.usage()` observations.

Usage validation is separate from the frozen three-field usage schema used in agent identity. This
change preserves fingerprints from the preceding runtime. Earlier isolation and diagnostics upgrades
still have their documented compatibility boundaries; this does not make those older completed agent
calls reusable. Storage format remains 7, replay contract 6.

## Stop new attempts after a threshold

```sh
quiet-choir workflow execute review.workflow.ts --run-id review \
  --max-run-cost-usd 5 --max-run-agent-attempts 30
quiet-choir workflow resume review --max-run-cost-usd 10 --max-run-agent-attempts 60
```

Embedded runs use `RunOptions.maxRunCostUsd` and `maxRunAgentAttempts`. Both default to unlimited,
are saved as `runBudget`, and stay outside identity. Omission on resume retains the saved cap;
`--max-run-cost-usd off` / `--max-run-agent-attempts off` (embedded null) clears one cap.
`execute --policy-reset` clears both along with other sticky rules. Zero allows replay/local work
but no new agent attempts. A fork starts with its own caps and excludes reused source spend.

Admission compares recorded reported cost and cumulative admitted attempts before adding an attempt.
With either cap enabled, the runtime reserves a limiter slot before the durable attempt setup,
including any metadata, transcript or worktree preparation. It releases the slot immediately after
the harness settles, before response validation and outcome saves. Reserving admission before setup
prevents queued requests from slipping past a newly reached threshold. Without run caps, the prior
invocation-only admission behavior remains unchanged. Queueing alone creates no budgeted attempt. An
admitted preparation failure does count as an attempt even if it never reaches native inference.

A refusal creates no step/attempt record and saves a run-level `budgetStop`. It cancels queued
admissions, lets all admitted agent attempts finish, then rejects with `RunBudgetExceededError`. The
stop latches for that execution: catches, settled effects and settled maps cannot turn it into
successful completion. The run fails rather than suspending. Resume with a higher cap replays
completed effects and continues; it does not reset cumulative spend or attempts.

This is an after-completion gate, not a hard billing ceiling. In-flight calls can overshoot, unknown
cost is not priced, and Codex reports no cost here. Pair the cost gate with the attempt cap and
concurrency limits. Per-call Claude limits help bound ordinary overshoot, but are also native
estimates rather than transaction limits. Every attempt still needs ordinary timeout/cancellation
handling, including custom harnesses which must settle on abort.
