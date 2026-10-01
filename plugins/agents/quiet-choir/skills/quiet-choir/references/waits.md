# Durable waits and periodic ticking

If the body does not branch on an observation, it is not a step. Record a snapshot or work selection
with `ctx.step`; use occurrence IDs derived from replayed data for successive selections. An
incomplete collection is an error, never “no work left.” Use `ctx.poll`/`ctx.wait` for
changing-state readiness. Their observer is read-only: no writes, nested context operations, or
stale HTTP caching. Reconciled/conditional writes belong in `ctx.step`.

## Choose a wait

| Need                                   | Operation                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Stable deadline anchor                 | `await ctx.now('started-at')`                                              |
| Relative delay pinned once             | `await ctx.sleep('pause', 60_000)`                                         |
| Absolute time from input/recorded data | `await ctx.sleepUntil('release-at', deadline)`                             |
| Read-only readiness with a time bound  | `ctx.poll(id, { input, schema, every, observe, timeoutMs })` or `deadline` |
| Competing readiness sources            | `ctx.wait(id, { signal?, poll?, timeoutMs?, deadline? })`                  |

Each sleep/poll/wait creates one wait record. `now` creates one local step. Wait identity includes
original timing, signal presentation/schema/subject, poll input/schema/spacing, and observer source.
Captured values still belong in poll input. Waiting identities cannot change; use revision-specific
IDs and immutable subjects. Never derive changing sleep durations from a body `Date.now()`.
`observeTimeoutMs` and `onError` are policy, not identity, and may change on resume.

`observe({ signal, idempotencyKey, attempt, previous })` returns `{ done: true, value }` or
`{ done: false, note? }`. Zod validates/project terminal values. `every` is a positive integer
interval or `{ initialMs, maxMs, factor? }`, with factor default two. `ctx.poll` requires timeoutMs
or deadline; `ctx.wait` may be unbounded. Progress overwrites checks/nextCheckAt/last note (16 KiB
limit); naps do not save. By default a thrown observation fails the invocation and can be retried on
explicit resume; tick never retries failed runs. Body-execution diagnostics can still grow across
resumes; there is no history compaction. Honor the observation `signal`: it aborts on run
cancellation, when the deadline passes during the observation (the wait resolves by deadline with
the last note), and after `observeTimeoutMs` (positive integer, default 60 s, never past the
deadline), which fails the wait like a throw. An observer that ignores its aborted signal is
abandoned after a 2 s grace, also when the run closes, with a `waitWarnings` run warning.

`previous` holds the persisted progress before this check: `note` (null on the first check),
`checks` (0 on the first check, tolerated errors included) and `openedAt`. It survives suspend, tick
and resume, so keep debounce flags and other timestamps in the note, not in closures. It is frozen;
`N` is not inferred from returned notes, so narrow or parse `previous.note` (for example with Zod).

`onError: { tolerate, classify?, retryAfterMs? }` tolerates transient observation errors. Candidates
are a rejected observation and an `observeTimeoutMs` expiry (code
`QUIET_CHOIR_POLL_OBSERVE_TIMEOUT`). `classify` returns `'transient'` (the default) or `'fatal'`. A
tolerated error counts as a check, keeps the note and sets the wait's `lastError` (`message`,
`consecutive`, `at`); the next check uses normal spacing or `retryAfterMs` (a finite number of at
least 0; null keeps spacing). Error `tolerate + 1` in a row, a `'fatal'` result or a throwing
callback fails the wait. A success resets the count, which persists across resumes. The deadline
still wins, including on the final check. The callbacks are guarded like observers. Never tolerated:
run cancellation or interruption, context-operation violations, wrong `observe` result shape,
terminal schema failures, and invalid or oversized notes.

