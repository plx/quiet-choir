# Durable waits and ticking

A read that selects a workflow branch belongs in `ctx.step`. A read that only says “keep waiting”
belongs in a read-only poll. Use occurrence IDs derived from replayed data when selecting work in
successive rounds; an incomplete collection is an error, not an empty selection. Reconcile external
writes inside `ctx.step`, using idempotency keys, markers, or conditional APIs where available.

| Operation                                                                  | Saved result                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ctx.now(id)`                                                              | One clock reading, replayed unchanged                                          |
| `ctx.sleep(id, milliseconds)`                                              | `null`, with a relative timeout pinned on first open                           |
| `ctx.sleepUntil(id, epochMs)`                                              | `null`, with an explicit absolute deadline                                     |
| `ctx.poll(id, { input, schema, every, observe, timeoutMs })`               | A typed `poll` or `deadline` outcome; `deadline` can replace `timeoutMs`       |
| `ctx.poll(id, { input, schema, every, command, output, done, timeoutMs })` | The same outcomes; each check runs `command` ([command polls](#command-polls)) |
| `ctx.wait(id, { signal?, poll?, timeoutMs?, deadline? })`                  | One recorded winner, discriminated by `by`                                     |

At least one source is required. Relative timeout and absolute deadline are mutually exclusive. Each
sleep/poll/wait creates exactly one `wait` record; `now` creates a normal local step. Existing
`ask`/`approve` records retain their `ask` identity and raw answer shape, sharing the same wait
coordinator. Completed legacy sleep records still replay; unfinished legacy sleeps use their saved
wake time and the previous blocking path. New forks ask or wait afresh rather than copying a prior
run's external decision.

## Clock and identity

Use input, previously recorded data, or `await ctx.now('started-at')` to derive an absolute
deadline. Never compute a relative sleep from a live body `Date.now()`: a later replay changes its
identity. `RunOptions.clock` supplies `now(): number` and
`sleep(milliseconds, signal): Promise<void>`; the default uses system wall time. Custom clocks must
return nonnegative, integer epoch milliseconds through year 9999, and timers must reject promptly on
cancellation. Clock adjustments and laptop sleep can delay actual checks; deadlines do not guarantee
execution at an exact instant.

A wait fingerprints its original timeout/deadline, the signal's full question contract, and the
poll's input, schema, normalized spacing, and observer source. Captured dependencies belong in
`input`; source hashing cannot inspect closures. Waiting and completed identities are pinned even
with code-change acceptance. Use new IDs and immutable subjects for new decisions, such as an exact
commit SHA. Changing an explicit deadline under the same ID fails instead of silently extending it.
The poll's `observeTimeoutMs` and `onError` are execution policy, not identity: neither is persisted
in the wait request, and both may change on resume. A command poll fingerprints its prepared command
and `done` in place of an observer; see [command polls](#command-polls).

## Checks and outcomes

`observe` receives `{ signal, idempotencyKey, attempt, cwd, exec, previous }` and returns either
`{ done: true, value }` or `{ done: false, note? }`. It must read external state without writes,
nested context operations, or cached answers. The engine prohibits durable and observational context
operations inside observers; it cannot prevent arbitrary filesystem/network writes by trusted
JavaScript. Parse terminal results through the supplied Zod schema. Unknown object keys are
projected away before lossless JSON validation.

Run commands such as `gh pr view` through `context.exec(argv, options)` or
`context.exec.json(argv, { schema })` rather than spawning them yourself. They use the run's process
runner, are owned by the wait for orphan recovery, stop with the observation's signal (so
`observeTimeoutMs` and the deadline bound them), and are rehearsed and fixture-answered like
`ctx.exec`. They are not durable: every check runs them again. See
[commands inside a callback or observer](command-effects.md#commands-inside-a-callback-or-observer).
`{ live: true }` keeps one real under `--dry-run`. When the whole check is one command, a
[command poll](#command-polls) declares it instead. For pull request CI, reviews and merges,
[`quiet-choir/github`'s waits](github.md#waits) package these observers and their rules.

`previous` is the wait's persisted progress before this check: `previous.note` is the latest
nonterminal note, `previous.checks` the number of earlier checks (tolerated errors included), and
`previous.openedAt` the wait's first-open time. On the first check `note` is null and `checks` is 0.
The values come from the checkpoint, so they survive suspend, tick and resume, unlike closure state
in a freshly imported observer; a debounce such as "Completed on two consecutive checks" keeps its
flag in the note. `previous` is frozen. Keep any other timestamps you need in the note. The note's
type parameter `N` is not inferred from the notes you return: it is `JsonValue` unless you pass type
arguments to `ctx.poll`, so narrow or parse `previous.note`, for example with a Zod schema.

`every` is a positive integer interval, or `{ initialMs, maxMs, factor? }` with factor defaulting to
two. Spacing grows after nonterminal checks up to `maxMs`, measured from check completion. It is a
minimum interval, not scheduler latency. `ctx.poll` requires a finite time bound. General `ctx.wait`
can be unbounded. By default a thrown observer error fails the invocation; a later explicit resume
can retry the check, and `workflow tick` never retries a failed run. Nonterminal progress overwrites
`checks`, `note`, and `nextCheckAt`; notes are limited to 16 KiB. Naps do not write checkpoints. The
wait has one attempt; `checks` counts observations across resumes. Existing per-body execution
diagnostics still grow with resumes: this is not history compaction or a claim that all run state
stays constant indefinitely.

Each observation gets its own `signal`, and observers must honor it. It aborts when the run is
cancelled or interrupted, when the wait's deadline passes during the observation, and when the
poll's `observeTimeoutMs` elapses. `observeTimeoutMs` is a positive integer that defaults to 60
seconds (`60_000`); an observation never runs past a deadline still ahead of it. If the deadline
passes during an observation, the observation's outcome is ignored and the wait resolves by
`deadline` with the last note. If `observeTimeoutMs` elapses first, the wait fails like a thrown
observer, with an error naming `observeTimeoutMs`. Raise it for an observer that legitimately takes
longer than a minute. An observer that ignores its aborted signal is abandoned after a fixed
2-second grace, also when the run closes or is interrupted, and the run records a warning in
`waitWarnings` (shown in the completed result's `warnings` and by `inspect`). Its JavaScript may
keep running, but it can no longer affect the run.

`onError: { tolerate, classify?, retryAfterMs? }` opts a poll into tolerating transient observation
errors, such as a 502 from an API or a status file that is briefly missing. Only a rejected
observation and an `observeTimeoutMs` expiry are candidates; the expiry's error has code
`QUIET_CHOIR_POLL_OBSERVE_TIMEOUT`, so `classify` can treat it as fatal. `classify(error)` returns
`'transient'` or `'fatal'`; without it every candidate is transient. A tolerated error counts as a
check, leaves the note unchanged and is recorded as `lastError: { message, consecutive, at }` on the
wait. The next check follows the poll's normal spacing, or `retryAfterMs(error)` milliseconds when
that returns a finite number of at least zero (null keeps the normal spacing; `0` checks again at
once, bounded only by `tolerate` and the deadline). `tolerate` is a positive integer: the error
after `tolerate` consecutive tolerated errors fails the wait with its own message, as does a
`'fatal'` classification or a callback that throws. Any successful observation resets the count. The
count is persisted, so it spans suspend, tick and resume. The deadline still wins: a tolerated error
at or after the deadline, including on the final check after a missed deadline, resolves the wait by
`deadline` with the last good note. `classify` and `retryAfterMs` run under the same guard as
observers and cannot call context operations. Never tolerated, with or without a policy: run
cancellation or interruption, context-operation violations inside an observer, an `observe` result
of the wrong shape, a terminal value that fails the schema, and an invalid or oversized note. A
tolerated `observeTimeoutMs` expiry can leave the abandoned observer running while the next check
starts; the usual `waitWarnings` entry records it.

Each check uses fixed precedence:

1. A valid signal with recorded delivery time at or before the deadline wins. Signals use the same
   inbox, presentation, validation, and self-asserted actor as [questions](questions.md).
2. Otherwise a ready poll wins. If the process missed the deadline, it still gives the poll one
   final check against current state, even when its next scheduled check was later. That final check
   is bounded by `observeTimeoutMs` (60 seconds by default); if it does not finish in time, the
   deadline wins.
3. Otherwise an expired deadline wins, retaining the last nonterminal note.

The owner rescans signals after an awaited poll before committing its result. A late signal cannot
win; a late final poll can. Timestamp-based ordering trusts the filesystem writer, not an
independent authenticated clock. The recorded winner is final and replays without rechecking the
external system. Signal outcomes carry `value`, `at`, and `actor`; poll outcomes carry `value`,
`at`, and `checks`; deadline outcomes carry `at` and `note`.

Never `Promise.race` durable operations: replay resolves completed operations in a different timing
order. Competing readiness sources belong in one `ctx.wait`. `Promise.all` remains useful for
independent waits and siblings. No general durable race between arbitrary effects is provided.

## Command polls

A command poll declares its check instead of writing an observer. Each check runs one command
through the run's process runner, validates its JSON stdout with `output`, and passes the parsed
value to `done`:

```ts
const outcome = await ctx.poll('ci', {
  input: { pr },
  schema: z.enum(['pass', 'fail']),
  every: { initialMs: 30_000, maxMs: 120_000 },
  timeoutMs: 3_600_000,
  command: ['gh', 'pr', 'checks', String(pr), '--json', 'name,bucket'],
  output: z.array(z.object({ name: z.string(), bucket: z.string() })),
  commandOptions: { okExitCodes: [0, 8] }, // gh exits 8 while checks are pending
  done: (checks) => {
    if (checks.some((check) => ['fail', 'cancel'].includes(check.bucket)))
      return { done: true, value: 'fail' };
    if (checks.every((check) => check.bucket !== 'pending')) return { done: true, value: 'pass' };
    return { done: false, note: { pending: checks.length } };
  },
});
```

`command` is an argv or `{ shell }`, and `output` the Zod schema of its stdout. `commandOptions`
takes `cwd`, `env`, `inheritEnv`, `input`, `okExitCodes` and `maxOutputBytes`, but no `timeoutMs`
(`observeTimeoutMs` bounds each check) and no `onError` (the poll's `onError` applies). `live: true`
keeps the command real under `--dry-run`. `input`, `schema`, `every`, `observeTimeoutMs`, `onError`
and the time bound mean what they mean for an observer. `ctx.wait(id, { poll })` accepts the same
source, but there `done`'s output is typed `unknown`; `ctx.poll` infers it from `output`.

Each check runs the command as an observer's `context.exec.json(command, { schema: output })` would:
through `RunOptions.execRunner` (or `processRunner`), registered under the wait ID and attempt 1 so
orphan recovery covers it, and aborted with the observation's signal on cancellation, interruption,
the deadline or `observeTimeoutMs`. Its own timeout is `observeTimeoutMs` (60 seconds by default)
and its output cap 1 MiB unless `maxOutputBytes` sets another. Then `done(output, previous)` returns
`{ done: true, value }` or `{ done: false, note? }`, with the same frozen `previous` an observer
gets. `done` must be pure: it receives no context, and it runs under the observer guard, so a
context operation it reaches through a closure fails the run. The command runs again on every check;
only the terminal value and the last note are recorded.

A failing command throws an `ExecError`: kind `process` for a disallowed exit code or a signal,
`output-limit` when stdout exceeds the cap, and `schema` when stdout is not JSON matching `output`.
Its `diagnostics` keep the exit code and the last 1024 characters of stdout and stderr. A throwing
`done` is handled the same way. Both are rejected observations, so they fail the wait unless
`onError` tolerates them; `classify` can read `error.diagnostics.code`.

The wait request records `poll.command`: the prepared command summary (`exec`: the command, the
canonical absolute working directory, SHA-256 digests of the `env` overlay and of stdin,
`inheritEnv`, the sorted accepted exit codes and `structured: true`) and the JSON Schema of
`output`. `poll.observe` holds the digest of `done`'s source. Changing the command, its `cwd`,
`env`, `inheritEnv`, `input` or `okExitCodes`, `output`, or `done` under the same ID fails with
"wait changed; use a new ID"; `live`, `observeTimeoutMs`, `onError` and `maxOutputBytes` are policy.
The working directory is absolute, so moving the checkout under a waiting command poll is an
identity change, as for `ctx.exec`. As with an observer, `done`'s digest is its source text as
loaded, so it can differ between loaders. The command and its options are validated and its working
directory resolved when the wait opens, so an invalid command, an unknown option or a missing `cwd`
fails the wait before its first check. Observer polls never record `poll.command`, so their requests
and identities are unchanged.

Under `--dry-run` each check's command is synthesized from `output`, or answered by an exec fixture
rule matching the wait ID, and listed in the rehearsal's `commands` with `stepId` and `parentStepId`
set to the wait ID. With `live: true` it runs for real and is listed with `outputSource: 'live'`. A
`--stub-steps` pattern matching the wait ID still completes the wait without running the command.
`workflow pending` shows the command on the wait's row.

## Suspension and tick

After active effects and writes drain, long waits suspend without aborting siblings, rejecting the
wait promise, or unwinding body cleanup. `nextWakeAt` is the earliest deadline or next poll time, or
null for signal-only waits. Waits due within **1000 ms** stay in-process by default; a frequent poll
can therefore stay live indefinitely. `RunOptions.waitMode: 'block'` or `--wait-mode block` on
execute/resume keeps all waits live. The CLI records the mode, so a later `resume` or
`answer --resume` without `--wait-mode` keeps it; `tick` always suspends, for that execution only.
Await tracked operations; raw asynchronous body tasks do not keep a quiescent run alive. See
[question suspension](questions.md#suspend-and-resume).

```sh
quiet-choir workflow pending --state-dir /absolute/state --json
quiet-choir workflow tick --state-dir /absolute/state --json
quiet-choir workflow tick --state-dir /absolute/state --run review-1 --watch --timeout 540s --json
```

Tick reads checkpoints before importing any source. It resumes suspended runs whose `nextWakeAt` has
arrived or whose open signal has an inbox delivery, including runs interrupted by a signal or a tick
deadline (see [interruptions](#interruptions-and-the-claim-margin)), and recovers `running` runs
whose owner is gone. It checks saved source bytes before import, claims the ordinary writer lock,
and rechecks readiness and source bytes under ownership. Concurrent ticks cannot both import and
launch the same due run. The normal replay compatibility checks still apply. Changed source reports
`incompatible` without modifying the checkpoint; use explicit
[code-change recovery](decisions/0006-code-change-recovery.md).

Before claiming a run, tick classifies both of its locks (the current lock and the legacy guard). A
live, unknown or remote owner of either, incomplete or unreadable lock metadata, or a live, unknown
or remote recoverer (`recovery.json`) is skipped as `locked`. A dead or released owner whose child
records are all dead is reclaimed through ordinary lock recovery, so a due suspended run behind a
lock left by a crash is resumed; so is a run whose recoverer died, whose marker the next acquire
reclaims. A dead or released owner with a live or unverified child record is skipped as `orphans`,
without resuming the run or changing its checkpoint; tick never kills orphans. A `running` run with
no lock or a reclaimable lock is stale: its owner was killed (OOM, sandbox teardown, a SIGKILLed
tick). Tick recovers it without waiting for a due time, after re-reading it under ownership. There
is no `workflow cancel` yet, so a run someone killed on purpose is also resumed by the next tick.

Recovery of a stale `running` run is capped. Before resuming, tick durably saves a `staleRecovery`
counter `{ count, completedSteps, at }` in the checkpoint. The count grows by one while the number
of completed steps is unchanged, and restarts at 1 when a step has completed since the last
recovery. After 3 consecutive recoveries without a new completed step, tick neither resumes nor
writes the run and reports it as `crash-loop`; inspect it and run `quiet-choir workflow resume RUN`
to retry explicitly. A clean suspension or completion removes the counter. A due suspended run
behind a dead lock never touches it.

Tick uses stored entrypoint/tsconfig/cwd. Local-only and default CLI-harness runs can resume
directly; custom/fixture adapters require the original embedding application to supply that live
adapter. Tick does not infer native configuration files, change grants, accept code, or kill orphan
children. Completed, failed, cancelled, and not-yet-due runs do not import. A failed or cancelled
run needs an explicit resume, not an automatic retry on every cron pass. Batch unreadable-run errors
are reported per run.

Each live CLI execution records `harness.configDigest`, a SHA-256 of its resolved CLI harness
configuration (custom binaries, output limits, `scrubEnv`, `harnesses.<name>`), never the values.
`tick`, `resume` and `answer --resume` compare the configuration they supply with it, and an omitted
`--harness-config` means the defaults. A mismatch refuses with `run.incompatible` (tick reports the
run as `incompatible`, exit 1 with `--run`) without changing the checkpoint; `error.details` has
`previousConfigDigest` and `requestedConfigDigest`. So a cron line for a run started with custom
binaries or limits must repeat the same `--harness-config` on every `tick` call: tick reads no
`QUIET_CHOIR_HARNESS_CONFIG`. To accept a different configuration, pass
`--allow-harness-config-change`; on tick it applies to every run that invocation resumes, so pair it
with `--run`. `killGraceMs`, fixtures and the harness selection are not part of the digest, a binary
named without a `/` is digested by name rather than by its PATH lookup, and a harness kind change
stays governed by `--allow-harness-change` alone. Records written before the digest existed stay
resumable and adopt the next execution's digest.

The result reports what this tick did. `resumed` has one `{ runId, outcome }` entry per run whose
resume started, with outcome `completed`, `suspended` (plus `nextWakeAt`, and a `message` when an
interruption caused it), `failed`, `cancelled` or `incompatible` (each with a `message`). `skipped`
has `{ runId, reason }` entries for runs left alone: `not due`, `no longer due` and `deadline` (with
`nextWakeAt`), `locked`, and `orphans`, `crash-loop`, `incompatible` or `unreadable` (with a
`message`). `observed` counts runs that were already completed, failed or cancelled. Each run
appears in at most one entry; a later resume of the same run during `--watch` replaces its entry.
`--max-runs N` bounds executed resumes across the invocation; refusals before import do not count.
With `--run`, exit is 0 when the run completed (in this tick or earlier), 75 when it is still
pending (not due, suspended again or interrupted, locked, blocked by orphans, or skipped for the
deadline), and 1 when it failed, was cancelled, or is crash-looping, incompatible or unreadable.
`--watch` stops retrying a crash-looping run. Without `--run`, individual run outcomes do not change
exit 0. Command errors retain the [CLI error contract](cli-contract.md).

`--watch` waits for the next due time or an inbox filesystem event, with a one-second fallback scan
for missed events. `--timeout` defaults to 540s and accepts ms/s/m/h; it bounds the whole
invocation. Interruption asks active work to drain, so an uncooperative local callback can delay
exit. Watch is a bounded local process; nothing starts automatically after it exits. Install cron or
launchd if periodic ticking is desired, supplying absolute paths and a suitable executable PATH. For
example:

```cron
* * * * * cd /absolute/project && /absolute/node /absolute/quiet-choir/bin/run.js workflow tick --state-dir /absolute/state --json >> /absolute/tick.log 2>&1
```

### Interruptions and the claim margin

When tick's `--timeout` fires, it interrupts in-flight resumes with a marked
`RunInterruptedError('Tick timeout reached.')`. A first SIGINT, SIGTERM or SIGHUP to `execute`,
`resume` or `tick` does the same with `Workflow interrupted by SIGTERM.` and similar. The runtime
drains active work as for any interrupt, then saves the run as `suspended` with `nextWakeAt` set to
now and `interruptedBy: { reason, at }`, and `execute`/`resume` still exit 130. Tick reports the
resume as `suspended` with the reason as its `message` (exit 75 with `--run`). Because the run is
due at once, the next tick resumes it and completed steps replay from the checkpoint; only the
interrupted effects run again, under the usual at-least-once contract. `inspect` shows the run as
`suspended` with an `Interrupted at …` line, and `inspect --watch` ends with exit 75. A run
interrupted while it was parking a long sleep or a question-only wait is also due at once: the next
tick imports it and it parks again, at the cost of one extra import. A new execution clears
`interruptedBy`. Explicit or workflow-scoped cancellation (a `CancelledError`, or an embedder abort
with any other reason) still saves `cancelled`, and a failure saves `failed`; tick never retries
either. Embedders opt in by aborting `RunOptions.signal` with a `RunInterruptedError`. See
[ADR 0029](decisions/0029-persist-interruptions-as-resumable-suspensions.md).

`--claim-margin` stops tick from claiming a new run once less than the margin of its `--timeout`
remains, so a resume is not started only to be interrupted at once. It accepts the same ms/s/m/h
syntax, defaults to 10% of `--timeout` (54s for the default 540s), must be smaller than `--timeout`,
and `0ms` disables it. A ready run seen inside the margin is left untouched and reported as skipped
`deadline` with its `nextWakeAt`; the next tick picks it up. `--watch` ends when the margin starts
instead of idling until the timeout. Size the timeout for the longest step you expect a tick to
finish: a longer agent call is interrupted at the deadline and restarted by the next tick.

`workflow pending --json` returns legacy question projections and general waits distinguished by
`kind: "wait"`, including deadline, next check, count, last note, `lastError` (the latest tolerated
observation error with its `consecutive` count, or null), `command` (a command poll's command, or
null), optional signal, answer command, and `runStatus`, `delivery` (null for a poll or deadline
with no signal) and `next`; see the [pending row contract](cli-contract.md). A dry-run skips
timing-only waits and performs a poll's initial read-only observation, unless a `--stub-steps`
pattern matches the wait ID: then the observer never runs and the wait completes with a synthesized
value parsed by the poll schema. The observer's `context.exec` commands, and a command poll's
command, are synthesized (a command poll's from its `output` schema) or answered by exec fixture
rules during that observation; a call or command poll with `live: true` runs the real read-only
command and is listed in the rehearsal's `commands` with `outputSource: 'live'`. Unresolved external
waits suspend. Rehearsals never fabricate signals and do not invoke notification commands.

## Operator notifications

`--notify-command CMD` on execute/resume/tick, or `QUIET_CHOIR_NOTIFY_COMMAND`, runs `sh -c CMD`
with event JSON on stdin. Events are `wait.opened` (signal waits only), `run.suspended`,
`run.completed`, and `run.failed`. JSON includes run/step identity, timestamp, and state directory;
`wait.opened` includes `data.question`. Hooks start asynchronously and are drained after workflow
ownership is released. Each command has a 10-second deadline and 64 KiB combined output limit;
failures warn without changing the workflow result. No hook runs merely because tick inspected a
run.

`notifiedAt` is persisted before the first signal-open event, even without a configured hook. It
prevents repeated first-open notifications on resume, but a crash between persistence and delivery
can lose a notification. Run lifecycle hooks may repeat across resumes. These are best-effort
operator hints, not a delivery service. For example
`--notify-command 'cat >> /absolute/events.jsonl'` records local JSON events. A user may configure a
desktop notifier or HTTP command; quiet-choir ships no messaging integration. Business messages
belong in explicit idempotent workflow steps, and polling replies must validate the expected
author's authority before treating them as approval.

For a filterable stream of every step, phase, log, wait and run transition, use
[`--events FILE`](observability.md#event-stream) instead: one bounded JSON line per event, appended
to an owner-only file without running a command.
