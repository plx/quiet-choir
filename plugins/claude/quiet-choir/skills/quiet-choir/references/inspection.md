# Progress inspection

## Locate

Use the same absolute state directory as execution. From the intended project, with the
[golden-path variables](../SKILL.md#run-a-first-workflow-against-a-project) still set:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow list --state-dir "$QC_RUNS" --json
node "$QC_CHECKOUT/bin/run.js" workflow list --state-dir "$QC_RUNS" --status stale --json
```

List does not import workflow source. A missing directory gives an empty list; unreadable records
produce warnings. Do not accidentally use `npm run cli` from the runtime checkout to inspect a
relative state path belonging to another project.

## Read

```sh
node "$QC_CHECKOUT/bin/run.js" workflow inspect first --state-dir "$QC_RUNS" --json --summary
node "$QC_CHECKOUT/bin/run.js" workflow inspect first --state-dir "$QC_RUNS" --json
```

Use the [jq summary](operating-runs.md#poll-the-saved-state) for open steps, attempts, and errors.
An initial missing checkpoint can mean loading or a pre-record failure: read the redirected result
and log. Ordinary inspect exits 0 for any readable status. Timestamps are not heartbeats.

## Classify and act

| Observation                                          | Action                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `completed`                                          | Read `output`; settled failures may be intentional results. No recovery needed.                                                         |
| `failed`                                             | Read `rootCause`, step error, and attempt diagnostics; fix the cause, then choose compatible resume, explicit code acceptance, or fork. |
| `cancelled`                                          | Determine who cancelled it; inspect children, then resume if continuing is intended.                                                    |
| `suspended` with `interruptedBy`                     | A signal or tick deadline interrupted it; it is due now. Let tick resume it, or resume it explicitly.                                   |
| `running`, live owner                                | Wait/watch; inspect running sleeps' `wakeAt` and the log before calling it stalled.                                                     |
| Derived `stale`, absent/dead/released owner          | Inspect children; plain resume recovers safe ownership automatically. Tick also recovers it, up to the crash-loop cap.                  |
| Live/unverified children, remote or incomplete owner | Follow [ownership recovery](operating-runs.md#stalls-and-orphan-recovery); do not infer permission to kill from PID or age alone.       |

Run-level `.status` saves running/completed/failed/cancelled/suspended. Summary/list/watch can
derive `stale` from ownership without rewriting that saved status. A failed run may have reusable
completed siblings; a run-level output validation error may have no failed step. Start from
`rootCause`. See [code recovery](durability.md#choose-a-recovery-path) before editing and resuming.

A `suspended` run has released ownership for external answers. Read `workflow pending --json`,
review source drift and question context, then
[answer and resume](operating-runs.md#answer-a-suspended-run). Waiting questions are not stalled
agent calls.

## Match a symptom to its next action

These are exact current message strings or templates (angle-bracket fields vary). Harness messages
can be wrapped by a step prefix and include `[exit code …]` and bounded diagnostic tails. For
scripts, use stable CLI `error.code` and structured harness categories instead of parsing prose.

| Symptom                                                                                                                                      | Likely cause                                                                                                                | Next action                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Run <id> already exists; use resume or choose a new run ID.`                                                                                | New execution reused an ID                                                                                                  | Resume the intended run, or choose a fresh ID.                                                                                                                                                  |
| `Run <id> is locked by PID <pid> on <host>. Wait for it or stop it; …`                                                                       | Live or unverifiable local owner                                                                                            | Wait, or end the run with `workflow cancel`; `workflow unlock` refuses while it lives.                                                                                                          |
| `Run <id> is locked by PID <pid> on <host>. If <host> is this machine under an old name or is permanently gone, …`                           | Foreign-host owner                                                                                                          | Check that host; only if it is this machine renamed or gone, run the printed `workflow unlock … --force-remote`.                                                                                |
| `Run <id> is locked with incomplete ownership metadata (damage or an older build); after confirming no process owns <path>, clear it with …` | Damaged lock or an older build's interrupted acquire                                                                        | Confirm no writer is active, then run the printed `workflow unlock`; it refuses live children.                                                                                                  |
| `Run <id> lock recovery is in progress; retry, or …`                                                                                         | Live, unknown or remote recoverer, or damaged marker                                                                        | Retry after it finishes (a dead recoverer's marker is reclaimed automatically); for a gone recoverer or damaged marker run the printed `workflow unlock` (`--force-remote` for a foreign host). |
| `Run <id> has <count> live or unverified harness processes …`                                                                                | Survivor or unverifiable child record                                                                                       | Inspect; `--resume --kill-orphans` handles only confirmed identities.                                                                                                                           |
| `Profile <name> requires <access> access. Retry with --grant <name>, --grant <access>, or --grant all.`                                      | The call needs an operator grant this run lacks                                                                             | Resume with `--resume --grant <name>` (or `--grant <access>`); no code change or `--accept-code-change` is needed.                                                                              |
| `Replay skipped recorded steps (<ids>); workflow control flow changed.` (or `settled maps`)                                                  | With unchanged source, the body computed a value outside a durable effect (time, randomness, environment or file contents)  | Compute it with `ctx.now` or inside `ctx.step`, fork with `--fork-from <run>`, and use `--resume --strict-replay` to stop at the first divergence before live work.                             |
| `Replay divergence before live step <id>: …`                                                                                                 | The same divergence, stopped before live work by `--strict-replay`                                                          | As above: move the value into `ctx.now` or `ctx.step`, then fork with `--fork-from <run>`.                                                                                                      |
| `Step <id> (<kind>) failed: …`                                                                                                               | The named effect failed; `<kind>` is the call-site effect (the harness for an agent call), even when the step has no record | Read `rootCause` (its `effect` names the kind) and the step's attempts; fix the cause and follow `recoveryHint`.                                                                                |
| `Workflow <changes> changed; <unchanged> unchanged.`                                                                                         | Source/schema or name/version/cwd compatibility changed                                                                     | Read `check-resume --json` details; compare saved cwd/name/version. Accept eligible code edits or fork/start anew as directed.                                                                  |
| `Checkpoint format version <n> cannot resume or fork with the current durable-outcome contract …`                                            | Older runtime record                                                                                                        | Inspect it; use its original runtime to resume or start a fresh ID.                                                                                                                             |
| `Claude did not return structured_output for the requested schema.`                                                                          | Native protocol drift or missing structured result                                                                          | Inspect bounded stdout/stderr and the requested schema; verify the installed CLI contract.                                                                                                      |
| `Codex output ended without turn.completed; the call may have been interrupted.`                                                             | Truncated/incomplete native turn                                                                                            | Inspect process outcome and saved notices; confirm no live child before retry.                                                                                                                  |
| `Codex completed without a final agent_message.`                                                                                             | Terminal event lacked final text                                                                                            | Inspect native output/contract; do not equate exit 0 with a usable answer.                                                                                                                      |
| `<binary> exceeded its <n>ms deadline.`                                                                                                      | Per-call timeout                                                                                                            | Inspect effects; raise a sticky timeout limit and resume if safe to repeat.                                                                                                                     |
| `<binary> produced no output for <n>ms (idleTimeoutMs).`                                                                                     | Output idle deadline (`idle-timeout`)                                                                                       | Check whether the CLI hung or a tool was just silent; resume with the suggested `--profile role.idleTimeoutMs=N`, sized above the longest silent stretch.                                       |
| `<binary> exceeded its <n>-byte output limit.`                                                                                               | Combined stdout/stderr cap                                                                                                  | Reduce noisy output or configure an embedded adapter cap; inspect existing file edits before retry.                                                                                             |
| Harness `HTTP 401` / `HTTP 403`                                                                                                              | Reported authentication / permission error                                                                                  | Repair credentials or authorized permissions, then resume; do not change models as an auth workaround.                                                                                          |
| Harness `rate limit exceeded` (Codex) / `HTTP 429`                                                                                           | Provider rate limit (`rate-limit`)                                                                                          | Wait, then resume; `retry.on: ['transient']` retries it in-process.                                                                                                                             |
| Harness `HTTP 500` / `HTTP 529` (also 502/503)                                                                                               | Provider overloaded or failing (`overloaded`)                                                                               | Resume later; `retry.on: ['transient']` retries it in-process.                                                                                                                                  |
| Harness `HTTP 400` / `HTTP 404`, or `There's an issue with the selected model`                                                               | Rejected request (`invalid-request`)                                                                                        | Fix the model, effort or options, then resume; do not retry unchanged.                                                                                                                          |
| Harness `error_max_turns` / `max_turns`                                                                                                      | Claude turn limit                                                                                                           | Raise `--profile role.maxTurns=N` or matching policy; the error includes current role/limit.                                                                                                    |
| Harness `error_max_budget_usd` / `budget_exhausted`                                                                                          | Claude per-call USD limit                                                                                                   | Review reported spend; raise the authorized limit or reduce the task.                                                                                                                           |
| Harness `turn.failed: <reason>`                                                                                                              | Codex reported terminal failure                                                                                             | Fix the recorded API/schema/transport cause; earlier edits may persist.                                                                                                                         |

`validate` and execution now share the same source/schema/engine fingerprint. Use `check-resume` for
a detailed comparison of all gates, including name, version, cwd, and input. Source hashing excludes
the engine's own src/dist, so rebuilding runtime typings is not by itself a workflow source change.
Local JSON boundary errors identify the boundary and path: omit undefined object members, use null
for absent array positions, and return JSON data rather than class instances. See
[authoring](workflow-authoring.md).

## Inspect without executing

After the [recovery example](durability.md), reuse its absolute `qc_state_dir` in the same shell:

```sh
npm run --silent cli -- workflow inspect recovery --state-dir "$qc_state_dir" --json
```

For another project, launch from that project and use
`node /absolute/path/to/quiet-choir/bin/run.js workflow inspect RUN_ID --state-dir /absolute/path/to/runs --json`,
substituting the actual paths and run ID. `npm run cli --` launches from the checkout even when
called in a subdirectory. Its launch directory is the base for relative paths, the run's recorded
`cwd`, and agent calls; resume must use the original directory. There is no CLI `--cwd` flag.

Inspection does not import the workflow or take the writer lock. Each read sees a persisted
checkpoint plus current OS ownership observations, not the live JavaScript stack. Text is a
dashboard; `--json --summary` returns the same compact progress, status counts, ordered
active/problem steps, resolved limits, root cause, reported usage, recent logs, the completed run's
`output` (null otherwise) and an `agents` roll-up (`total`, `byRequest`, and the last 50 calls with
harness, requested model, effort, profile, elapsed time and cost, plus `toolUses` and the step's
`warnings` when recorded, bounded to 3 entries of 200 characters with a `+K more warnings` entry and
always keeping `no-tool-use`, the full list being in `inspect --full`; the model is never assumed
effective), and, only when an attempt reported subscription rate-limit windows, a `rateLimits` map
by harness (see [usage budgets](usage-budgets.md#subscription-rate-limit-windows)). Text prints a
completed command on one line and the last 20 completed agent calls, with `tools N` and any
`no-tool-use` warning, then a `Rate windows` line per harness after the usage lines when windows
were reported; `-v` restores two-line commands with absolute argv and cwd, all recent agent rows and
saved stacks. For embedding, `await readRun({ runId, cwd, stateDir })` returns the validated
checkpoint alone; `inspectRunOwnership({ runId, cwd, stateDir })` returns the separate current
ownership view. Like `runWorkflow`, it resolves explicit options, then `QUIET_CHOIR_STATE_DIR`, an
existing run's legacy location, and the external XDG project default. Relative state paths resolve
against `cwd` (default: `process.cwd()`). `resolveStateDir({ cwd, stateDir, runId })` returns the
absolute directory; include `runId` to discover its legacy location. A missing CLI inspection names
that directory and lists the run IDs present; embedded `readRun` retains the filesystem error's
`code: 'ENOENT'`.

Current checkpoints combine `<stateDir>/<runId>/run.json` and `journal.jsonl`; use the reader, since
the snapshot alone can lag. Ownership lives in `<runId>/lock/`. Migrated runs also retain a legacy
guard at `<runId>.json.lock/`. Locks survive hard kills, so their presence does not prove a live
owner. A same-host resume checks durable child records before recovering a dead/released owner. Live
or unverified children refuse execution (exit 3); explicit `--resume --kill-orphans` stops only
birth-identity-confirmed survivors. A reused PID is not signaled. Text inspection names the owner
PID and state (with `stale` run status for a missing lock or dead/released owner), then child
binary, PID/group, step, attempt and state, and one line per existing lock with its owner and any
recovery marker. JSON adds `ownership: { locked, owner, processes, warning?, locks }`; this field is
not saved in the checkpoint. `locks` lists the existing `primary` lock and legacy `guard`, each as
`{ kind, path, owner, recovery, warning? }`, where `owner` and `recovery` (a `recovery.json`
recoverer) are `{ pid, host, state }` or null. Tick skips a run as `locked` while any lock's owner
or recoverer is alive, unknown or remote; a dead recoverer's marker is reclaimed. Missing identities
and malformed records are reported, never permission to kill. Foreign-host or incomplete ownership
needs inspection. Prefer `inspect` or `readRun` to validate data. `inspect` without `--watch` exits
0 even for `failed`, `cancelled`, or `running` records; check `status`. A JSON inspection result has
these useful fields:

| Field                                     | Interpretation                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `id`, `workflow.name`, `workflow.version` | Run and workflow identities                                                    |
| `status`                                  | Last saved `running`, `completed`, `failed`, `cancelled`, or `suspended` state |
| `error`                                   | Last run failure message, or null                                              |
| `cwd`, `input`                            | Original execution directory and validated input                               |
| `createdAt`, `updatedAt`                  | Creation and last checkpoint timestamps; not heartbeats                        |
| `steps`                                   | Object keyed by durable step ID; absent IDs have not been recorded             |
| `output`                                  | Final workflow result; use only when the run is completed                      |

Checkpoint keys, events, and policy matches use the full scope/map/item/leaf ID. Local
`idempotencyKey` is `runId/fullId`; ID helpers do not hide or truncate checkpoint keys.

Each step records `kind` (`step`, `claude`, `codex`, `sleep`, `ask`), `status`, total `attempts`,
`fingerprint`, `output`, `error`, and `wakeAt` (epoch milliseconds for sleep, otherwise null). For
completed agent steps, `output` is the full `{ output, sessionId, usage, diagnostics }` wrapper: the
model's answer is at `steps[stepId].output.output`.

An ask step stores `question.request`, `askedAt`, `resolution`, and bounded `rejections`; its
statuses are waiting/completed/withdrawn. Its one registration has no adapter attempt-history
entries. Waiting questions are visible in summary/list counts and in `workflow pending`, which by
default hides those of failed, cancelled or completed runs and those with an answer already queued;
`workflow pending --all` lists every one.

Current records include run `policy`, `allowModelOverride`, and `policyWarnings`. Each step has
component `identity` hashes and `attemptHistory`: each attempt records its fingerprint, resolved
`policy`, value `sources`, `requestedModel`, `effort` (explicit Codex effort, else null),
`startedAt`, `finishedAt`, `status`, and `error`. Format 6 adds execution number, monotonic
duration, reported usage, request summary, and stack to each attempt. Agent attempts additionally
retain early `sessionId`, Claude `requestedSessionId`, loose `diagnostics`, and a private
`transcript` receipt. Failed responses are bounded to 256 KiB with `responseTruncated`; local Zod
failures retain `validationIssues`. Later success preserves these earlier entries. Steps retain the
latest phase/timing/request/stack; existing cancellation status and `attemptHistory` are used, with
no duplicate boolean or history array. A `running` attempt has no saved settlement. Redefined
unfinished steps retain old hashes and change times in `redefinitions`; unvisited unfinished steps,
and unvisited child frames that are still running, suspended, failed or cancelled, become
`superseded` after a successful body replay. Existing terminal outcomes still must be visited.
Storage format 7 retains replay contract 6. Flat format 6 migrates automatically; original format 1
migrates by verifying its old step identities and must migrate before fork reuse. Formats 2–5 remain
inspection-only in this runtime. See [legacy migration](durability.md#legacy-records).

`workflow.identity` holds code/schema/file hashes and engine metadata. `forkedFrom` identifies a
source snapshot, reuse mode, invalidation globs, intentional differences, and progress; each copied
step records `reusedFrom`. Its attempts/history describe the source work, not fresh target calls.
Step `seq` records first-use order in the target; root `seq` is the storage journal sequence.
`codeChanges` audits explicit source/schema acceptance, plus one entry per settled map that accepted
a mapper-only change (`map` names it); the text summary prints the last five as
`Code change accepted at ...` lines. `replayWarnings` captures ordering or lost-fork-source
warnings. `recoveryHint` is advice chosen from the typed failure cause, never from message text: a
grant failure suggests `--resume --grant <profile>`; a replay divergence with unchanged source
blames a value computed in the body (compute it with `ctx.now` or inside `ctx.step`) and suggests
`--fork-from` or `--resume --strict-replay`; a settled map that changed after an item committed
suggests `--resume --accept-code-change` when only its mapper changed, and otherwise restoring the
map or `--fork-from`; a configuration or authoring failure suggests fixing the workflow, adding
`--accept-code-change` when the fix edits code, and, when all recorded effects have terminal
outcomes, re-finalizing with no repeated work; an effect failure or a cancellation suggests a plain
`--resume`. A run that recorded no step or map, and any dry-run, gets no hint. The CLI appends the
hint only to this invocation's `workflow.failed` or `workflow.interrupted` message, never to a
refusal. Use `workflow check-resume FILE --run-id ID --json` to compare run gates without a writer
lock; it imports trusted source but does not call its body. Unlike inspection alone, it can identify
changed source files and schemas.

A `settled-failed` step is terminal: `settledError` saves `message`, `kind`, and total `attempts`.
Failed `attemptHistory` entries retain `errorKind`, and failure documents and summaries now surface
it (see below). A run may complete with settled failures. `step.settled` follows a committed
outcome; `replay.divergence` can include `healedStepId` and later `skippedStepIds`.

## Watching and listing

```sh
npm run --silent cli -- workflow inspect recovery --state-dir "$qc_state_dir" --watch --interval 2s
npm run --silent cli -- workflow inspect recovery --state-dir "$qc_state_dir" --watch --json --summary
npm run --silent cli -- workflow inspect recovery --state-dir "$qc_state_dir" --watch --json --summary \
  --final --timeout 9m --wait-created 30s
npm run --silent cli -- workflow list --state-dir "$qc_state_dir" --status stale --json
```

Watch polls every 2s by default (`ms`, `s`, or `m` suffix, 1ms–2147483647ms). Text redraws on
changes in a terminal; JSON is JSONL, one document per checkpoint/ownership change, without
elapsed-time-only lines. It exits with a final snapshot: completed 0, failed 1, suspended 75
(including an interrupted run), cancelled 130, stale 3. Unknown/remote ownership is not assumed
dead. Missing/unreadable checkpoints use ordinary workflow error JSON. Interrupting the watcher adds
an error document and exits 130 without stopping the observed workflow. Watch may miss intermediate
writes and is not a lossless event stream. Normal inspect still exits 0.

Bound a watch for a host with a time limit. `--timeout` (`ms`, `s`, `m` or `h`) counts from the
first successful read; a run still running then exits 79 (`watch.timeout`) with the last observed
`status` and `details.timeoutMs`, and keeps running. `--wait-created` counts from the start of the
watch and retries a missing record until the first read, then exits 66 (`watch.record_not_created`,
`status: null`). Each bound reads once more at its deadline, so the watch ends within one read after
it. `--final` prints only the final snapshot, or only the error document; with `--summary`, error
documents carry the compact `summary` instead of `run`.

List sorts newest `updatedAt` first and supports running/failed/completed/cancelled/stale filters.
Unreadable files are skipped with stderr warnings. JSON is
`{kind:'workflow.list.result', ok:true, stateDir, runs, warnings}`. Each row is compact: `id`,
`workflow`, `status`, `recordedStatus`, `counts`, `updatedAt`, `ownership`, `nextWakeAt`, `cwd`,
`stateDir`, `warnings` and `usage` totals; `--full` returns whole summary objects. A missing
directory produces an empty list. Neither command imports source, takes the writer lock, or performs
recovery.

## Phases and logs

`ctx.phase(title, { total })` sets the phase until the next phase in that context.
`await ctx.phase(title, async () => { /* work */ }, { total })` isolates concurrent scoped phases
using AsyncLocalStorage; map workers and bound contexts inherit it. Steps capture the phase at
invocation, before asynchronous request preparation. `total` is descriptive. The dashboard counts
completed/running steps with the same label; distinct phase labels give distinct counters.
`ctx.log(message, data?)` accepts lossless JSON. Invalid phase/log calls are authoring errors, never
settled-map item outcomes; a scoped phase body's own errors settle normally. These calls have no
IDs, fingerprints, or skipped-step checks. Their writes are owned and drained by the runtime
(synchronous bursts share a snapshot), and they echo to stderr at info level.

The kth identical phase/log observation from an earlier execution echoes with `(replay)` and
`replayed:true` without appending a duplicate. Signatures include type, message, data, and phase
metadata, independent of concurrent ordering. Only the latest 500 lifecycle/phase/log payloads are
retained; compact occurrence counts survive eviction. Counts and attempt histories can still grow;
whole-file checkpoint writes make high-volume logging expensive. This is not a transcript.

Run `executions` retain body execution numbers, PID, start/end, outcome, error, and stack; completed
resume fast-path reads add no execution. A crashed execution remains `running` if it never saved a
final outcome. `request` records provider/model/profile, effective limits, tools, cwd, structured
output, prompt SHA-256 and a 200-code-unit preview. Null model means inherited native configuration.
Checkpoint previews, logs, and stacks can contain sensitive data. Attempt elapsed time includes
admission/start-write waiting; per-call timeout begins only when admitted.

## Interpreting apparent stalls

`running` is a persisted state, not proof of a live process. A crash or checkpoint-write failure can
leave `status: "running", error: null`, even after an external action finished. A long agent call or
sleep also leaves `updatedAt` unchanged. Inspect process/lock ownership and the sleep deadline
before deciding a run is abandoned. Follow [recovery](durability.md) for locks and orphaned
children; clear an abandoned lock only with `workflow unlock`, and timestamps alone do not justify
it.

A failed run can have completed sibling effects. Those effects replay on a compatible resume; an
uncheckpointed external action may repeat. Failed agent attempts retain available
session/usage/response/validation evidence and private transcript receipts. A capped transcript can
be incomplete, and abandoned output is not guaranteed. Run-level failures (for example final schema
validation) need not imply any step failed. Start from `rootCause: { stepId, error, errorKind }`,
also shown by human inspection. `errorKind` is the root effect's classified kind (its last
attempt's), null for a body or run-level failure and for an interruption, and absent in records
written before the field: `inspect` and the compact result then fall back to the root step's last
attempt. Failure documents add `errorKind` and `retryable` to every `failedSteps[]` entry, and
`error.details` is `{ errorKind, retryable }` for `workflow.failed` (null kind and
`retryable: false` for a body failure; `workflow.interrupted` keeps `details: null`). `retryable` is
true exactly when the kind is transient: `rate-limit`, `overloaded`, `timeout` or `idle-timeout`,
the set `retry.on: ['transient']` stands for. It is a classification, not a promise that a retry
will succeed. `inspect --summary` step rows carry `errorKind` (the last attempt's kind, null for a
step without a failed attempt), and the text view prints `[<kind>]` on the step line and
`Root cause (<step>, <kind>)`. Attribution uses error identity/cause chains, not message matching.
`WorkflowRunError` names the root step/kind and exposes `runId`, `stepId`, saved `run`, and original
`cause`; `-v` prints the saved stack. A map's initiating step stays `failed`; an interrupted sibling
is `cancelled`, with a distinct cancellation message and `cancelledBy` set to the initiating step ID
(null for a mapper-body failure or run interrupt). First Ctrl-C/SIGTERM/SIGHUP, or tick's --timeout,
records run status `suspended` with `interruptedBy: { reason, at }` (such as
`Workflow interrupted by SIGINT.`) and no root cause; an explicit cancellation records `cancelled`
with root cause `{ stepId: null, error }`. Completed or handled failures leave `rootCause` null when
the run completes. Resolved, validated actions still save success after abort.

`maps[id]` contains settled-map identity, status, and ordered item journals. Each committed item
stores `{ ok, value/error }` and its owned step/nested-map IDs. Those outcomes replay as a unit; a
child's `failed` status inside a committed item is diagnostic history, not a pending retry. Partial
journals retry only uncommitted mappers. Forks create new journals.

## Live events

Run with `--log-level debug` to log `step.started`, `step.completed`, `step.replayed`, and
`step.waiting`, `step.failed`, `step.cancelled`, `step.settled`, `step.redefined`,
`step.superseded`, and `step.reused` events to stderr. `runWorkflow` also accepts an
`onEvent(event)` callback returning `void | Promise<void>`. `replay.divergence` adds a message and
`skippedStepIds`, and the CLI logs it as a warning before live work; `--strict-replay` stops before
the next live effect:

<!-- skills-check: fragment; reason: onEvent property inside runWorkflow options. -->

```ts
onEvent: (event) => {
  process.stderr.write(`${event.at} ${event.runId} ${event.type} ${event.stepId ?? ''} attempt=${String(event.attempt)}\n`);
},
```

An event includes `at`, `execution`, `type`, `runId`, `stepId`, and `attempt`. Debug lines include
timestamp and run ID. Lifecycle `run.started/completed/failed/cancelled/suspended` and phase/log
notifications use attempt 0; their step ID is null except a run failure can name the root effect.
Step notifications reflect persisted step state; `step.replayed` refers to the existing completion
and does not increment attempts. Observer synchronous exceptions and asynchronous rejections are
ignored so they cannot invalidate execution. Observer promises are not awaited and do not keep the
run lock held; synchronous observer work still runs inline. Notifications are not durably queued or
guaranteed to be delivered. `agent.started`, `agent.progress`, and `agent.finished` add bounded
native activity and final attempt diagnostics. Use `workflow execute --progress` for stderr activity
while preserving JSON stdout. These are lossy summaries, not token delivery or a durable queue; use
[attempt records and transcripts](agent-streaming.md) for retained evidence.

Usage is computed by `summarizeUsage(run)`, with one entry per local agent attempt across
executions. Replays count once; copied fork attempts are excluded. Full JSON inspection adds
`usageSummary`; compact JSON retains `usage`. Outcomes include interrupted agent attempts after
resume. Known values are summed, all-unknown stays null and no attempts totals zero.
`unknownUsageAttempts`, `unknownTokenAttempts`, `unknownCostAttempts` and `unknownTokens` identify
missing measurements; the headline says tokens are complete when only cost is unreported. Legacy
fallback warns about undercounting and historical token semantics. Harness/model groups show where
known spend occurred; requested aliases are not assumed effective.

A run stopped by `RunBudgetExceededError` remains failed even if its body caught the refusal.
`budgetStop` identifies the refused effect and limit; that refusal created no new attempt. Inspect
known/unknown totals, then resume with a chosen higher `--max-run-cost-usd` or
`--max-run-agent-attempts`. Omission retains saved caps; `off` clears one. Completed work replays.
See [usage and budgets](usage-budgets.md) for provider semantics, drain behavior and cost overshoot.

Both synchronous observer throws and observer promise rejections are handled, and `readRun` shares
execution's path resolution. Neither guarantee covers unowned async work that a workflow creates.

## Checkpoint and cleanup diagnostics

`CheckpointError` distinguishes storage operations (`save`, `release`, or `process`) from workflow
failures. When both fail, the domain error leads the message; an `AggregateError` retains the
checkpoint errors in `errors` and the primary error in `cause`. Brief transient write errors are
retried, but persistent errors stop new effects. A successful action is never retried in-process
because its completion write failed. A later save can recover it; inspect the actual saved step
before resume, since an uncheckpointed action can repeat.

A persisted completion still succeeds if the lock directory is already gone, if its removal fails
with `EACCES` or `ENOENT` after ownership was verified, or when unreaped child records retain a
released-owner lock. The CLI prints a warning to stderr and includes `warnings` in the returned run
(`--json`); embedding callers receive `WorkflowRun.warnings`. These cleanup warnings belong to that
invocation and are not saved after ownership is released. Repair permissions or inspect the lock
before another run. Changed ownership, or missing or unreadable ownership metadata in a remaining
lock, remains an error. A removed state directory is named explicitly and is not silently recreated.
See [durability](durability.md) for recovery precautions.

`agent.queued` and `agent.admitted` are live admission notifications, not checkpoint transitions.
They include `provider`, `inFlight` reserved-slot counts, `queued` waiter count, and `waitedMs`
(zero when requesting admission, actual monotonic wait when admitted). An immediate admission can
report queued=0. With an explicitly shared limiter, counts cover all sharing runs. A queued step is
already persisted as running; checkpoints do not distinguish waiting from native execution. Use
`limiter.snapshot()` for embedded live monitoring. Observer failures never own a slot.

## Child frames

`inspect --json` includes `children`; text inspection renders the root and child tree with status,
phase labels, step counts and known/unknown usage. Child totals include descendants and must not be
added across tree levels. A changed child version/schema remains incompatible after source
acceptance. See [composition and recovery](child-workflows.md).