Outcomes are discriminated by `by`: signal has value/at/actor, poll has value/at/checks, deadline
has at/note. A valid signal timestamped at or before the deadline wins first, then a terminal poll,
then deadline. The first check after a missed deadline still performs one final poll, bounded by
`observeTimeoutMs` (60 s default); if it does not finish, the deadline wins. Late signals lose; late
final polls can win. Recorded winners replay without rechecking. Signal timestamps trust the
filesystem writer. Never use `Promise.race` over durable operations: replay can choose another
branch. Use one multi-source wait. See the
[tested file-polling recipe](patterns.md#polling-and-deadlines).

## Operate a parked run

Long waits suspend after active siblings and writes drain, without cancelling siblings or unwinding
body cleanup. Waits due within **1000 ms** stay live by default. Frequent polls can therefore hold a
process. `--wait-mode block` on execute/resume (or RunOptions.waitMode) keeps all waits live. Old
saved sleeps replay; unfinished old sleep records retain the previous blocking path.

`workflow pending --json` includes general waits with kind=wait, deadline, nextCheckAt, checks,
note, lastError (latest tolerated error or null), and an optional signal/answer command.
`nextWakeAt` is the earliest deadline/check, null for pure signals. Use `workflow answer` for an
external signal, then tick when due. Human signals still need human routing; an agent cannot supply
human approval on its own authority.

```sh
node "$QC_CHECKOUT/bin/run.js" workflow tick --state-dir "$QC_RUNS" --json
node "$QC_CHECKOUT/bin/run.js" workflow tick --state-dir "$QC_RUNS" \
  --run review-1 --watch --timeout 540s --json
```

Tick reads state without imports, skips locked/not-due runs, verifies saved source bytes, and claims
the ordinary run lock before loading a due stored entrypoint. Concurrent ticks cannot launch the
same run. A lock left by a dead or released owner is reclaimed through ordinary lock recovery, so a
due suspended run behind it resumes; live or unverified child records give `orphans` instead, and
tick never kills them. A `running` run whose owner is gone (no lock, or a dead or released owner) is
stale: tick recovers it without a due time. Before each such recovery it durably saves a
`staleRecovery` counter; after 3 consecutive recoveries with no new completed step it stops with
`crash-loop` until an explicit `workflow resume RUN`. A completed step restarts the count, and a
clean suspension or completion removes it. With no `workflow cancel` yet, a run killed on purpose is
recovered too. Changed source reports incompatible without changing the checkpoint: use the explicit
[recovery path](durability.md#recovery-procedure). Tick does not retry failed runs, accept edits,
change grants, or kill orphans. Custom/fixture adapters need their embedding application; tick's
standalone CLI uses saved local/default-CLI provenance, not undisclosed adapter configuration. The
checkpoint stores a digest of the CLI configuration (`harness.configDigest`), never its values. Pass
the same `--harness-config` again on `tick` (as on `resume` and `answer --resume`) to reach a run
started with custom binaries or limits; an omitted one means the defaults. A mismatch is reported
`incompatible` (exit 1 with `--run`; `run.incompatible`, exit 3, on resume) and leaves the run
unchanged. `--allow-harness-config-change` accepts a new configuration; on tick it applies to every
resumed run, so pair it with `--run`. Tick reads no `QUIET_CHOIR_HARNESS_CONFIG`. `killGraceMs`,
fixtures and harness selection are not digested, and a kind change still needs
`--allow-harness-change`.

The JSON lists `resumed` entries (outcome completed, suspended, failed, cancelled or incompatible),
`skipped` entries (reason not due, no longer due, locked, orphans, crash-loop, deadline,
incompatible or unreadable) and an `observed` count of already-terminal runs, with each run in at
most one entry. With --run, exits are 0 completed (now or earlier), 75
pending/interrupted/locked/orphans/deadline, 1 failed/cancelled/crash-loop/incompatible/unreadable.
Without it, run failures are data and the batch exits 0 unless the command fails. --max-runs bounds
executed resumes across one invocation. --watch uses inbox events, next due time, and a one-second
fallback scan; --timeout (default 540s) bounds the invocation. Active callbacks must cooperate with
cancellation to exit promptly.

When --timeout fires, tick interrupts in-flight resumes: each run drains and is saved `suspended`
with `nextWakeAt` = now and `interruptedBy: {reason, at}`, reported as `suspended` with
`message: "Tick timeout reached."`, and resumed by the next tick without repeating completed steps.
A first SIGINT/SIGTERM/SIGHUP to execute, resume or tick saves the same resumable suspension (and
execute/resume still exit 130). Explicit or workflow-scoped cancellation still saves `cancelled`,
which tick never retries. `--claim-margin` (same syntax; default 10% of --timeout; `0ms` disables;
must be smaller than --timeout) stops new claims once less than the margin remains: ready runs are
left untouched and reported as skipped `deadline`, and --watch ends there. Size --timeout for the
longest step one tick should finish; a longer agent call is interrupted and restarted each tick. No
process runs after tick exits. For periodic operation, install a user-authorized cron or launchd
task using absolute paths and a working PATH, for example:

```cron
* * * * * cd /absolute/project && /absolute/node /absolute/quiet-choir/bin/run.js workflow tick --state-dir /absolute/state --json >> /absolute/tick.log 2>&1
```

## Operator hooks

--notify-command CMD or QUIET_CHOIR_NOTIFY_COMMAND runs sh -c with event JSON on stdin on
execute/resume/tick. Events: wait.opened (signal only), run.suspended, run.completed, run.failed.
JSON includes stateDir and run/step identity; wait.opened includes data.question. Hooks are
asynchronous, drained after writer release, limited to 10 seconds/64 KiB output, and best-effort:
failures warn without failing the run. Dry-run skips hooks and does not invent external answers.

notifiedAt is persisted on first signal registration even without a hook. It deduplicates the
first-open attempt, but a crash can lose delivery; lifecycle hooks can repeat across resumes. A
local example is --notify-command 'cat >> /absolute/events.jsonl'. A user may configure a desktop
notifier or HTTP client; no messaging integration is built in. Business notifications remain
explicit idempotent workflow steps. Polls of replies must check the expected author's authority.
