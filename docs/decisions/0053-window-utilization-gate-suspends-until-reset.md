# 0053: Suspend on the subscription-window gate until the window resets

- Status: accepted
- Issue: #168
- Builds on: [0025](0025-attempt-usage-and-run-budgets.md) (run budgets),
  [0029](0029-persist-interruptions-as-resumable-suspensions.md) (run-level suspension),
  [0020](0020-durable-waits-and-tick.md) (tick) and [0052](0052-run-record-schema-revision.md)
  (schema revision)

## Context

#156 records the Claude subscription windows (`diagnostics.rateLimit`: per-window utilization and,
when reported, a reset in Unix epoch seconds) but nothing acted on them. A subscription login that
exhausts its 5-hour or 7-day window gets 429s until the window resets, which can be days away. The
run caps of ADR 0025 measure USD and attempts and fail the run on refusal; retry cannot bridge a
reset (backoff is capped at 30 s). Suspension existed only for waits: `nextWakeAt` came from waiting
steps, written by the question pump, and the only other run-level suspension was ADR 0029's
interruption, which is due at once.

## Decision

**A third sticky run cap.** `maxWindowUtilization` (0 to 1; null or absent means unlimited) joins
`maxRunCostUsd` and `maxRunAgentAttempts` in `record.runBudget`. It comes from
`RunOptions.maxWindowUtilization` and `--max-window-utilization <0..1|off>` on `execute` (and so
`start`) and `resume`. Like the other caps it is outside identity, kept by a resume or tick that
omits it, cleared by `off` (null) and by `--policy-reset`. `launch.policy` is not its home: that
field is CLI metadata replaced on every execution and dropped by an embedder's resume (ADR 0035)
(until #258; an embedder's launch without a policy now keeps it, see ADR 0035's #258 amendment),
while `runBudget` is already merged by the runtime for every execution, including tick's.

**Per harness, at admission.** With the cap set, admission takes the budgeted path of ADR 0025.
After the two existing caps, `RunBudget.check(stepId, harness)` reads the admitting harness's latest
report (`latestRateLimits`, the same projection `inspect` shows) and evaluates it with the pure
`windowStop` in `rate-limit.ts`:

- a window's reset is its own `resetsAt`, or the event's `resetsAt` when the event's `type` names
  that window;
- a window whose known reset is at or before the runtime clock has expired and is ignored; a window
  with an unknown reset never expires;
- a live window is exceeded when its utilization is not below the cap (the rule of the other caps),
  so cap 0 refuses any live observation and cap 1 refuses only at 100% or more;
- no report admits, which covers the first attempt and Codex; `status` is never consulted.

Because the lookup is per harness, Codex is never refused by Claude's windows. Once any admission
trips the gate, the latch stops every harness, exactly as the other caps do: queued admissions are
cancelled, admitted attempts drain, and the refused step gets no record. `budgetStop` gains the
metric `maxWindowUtilization` and the optional `harness`, `window` and `resetsAt` (null when
unknown); `observed` is the window's utilization and may exceed 1.

**Suspend when every exceeded window has a known reset.** The stop names the exceeded window with
the latest reset, and its wake is `resetsAt * 1000` rounded up (a wake past the last persisted
millisecond counts as unknown). The runner takes a run-level suspension in its catch path, after the
ordinary drain (questions, operations, discovery, question close, observation flush, worktree
cleanup), when the latched error is a window stop with a wake, the caught error is that error (or
wraps it through causes) or a fan-out whose every non-cancellation failure derives from it, and the
run was neither interrupted nor cancelled and has no checkpoint error. It saves `suspended` with
`error`, `rootCause` and `recoveryHint` cleared, removes `staleRecovery` (a clean suspension), keeps
`budgetStop` as the durable reason, and sets `nextWakeAt` to the earlier of the wake and the waits'
own wake time. It assigns `nextWakeAt` after `questions.close()`, whose last update covers only the
waits, so the pump cannot overwrite it; a wait still parked keeps its earlier deadline or check, so
the gate never delays a timeout. It emits `run.suspended` with a message from
`windowSuspensionMessage`, which `--events` reuses, and returns the same suspended `WorkflowResult`
as the quiescent path, so the CLI exits 75 and tick reports `suspended` with `nextWakeAt`. Tick
resumes the run at the reset like any due suspension; by then the observation has expired and the
refused step runs. A resume before the reset refuses again before any attempt and suspends with the
same wake.

**Fail when a reset is unknown.** If any exceeded window has no known reset (Claude 2.1.285 reported
none per window), the run cannot wait for it: it fails with `RunBudgetExceededError` exactly as the
other caps do, and the message says the window reported no usable reset time. Resuming with a higher
cap, or `off`, continues.

**Block mode still suspends.** `--wait-mode block` governs workflow waits only. A reset can be hours
or days away, and a process blocked on it could not be resumed by tick, so the gate always suspends.

**Schema revision 2.** The nested `runBudget` and `budgetStop` shapes changed, so
`SUPPORTED_SCHEMA_REVISION` is 2 under ADR 0052's bump rule; the revision repeats revision 1's
top-level keys. `maxWindowUtilization` is optional in the schema, so revision-1 records read
unchanged (a fork's pinned read-view digest stays valid); the runner writes it as null on every new
or resumed record. A revision-1 build refuses to rewrite a revision-2 record, by design.

## Alternatives

- **A runtime-created wait step.** It would reuse the wait machinery, but it needs replay
  bookkeeping (marking it used to avoid "Replay skipped recorded steps"), and it adds a step to the
  record for something that is not workflow control flow.
- **A run-level wake time that `#updateWake` takes the minimum with.** The interruption path shows
  that one assignment after `questions.close()` is enough, with no new top-level field and no change
  to the question pump.
- **The threshold in `launch.policy` (ADR 0035).** It would be CLI-only and lost on an embedder's
  resume (at the time; #258 now keeps it across an embedder's resume that states none, but it stays
  CLI-only); `runBudget` is already sticky at the runtime level.
- **Sleep in-process until the reset.** A blocked process cannot be resumed by tick and holds the
  run's lock for hours.
- **Suspend on a 429 attempt failure, or gate on `status`.** Out of scope for #168: the reset of a
  rejected call is not parsed into a retry hint (`retryAfterMs` does not exist), and only `allowed`
  statuses have been captured.

## Consequences

- A run can now suspend without any pending wait: `pending` may be empty while `nextWakeAt` is set.
  `inspect` and the suspended document show the wake time and the saved `budgetStop`.
- A concurrent unrelated failure is never masked: only a run whose caught error is the latched stop,
  or a fan-out whose every non-cancellation failure derives from it, suspends. A step that failed
  alongside it still fails the run.
- The gate reads the last report, which describes the window at the end of that call, not a
  reservation; in-flight calls may push a window past the cap, as they can overshoot the cost cap.
- Reports with resets in the past are ignored by the injectable runtime clock, so tests and tick
  agree on expiry.
