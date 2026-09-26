# Agent concurrency

Every `runWorkflow` invocation has a shared admission limit for live `Harness.invoke` calls. The
default is `min(8, max(1, availableParallelism() - 2))`. This caps full agent CLI processes across
both providers, nested maps, `Promise.all` calls, and child functions receiving the same workflow
context. Version discovery is a separate, bounded diagnostic and does not hold a slot.

`ctx.map` concurrency still limits **mapper bodies in that map**. Nested maps can multiply active
mappers; the shared admission limit independently caps their live agents. Waiting mappers hold no
agent slots, so deeply nested maps work even with a limit of one. Local effects, durable sleeps,
replay, checkpoint writes, response validation, and retry backoff never hold slots. A retry acquires
a new slot; the previous attempt releases in `finally` when the harness returns or throws.

## Set the limits

```sh
quiet-choir workflow execute workflow.ts --max-agents 5 --provider-limit codex=1
quiet-choir workflow execute workflow.ts --resume --run-id review-1 --max-agents 2
```

Both flags require positive safe decimal integers. Repeat `--provider-limit provider=n` for several
providers; the last rule for a provider wins. Unspecified providers share the total ceiling. A
provider ceiling greater than the total does not raise the total. The CLI logs the effective limits
at info level before loading the workflow.

Embedded callers use `agentLimit: 5` or `agentLimit: { total: 5, perProvider: { codex: 1 } }` in
`RunOptions`. Limits are invocation policy, not workflow input, step identity or sticky resume
policy. Each invocation uses its supplied limits or the default. Changing them on resume preserves
completed effects. `--policy-reset` is unrelated.

To cap several runs in the same process, share an object:

```ts
import { createAgentLimiter, runWorkflow } from 'quiet-choir';

const limiter = createAgentLimiter({ total: 4, perProvider: { codex: 1 } });
await Promise.all([
  runWorkflow(first, { runId: 'first', input: {}, harness, agentLimit: limiter }),
  runWorkflow(second, { runId: 'second', input: {}, harness, agentLimit: limiter }),
]);
```

Passing the same numeric value or limits data to two runs creates two independent pools. Share the
limiter object when composing separate runs. There is no child-run primitive yet; ordinary helper
functions using the parent's context already share its pool. Separate CLI processes have separate
pools; this is not a machine-wide cap or a spending limit.

## Admission, cancellation and visibility

The limiter admits requests FIFO **among eligible providers**. A Codex waiter blocked by its
provider ceiling does not prevent an eligible Claude waiter from using a free total slot. Within one
provider, requests retain their order. Cancelled waiters leave the queue promptly and never invoke
the harness. Map aborts affect only that subtree; other scopes and runs sharing the limiter can
continue. An admitted invocation holds its slot until the harness settles, even after abort, so an
adapter that ignores cancellation cannot let its replacement exceed the cap.

Call `timeoutMs` starts inside the adapter after admission. Queue time does not consume that budget.
Cancellation still works while queued. Cancelled effects retain the existing `cancelled` status,
`cancelledBy` attribution, and separate run `rootCause`; they do not become settled fallback values
or ordinary failed agent attempts.

`--log-level debug` displays `agent.queued` and `agent.admitted` events. Embedded `onEvent` receives
those events with `provider`, `inFlight`, `queued`, and `waitedMs`, plus the usual run/step/attempt
IDs. `agent.queued` means an admission request was made; an immediately reserved slot may report
`queued: 0`. `waitedMs` is zero at that notification and the monotonic admission wait on
`agent.admitted`. Counts include reserved invocation slots; with a shared limiter they cover all
sharing runs. Observer callbacks are unawaited and cannot fail an effect or leak a permit.

These are live notifications, not checkpoint transitions. A queued attempt is already saved as
`running`; a checkpoint alone cannot distinguish queueing from an active native invocation.
`limiter.snapshot()` supplies detached live counts for embedded monitoring. No live queue or permits
are restored after process restart; replay reconstructs the workflow and admits unfinished work.

Custom `AgentLimiter` implementations can enforce additional admission policies by rejecting
`acquire(provider, signal)`. They must honor cancellation, return an idempotent `release`, and
provide accurate snapshots. quiet-choir acquires immediately before invoking the harness and
releases before handling responses or saving completion. Whole-run spend gates and per-stage
resource pools remain separate features.
