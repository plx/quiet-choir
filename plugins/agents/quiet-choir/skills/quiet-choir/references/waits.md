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
| Readiness that one command reports     | `ctx.poll(id, { input, schema, every, command, output, done, timeoutMs })` |
| Competing readiness sources            | `ctx.wait(id, { signal?, poll?, timeoutMs?, deadline? })`                  |

Each sleep/poll/wait creates one wait record. `now` creates one local step. Wait identity includes
original timing, signal presentation/schema/subject, poll input/schema/spacing, and observer source.
A command poll fingerprints its prepared command, `output` schema and `done` source instead.
Captured values still belong in poll input. Waiting identities cannot change; use revision-specific
IDs and immutable subjects. Never derive changing sleep durations from a body `Date.now()`.
`observeTimeoutMs` and `onError` are policy, not identity, and may change on resume.

`observe({ signal, idempotencyKey, attempt, cwd, exec, previous })` returns `{ done: true, value }`
or `{ done: false, note? }`. Zod validates/project terminal values. `every` is a positive integer
interval or `{ initialMs, maxMs, factor? }`, with factor default two. `ctx.poll` requires timeoutMs
or deadline; `ctx.wait` may be unbounded. Progress overwrites checks/nextCheckAt/last note (16 KiB
limit); naps do not save. By default a thrown observation fails the invocation and can be retried on
explicit resume; tick never retries failed runs. Body-execution diagnostics can still grow across
resumes; there is no history compaction. Honor the observation `signal`: it aborts on run
cancellation, when the deadline passes during the observation (the wait resolves by deadline with
the last note), and after `observeTimeoutMs` (positive integer, default 60 s, never past the
deadline), which fails the wait like a throw. An observer that ignores its aborted signal is
abandoned after a 2 s grace, also when the run closes, with a `waitWarnings` run warning.

Run commands such as `gh pr view` through `context.exec(argv, options)` or
`context.exec.json(argv, { schema })`, never a raw `child_process` spawn. They use the run's process
runner, are owned by the wait for orphan recovery, stop with the observation signal, and are
synthesized or fixture-answered under rehearsal like `ctx.exec`; `{ live: true }` keeps a read-only
one real under `--dry-run`. They are not durable: every check runs them again. See
[commands inside a callback or observer](commands-files.md#commands-inside-a-callback-or-observer).

### Command polls

When the whole check is one command, declare it instead of an observer:
`{ command, output, done, commandOptions?, live? }` beside `input`, `schema`, `every` and the time
bound. Each check runs `command` (argv or `{ shell }`) like an observer's
`context.exec.json(command, { schema: output })`: owned by the wait, stopped with the observation
signal, rehearsed and fixture-answered, with `observeTimeoutMs` (default 60 s) as its timeout. Then
`done(output, previous)` returns `{ done: true, value }` or `{ done: false, note? }`. `done` must be
pure: no context, no context operations, debounce state in the note. `commandOptions` takes `cwd`,
`env`, `inheritEnv`, `input`, `okExitCodes` and `maxOutputBytes` (no `timeoutMs` or `onError`). A
failing exit, output over the cap or stdout not matching `output` throws an `ExecError` (kind
`process`, `output-limit` or `schema`, 1024-character tails) that `onError` may tolerate; `classify`
can read `error.diagnostics.code`. Identity adds `poll.command` (the prepared command with canonical
cwd, env and stdin digests and exit codes, plus the `output` JSON Schema), and `poll.observe`
digests `done`; `live`, `observeTimeoutMs`, `onError` and `maxOutputBytes` are policy. The command
is validated when the wait opens. Under `--dry-run` each check is synthesized from `output` and
listed in `commands` under the wait ID; `live: true` runs it for real. `workflow pending` shows the
command. In `ctx.wait`, `done`'s output is `unknown`; `ctx.poll` infers it.

```ts
import { defineWorkflow, z } from 'quiet-choir';

const checks = z.array(z.object({ name: z.string(), bucket: z.string() }));
const seen = z.object({ green: z.boolean() }).nullable();

export default defineWorkflow({
  name: 'await-ci',
  version: '1',
  input: z.object({ pr: z.number().int() }),
  output: z.unknown(),
  run: (ctx, input) =>
    ctx.poll('ci', {
      input,
      schema: z.enum(['pass', 'fail']),
      every: { initialMs: 30_000, maxMs: 120_000 },
      timeoutMs: 3_600_000,
      command: ['gh', 'pr', 'checks', String(input.pr), '--json', 'name,bucket'],
      output: checks,
      // gh exits 8 while checks are pending; that is data, not a failure.
      commandOptions: { okExitCodes: [0, 8] },
      done: (output, previous) => {
        if (output.some((check) => ['fail', 'cancel'].includes(check.bucket)))
          return { done: true, value: 'fail' };
        const green = output.every((check) => ['pass', 'skipping'].includes(check.bucket));
        // Debounce: report pass only on the second green check in a row.
        if (green && seen.parse(previous.note)?.green) return { done: true, value: 'pass' };
        return { done: false, note: { green } };
      },
    }),
});
```

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
note, lastError (latest tolerated error or null), command (a command poll's command or null), and an
optional signal/answer command. `nextWakeAt` is the earliest deadline/check, null for pure signals.
Use `workflow answer` for an external signal, then tick when due. Human signals still need human
routing; an agent cannot supply human approval on its own authority.

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
