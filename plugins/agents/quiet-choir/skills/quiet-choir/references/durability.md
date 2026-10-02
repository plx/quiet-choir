# Durability and resumption

## Durable questions

`ctx.ask` saves `kind: ask`, status `waiting`, and
`question: { request, askedAt, resolution, rejections }`. `ctx.approve` uses
`{ approved: boolean, comment?: string }`. Prompt, details, choices, audience, subject, schema, and
title all enter the fingerprint. Unlike ordinary unfinished steps, a waiting question cannot be
redefined. Use revision-specific IDs/subjects. A compatible resume revalidates saved answers; new
forks ask fresh questions instead of copying approvals.

When no non-question effect, registration, or write remains active across two macrotask turns, the
runner scans the inbox and checks stability again, saves `suspended`, and releases ownership.
Started siblings are never aborted for suspension. The unanswered promise stays pending: catches
cannot select a fallback, and body `finally`/`using` cleanup does not execute. Only await context
operations; raw timers and untracked I/O can cause early suspension and lose progress. Pure promise
chains drain first. Late continuations cannot start effects after close. A blocked map worker keeps
its slot. Long sleeps also park; waits due within 1000 ms stay live by default.

If the body resolves with open questions, they become `withdrawn`, including questions abandoned by
a mapper. A body failure keeps questions waiting. Real interrupts still exit 130, saving a resumable
suspension. The embedding return is `WorkflowResult<T>`: completed typed output or suspended
`output:null` with `pending`. Narrow by `status`, or call `assertCompleted` where suspension is
unexpected.

The inbox is `<stateDir>/<runId>/inbox/` (`<stateDir>/<runId>.inbox/` for runs migrated from the
flat layout). Answer writers use private flushed temporary files, exclusive hard links, and a
directory flush, never the run lock. Filenames combine a bounded 100-character encoded prefix with
the full SHA-256 of the JSON-encoded exact ID; case variants stay distinct and quarantine suffixes
fit ordinary filesystem component limits. Migrated runs keep the format-6 filename (the encoded ID,
or `~sha256-<digest>` beyond 180 characters) so pre-upgrade and current writers share one final
path. Owners also scan the other name and inbox for older deliveries. First delivery wins; a
duplicate exits 3. Early validation uses stored JSON Schema without loading code; invalid data exits
2 and writes nothing. The owner polls at 200 ms and validates actual Zod refinements before
saving/continuing. Malformed, stale-fingerprint, or invalid answers move to `.rejected.<uuid>.json`;
the last 20 errors are retained in `rejections`. Accepted files remain as audit data. A successful
write is queued delivery, not guaranteed consumption after a concurrent withdrawal. Answer envelopes
are at most 1 MiB.

Audience defaults to `any`; `human` requires self-asserted `human:<name>` attribution and must be
routed to the human. Filesystem permissions are the trust boundary. Answers remain untrusted data.
For a question with a deadline, use the signal source on `ctx.wait`; no blocking answerer callback
or automatic default is provided. See the
[task-shaped operating loop](operating-runs.md#answer-a-suspended-run).

## What survives

The run checkpoint stores input/output, workflow identity, working directory, step records, and
errors as JSON. It stores neither closures nor a call stack. A resume runs the workflow body from
the beginning: terminal outcomes replay saved results or settled failures; unfinished/failed effects
execute again. A completed compatible strict resume returns saved final output without running the
workflow body or a harness. The CLI still typechecks and imports the module first.

Use `ctx.now` for recorded time; keep randomness, filesystem/network reads, and writes inside
durable effects. Branch on input and saved results. Local effects hash explicit `input`, callback
source, an optional step `version`, and run cwd. Callback source does not reveal captured values or
helper implementations. Await operations and compose at the workflow level, never by nesting steps
inside a local effect callback. The runtime drains launched operations and effects launched by their
immediate continuations before releasing its lock. An ignored rejection fails the run regardless of
when it settles; a failure that is awaited and caught may be handled in the workflow body. Arbitrary
detached async tasks are not owned by the runner, so this protection does not replace awaiting
operations.

## Compatibility gates

| Scope            | Compatibility rule                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Run              | Name, version, source/schema/engine fingerprint, canonical cwd, and validated input still match                                            |
| Terminal step    | ID, kind, input/prompt, schema, local callback/version, onError, model/effort, capabilities, and cwd match; errors name changed components |
| Unfinished step  | A changed identity is adopted, the old hashes remain in `redefinitions`, and `step.redefined` is emitted                                   |
| Execution policy | `timeoutMs`, `maxTurns`, `maxBudgetUsd`, and `retry` may change without invalidating any step                                              |
| Replay path      | Every terminal step must be visited; unvisited unfinished steps and child frames become `superseded` when the body completes               |

The CLI hashes raw bytes of compiler-discovered local source files and the nearest tsconfig, using
real paths named relative to the tsconfig directory (or nearest package root, then entrypoint
directory when neither exists). Symlink aliases share a fingerprint. Quiet-choir's own `src/` and
`dist/` implementation files are excluded, except an explicitly selected entrypoint; engine package
version and checkpoint format are recorded in `workflow.identity.engine`. A comment or formatting
edit still changes the strict **run** source hash. `workflow.identity.files` and schema hashes make
errors identify changed components and files. `validate --json` reports the same full fingerprint
that a new run stores.

Schema identity hashes the JSON Schema that the installed zod produces (`z.toJSONSchema`, draft-7),
so a zod upgrade can change that encoding and strand completed steps. `test/schema-identity.test.ts`
pins the literal encodings and the agent-result wrapper, so a Dependabot bump of zod, or of tsx when
it alters those schema encodings, fails CI. Treat that failure as a gate, not a snapshot to refresh:
the change needs an explicit decision under ADR 0005 and ADR 0006. A tsx upgrade can also change
local callback text (see the loader paragraph above); that drift is not gated yet for user callbacks
(built-in helpers are immune; see the local callback identity paragraph below). The gate covers only
the zod instance quiet-choir itself resolves, not a different zod a workflow imports.
`record.engine` records the `quietChoir`, `node`, `zod` and `tsx` versions that wrote a run for
diagnosis only; it stays outside identity and never refuses a resume.

Dynamic imports assembled at runtime, external files, installed dependencies, environment, and
native harness configuration are not fully captured. Embedded callers supply `fingerprint`, or
`source: { hash, files }` for detailed diagnostics, never both. Use declared inputs and explicit
step/workflow versions for semantic changes these hashes cannot see. Do not edit checkpoints.

Every terminal step must still be visited on resume. Before the first live effect with unvisited
earlier terminal steps or committed settled maps (by shared `seq`), the runner emits
`replay.divergence` and records `replayWarnings`. `--strict-replay` aborts before that effect and
cancels/drains other work; default mode warns and the end-of-body skipped-step/map checks remain.
Launch order can vary under `ctx.map`, so this early check is a heuristic, not proof of incompatible
logic. A warning may precede paid effects in default mode. Results are revalidated on replay;
dependencies/results must be lossless JSON.

Terminal steps are `completed` successes or `settled-failed` outcomes explicitly requested with
`onError: 'return'`. Both are immutable on resume and eligible for fork reuse. A failed/running
record is retryable; a settled failure is a saved branch decision. Invalidate it in a new prefix
fork to request another attempt. See [failure handling](workflow-authoring.md#failure-handling).

When a previously failed step succeeds, the runner looks for recorded steps that may depend on its
earlier failure: those launched at or after that failure settled. Each step record carries
`launchStamp` (a run-level settlement counter's value when the body requested the effect),
`settleStamp` (the counter after its latest terminal settlement) and `failureStamp` (the stamp of
its first terminal failure since it last completed). A step is flagged when its `launchStamp` is at
least the healed step's `failureStamp`, so a `Promise.all` sibling launched in the same tick as the
failing step is not flagged, whichever settled first. If any are flagged, `replay.divergence` warns
immediately, names the healed step and those IDs, and saves the warning. `--strict-replay` then
stops before the next live effect, while permitting terminal replay;
`workflow resume RUN --strict-replay` and `execute --resume --strict-replay` are equivalent.
Concurrent work already in flight can still finish. The end-of-run skipped-path error also names
healed steps.

The rule is a watermark, not proof of dependence: a step launched after the failure by unrelated
control flow (for example, a step started when another sibling completed after the failure had
settled) is still flagged, and the earliest failure is kept across repeated failures. Records
without stamps (checkpoints written before them, or a failure saved between retries) fall back per
pair to launch order: a step with a higher `seq` is flagged. Explicit settled outcomes prevent the
branch from changing in the first place.

## Choose a recovery path

| Path                            | What stays fixed and what can change                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--resume`                      | Same run, source/schema identity, name/version, engine, cwd, and validated input; unfinished work retries                                                                               |
| `--resume --accept-code-change` | Explicitly waive only source/run-schema changes; keep name/version, engine, cwd, input, terminal-step identity, and replay checks; refuse without changes when a completed step changed |
| `--fork-from OLD`               | New run, same workflow name; source/version/input may change, terminal outcomes are copied only when their identity matches                                                             |

Forks default to `--reuse prefix`, which is causal. A matching terminal source step is copied only
when every source step that had settled before it launched was copied too, and no step that ran live
in the fork settled before the fork requested it. So a missing, changed, unfinished, skipped, or
invalidated effect makes the steps launched after it settled run live, which avoids reusing later
workspace-dependent work after an earlier effect reruns, while its same-tick `Promise.all` siblings
stay reusable. Items of a named map are independent of their sibling items: an edit to one stage
re-runs that stage in every item and reuses the rest. Shared mutable state or files between items is
not tracked; invalidate such items explicitly. `ctx.scope`/`within` siblings and positional map
items are ordered by stamps alone. Sources saved before launch stamps fall back to launch (`seq`)
order. With unchanged code, a concurrent multi-step chain outside a named map can still run a few
steps live when the fork requests them in a different order than the source settled them.
`--reuse matching` explicitly reuses every matching terminal ID; it can reuse a result whose
undeclared filesystem inputs changed when an earlier effect reran. Choose it only when dependencies
are fully represented by input/prompt/schema/versions. Neither mode reconstructs workspace edits or
provides isolation by itself. Explicit [worktree effects](worktrees.md) preserve immutable changes;
forked shared handles are recreated for the new owner. Review other workspace effects before
repeating writes.

From the original launch directory, with absolute `QC_CHECKOUT` and `qc_state_dir`:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow check-resume review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --json
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-2 --state-dir "$qc_state_dir" --fork-from review-1 \
  --invalidate 'report/**'
# Alternatively, explicitly accept a tail fix on the original run, previewing it first:
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --dry-run --resume --accept-code-change --json
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --resume --accept-code-change
```

`check-resume` acquires no writer lock, never calls the workflow body or harness, and does not write
the checkpoint. It still typechecks/imports trusted module top-level code. Its JSON `check` (or
`error.details` for incompatibility) reports `compatible`, changed/unchanged components, file
differences, whether code acceptance is possible, and whether a failed run has only terminal
outcomes. Exit 0 means the run-level gates pass; exit 3 means incompatibility or a read refusal;
exit 4 means a loading failure. Add `--accept-code-change` to check that mode. It does not predict
dynamically constructed steps, step compatibility, or replay order, and a concurrent writer can
change state after the check. For a completed run its message lists the fork first; preview step
checks with `execute --dry-run --resume --accept-code-change`.

A fork never modifies its source checkpoint. `--fork-state-dir` selects alternate source storage;
omitting `--input` inherits source input, while explicit input is validated for the new run. Forks
do not inherit source policy overrides; the target's rules are independent. `--invalidate` accepts
repeatable step-ID globs with the same `*`/`**` rules as policy. Invalidating a prefix effect runs
it live and closes prefix reuse for the steps launched after it settled, outside sibling named-map
items. `forkedFrom` records source identity/differences, mode, and globs; copied steps carry
`reusedFrom` and emit `step.reused`. Failed/running/superseded source records are never copied.
Resume the target with `--resume` alone after interruption. Reuse progress survives, because it is
the copied steps themselves; if the source snapshot changed or disappeared, existing copied results
remain and remaining work runs live with a warning instead of borrowing new source results. In
`forkedFrom`, `reuseClosed` is true only in that case (or for a target an older build closed on a
prefix miss), and `cursor` counts the steps prefix reuse copied.

Each use of `--accept-code-change` that actually changes code, schemas, or files records
`codeChanges` with old/new fingerprints, changed files, components, and time, even if execution
later fails; an accepted resume with nothing changed leaves `codeChanges` untouched. A settled map
that accepts a mapper-only change adds its own entry (`map` names the journal, `from`/`to` are map
fingerprints, `files` is empty, `components` is `['mapper']`) once, independently of the run-level
entry, so a map entry can appear when nothing changed at run level. It runs the body even for a
previously completed run, first clearing any stale output so a failed re-finalization never reports
a prior result. A fixed unfinished callback can execute again. A changed completed step (callback,
prompt, input, schema, options) can never be reused, so the CLI first replays the accepted body
against a disposable copy, with fixtures off and every unfinished local step, file effect, poll
observer and command stubbed. If the copy meets such a step, the command refuses with
`run.incompatible` (exit 3) and changes nothing: status, fingerprint, output, `codeChanges` and
waiting questions stay as they were. `error.details.divergent` names the step and its changed
components, and `error.details.next` holds the replacement command,
`quiet-choir workflow execute FILE --fork-from RUN --reuse matching --invalidate STEP --run-id <NEW_RUN_ID> --state-dir DIR`.
`--dry-run --resume --accept-code-change` returns the same refusal. Any other preflight outcome lets
the real resume proceed; the check is a lock-free snapshot, and the workflow body (not its
unfinished callbacks) runs once more. If only the body tail/output validation failed, a tail-only
fix can finish with zero repeated effects. `recoveryHint` and CLI errors identify this case, subject
to step checks. The hint follows the typed failure cause: a grant, replay-divergence, settled-map
change or effect failure gets its own advice instead, and a run with nothing recorded or a dry-run
gets none. The accepted source becomes the basis for later strict resumes.

Local callback identity uses the loaded function's `toString()` plus optional `version`. Under the
CLI's tsx loader, comment/formatting-only callback edits preserve that source string; logic changes
do not. Other loaders and transpiler upgrades can cause extra misses. Captured values, external
helpers, environment, and bound/native function implementations are **not** visible to this hash.
Put values in `input`, bump the step `version`, or invalidate the step in a fork when they change.
The run's source guard remains useful; callback hashing alone does not make arbitrary edits safe.

Built-in helper steps such as `ctx.now` and `decision.choose` are identified by an explicit version
(`now/1`, `decision/1`) instead of callback text, so refactoring quiet-choir or changing the loader
does not strand them; their versions change only for a deliberate behavior change.

Embedded equivalents are `forkFrom: { runId, stateDir?, reuse?, invalidate? }`,
`resume: true, acceptCodeChange: true`, and `strictReplay: true`. Exported
`checkResume(definition, { runId, stateDir, cwd, fingerprint?, source?, acceptCodeChange? })` checks
run gates without executing the supplied definition. `forkFrom` and `resume` are mutually exclusive.

## Settled map replay

`ctx.map(id, items, { concurrency, onError: 'settle', key?, version? }, mapper)` journals each
entire mapper outcome under an explicit run-unique ID. Completed items replay without invoking the
mapper, claiming their owned step and nested-map IDs as visited. A child step can remain `failed` or
`cancelled` if its containing item saved a handled outcome; inspection retains that history, while
resume returns the containing outcome. Running items retry. Cancellation, infrastructure failures,
and authoring errors never become failed item values. Ignored child-operation failures prevent the
item from committing.

Named-map identity includes item inputs, resolved keys, original mapper source, optional version,
and cwd; it excludes concurrency. Changing identity after any item committed, duplicating a journal
ID, or skipping a recorded terminal map fails replay; a skipped map also triggers the pre-live
divergence check. The journal also saves one digest per component (`items`, `keys`, `mapper`,
`version`, `cwd`), so the refusal names what changed. Explicit code acceptance
(`--accept-code-change`, `acceptCodeChange: true`) accepts a change to the `mapper` component only:
completed items keep their journaled outcomes and owned step claims, unfinished items run with the
new mapper, and `codeChanges` records the map. A change to items, keys, version or cwd is still
refused, with fork advice. A journal saved before per-component digests cannot name what changed, so
any change to it after a commit is refused. Only the mapper function's own source is hashed: a thin
mapper such as `(item) => handle(ctx, item)` keeps edits to `handle` out of map identity, with no
acceptance needed. Either way completed items keep the outcomes the old code produced, and leaf step
identity checks still apply to items that run again. To make a helper edit change map identity, bump
`version`; after a commit that means a fork. Inputs/results must be lossless JSON, and captured
dependencies belong in items or the explicit version. Items are snapshotted when `ctx.map` is
called; settled mappers receive JSON copies of the fingerprinted snapshot, so later caller edits
cannot change the processed items. Full IDs stay run-unique; named maps prefix each item as
`mapId/key/`. The deprecated positional form still uses an explicit `options.id` journal without
adding an item prefix. Forks start fresh map journals and apply their normal per-step
reuse/invalidation rules, so mapper-body outcomes are re-evaluated in the new run.

## At-least-once effects

Effects can succeed without being saved after a crash or hard kill. A resolved action whose output
validates is persisted as `completed` even after a signal abort; resume replays it. An action that
rejects in an aborted scope is `cancelled` and can repeat on resume. Agent calls stopped by
cancellation or `timeoutMs` may already have edited files. Persistent storage failure can still
prevent any outcome from committing, as described below. Use the local step callback's or
`HarnessRequest.call`'s stable `idempotencyKey` with systems that support deduplication. Native
attempts receive it as the `QUIET_CHOIR_IDEMPOTENCY_KEY` environment variable, which does not make
the CLI deduplicate work. Workspace edits and harness conversation state are not transactional. Do
not assume that retrying an error is harmless or that a new run deduplicates an old run's work.

Local and agent steps retry only when explicitly given a `retry` policy; the default is one attempt.
An explicit resume retries unfinished work. `ctx.sleep` saves a wall-clock deadline and waits only
its remaining duration after resume. Long waits suspend; `workflow tick` resumes them when due.
Cron/launchd must invoke tick to wake a stopped run; see [waits and ticking](waits.md).

## Recovery procedure

1. Inspect the run in its original state directory; identify failed/running effects and any external
   actions that may already have happened. Stop orphaned harness children after a hard kill.
2. Repair transient dependencies (for example credentials or a service outage). Retain the original
   source, run schemas, input, working directory, version, and terminal-step identity. Execution
   limits can change through policy overrides without changing the source.
3. Choose strict resume, explicit code acceptance, or a fork using the table above. A change to a
   completed effect's identity requires a new run/fork. Use `check-resume` before choosing a path.

From the checkout root, the local failure/recovery demonstration uses a fresh absolute state path:

```sh
qc_state_dir="$(mktemp -d)"
npm run cli -- workflow execute examples/local.workflow.ts \
  --run-id recovery --state-dir "$qc_state_dir" --input '{"failOnce":true}'
# Expected exit 1: the word steps succeeded, the summary failed.
npm run --silent cli -- workflow inspect recovery --state-dir "$qc_state_dir" --json
npm run cli -- workflow execute examples/local.workflow.ts \
  --run-id recovery --state-dir "$qc_state_dir" --resume
```

Omit `--input` on resume to reuse the saved value. Repeat `--state-dir PATH` if the original run
used alternate storage, and launch from the same directory. The CLI has no `--cwd` flag; npm
launches from the checkout, as described in [setup](setup-and-cli.md). Completed word steps replay;
the summary executes on its next attempt.

## Recovering a timeout or turn limit

From the same launch directory and with the original workflow source unchanged, raise only the
failed review's deadline:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --resume \
  --policy '{"match":"review","timeoutMs":600000}'
```

Here `QC_CHECKOUT` is the absolute checkout path and `qc_state_dir` is the original absolute state
path. A completed `plan` replays, `review` starts a new attempt, and later effects proceed. For a
Claude turn limit, add `"maxTurns":40`; change `maxBudgetUsd` deliberately because it authorizes
more spend. A larger limit does not undo earlier edits or resume the native agent conversation.

Embedded callers use `policy: [{ match: 'review', timeoutMs: 600_000 }]` in `runWorkflow`, or change
call-site limit/retry values while retaining the same caller-supplied code fingerprint. A CLI source
edit still fails the strict run-level gate unless explicitly accepted. Completed results never rerun
merely because policy changed.

Rules append to the saved `policy` array. Later matching fields win over call-site fields, which win
over adapter defaults. `retry` fields merge individually. `--policy-reset` (embedded
`policyReset: true`) clears saved rules before adding new ones. A bare resume keeps saved rules.
Globs use `*` within a slash segment and `**` across segments; `verify/**/skeptic-*` includes zero
or more intervening segments. `kind` filters `claude`, `codex`, or `step`; sleep has no overrides.
Provider-specific fields on a rule without `kind` apply only to that provider. Profiles are deferred
to the profile API; `profile` is not an accepted rule field yet.

All rules are validated before effects. Unmatched rules produce saved `policyWarnings` for the
visited path, also returned/printed as warnings on successful execution. `model` and
`reasoningEffort` overrides require `--allow-model-override` (`allowModelOverride: true`) when
added. That authorization is saved with the rules. They change only unfinished attempts; completed
results keep their original model and never rerun. Tools, sandbox, and other capabilities cannot be
changed by a policy rule. Resetting policy also clears saved model authorization unless explicitly
granted again.

Inspect `steps[id].attemptHistory` for resolved limits, `sources`, requested model/effort,
timestamps, and outcome. Sources are `runtime`, `harness`, `call-site`, or `override:N` (the
zero-based saved rule index). Custom harness defaults are recorded only when the adapter reports
them. `running` means settlement was not checkpointed, not proof that the process still lives.

## Legacy records

New checkpoints use storage format 7 while preserving replay contract 6. Compatible flat format-6
runs migrate automatically under both legacy and current locks, retaining exact `<runId>.json.v6`
backup bytes and a rejecting format-7 marker at the old filename. Original format-1 runs also
migrate with a `.json.v1` backup: their first body replay verifies original dependencies, schemas,
retries, and raw agent options before assigning current identities. Original attempt counts are
retained; unknown old timing/callback hashes are not fabricated. A changed original step still
refuses reuse.

Format 1 has only an aggregate code/schema fingerprint. A mismatch requires explicit code
acceptance; name, version, cwd, input, and old step checks remain. Old CLI hashing included absolute
paths and engine files, so an engine upgrade alone can require acceptance. Format-1 sources must
migrate before fork reuse. Intermediate private formats 2–5 remain inspectable but require their
original runtime to resume. Backups and markers are retained, never automatically deleted. An
interrupted initial migration can recover its original backup; a finished marker cannot substitute
for missing current state.

## Storage, ownership, and cancellation

The target is a local POSIX filesystem. Storage resolves explicit `stateDir`, then
`QUIET_CHOIR_STATE_DIR`, then an existing run's legacy `<cwd>/.quiet-choir/runs`, then
`${XDG_STATE_HOME:-~/.local/state}/quiet-choir/<project>-<hash>/runs`. The bounded project basename
and first 12 SHA-256 characters of `realpath(cwd)` distinguish worktrees while sharing symlink
aliases. `project.json` registers default projects for `workflow list --all`. Retain the CLI's
printed absolute state path when operating from another project.

Each `<stateDir>/<runId>/` contains `run.json`, `journal.jsonl`, `lock/`, and on-demand `inbox/` and
`artifacts/<encoded-prefix>--<full-hash>/<attempt>/`. Opt-in [worktree caches](worktrees.md) default
to a separate project-state container outside the checkout, with recorded per-run ownership and
pinned Git refs. Artifact directory components are bounded and distinguish exact IDs even on
case-insensitive filesystems. Artifact writers must use 0600; diagnostic bytes need not be synced
and are never replay inputs. Native attempt transcripts now live under
`attempts/<sha256-full-step-id>/`; see [streaming and retention](agent-streaming.md).

Concurrent saves share journal appends and flushes. Completions, failures, questions, run status,
and sleep wake deadlines are durable before their promises/events become observable. Agent starts
(including predicted session IDs) are durable. Other ordinary starts are appended unsynced: process
crashes retain them, but power loss can undercount attempts. Failed writes retry without rerunning
successful actions in that process. Compaction flushes and atomically renames a snapshot, flushes
its directory, then truncates the journal. It runs on status changes or roughly 4 MiB of journal
data. Read with `readRun` or `inspect`, which apply entries newer than root `seq` and retry
compaction races; `cat run.json` alone can be stale. Readers ignore a torn final line, which the
next owner truncates. Complete corruption, sequence gaps, and missing journals refuse.

A per-run `lock/` has `owner.json` containing a PID, hostname, birth identity and token. Every lock
change is one rename: an acquire publishes a sibling directory that already holds a fsynced
`owner.json`, and release or recovery renames the verified lock to a `.gone` tombstone before
deleting it, so a SIGKILL at any step leaves a run that a plain resume recovers. The next owner
sweeps stray tombstones and dead acquirers' `.tmp` directories. Dead/released same-host owners can
be recovered only after checking child records in `processes/<pgid>.json` (PID on Windows). One
recoverer at a time holds an atomically linked `recovery.json` (PID, host, birth identity, token) in
the lock; a live, unknown or remote recoverer refuses others with "lock recovery is in progress",
and the next acquire reclaims a dead recoverer's marker. Live and foreign-host owners are refused.
Confirmed live or unverified children cause exit 3 before replacement work. Inspect first;
`--resume --kill-orphans` stops only identity-confirmed groups and verifies they are gone. Reused
PIDs are never signaled; missing identity, malformed records and leaderless surviving groups remain
for separate inspection. A lock without readable `owner.json` (damage, or an older build's
interrupted acquire), with an unreadable `recovery.json`, or owned by a foreign host that was
renamed or is gone is cleared with `workflow unlock RUN --state-dir DIR` (`--force-remote` asserts
the foreign host is this machine or gone) after confirming there is no active owner. Unlock refuses
live or unverifiable owners, recoverers and children, removes locks only by the tombstone rename,
and never signals. An older build's `recovery/` directory is ignored. Never delete lock directories
by hand, and do not unlock merely because a run looks stalled. Migrated runs acquire the legacy
guard before the current lock and hold both through release; new children belong to the current
lock. This prevents an abandoned old guard from bypassing a live new owner. Owner-only cleanup
removes recognized UUID snapshot temporary files for that run and preserves unrelated data.

Map failures default to `drain`: stop scheduling and let active mappers checkpoint without an abort
signal before rejecting with `FanOutError`. Body rejections, including `Promise.all`, close the
workflow: effects already started finish and checkpoint without a signal, but every new launch fails
with "Workflow is closed", including an active mapper's next step or a map started by a
still-running branch. Catch inside branches or use `Promise.allSettled` to let siblings finish.
Explicit map `abort` cancels only that subtree; `ctx.signal` reads the current scope. Caught map
failures leave the parent scope usable. Local callbacks must eventually settle or draining can hang.
Run interruption cancels every scope. One Ctrl-C, SIGTERM or SIGHUP terminates owned harness groups,
drains active work, saves a resumable run status `suspended` with `nextWakeAt` = now and
`interruptedBy: {reason, at}` (no `rootCause`), and exits 130; the next tick or `resume` continues
from completed steps. Tick's own --timeout interrupts the same way. An embedder opts in by aborting
`RunOptions.signal` with `RunInterruptedError`; any other abort reason, or a workflow-scoped
`CancelledError`, saves `cancelled`. To end a live run on purpose use `workflow cancel RUN`, which
signals only its identity-verified local owner and makes it save `cancelled` (see
[operating runs](operating-runs.md)). stderr prints “Send again to force.” Cancelled steps record
`cancelledBy`; inspect `rootCause` to identify an initiating failure instead of reading cancellation
messages as independent root failures. A second signal synchronously SIGKILLs every tracked group,
then exits 130 without awaiting writes; the lock and an older `running` record can remain. EIO/EPIPE
from a closed terminal do not interrupt cleanup.

SIGKILL or a crash cannot run handlers. Use `workflow inspect ID --state-dir PATH --json` to see
`ownership.owner` liveness and `ownership.processes` with binary, PID/group, step, attempt and
state. To stop confirmed survivors before retrying:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --resume --kill-orphans --kill-grace-ms 5000
```

The default TERM grace is 3000ms, configurable with `--kill-grace-ms` (not sticky). Every leader
exit, including success, reaps its group and drains pipes for at most two seconds. A 500ms backstop
after KILL settles even if another group holds stdout. An output consumer that never settles fails
the call and keeps its record. Valid results survive cleanup warnings; unreaped records retain a
released-owner lock for recovery. Windows tracks/reaps immediate children.

A crash between spawn and durable registration can still leave an unrecorded child. Descendants that
create another group/session escape ownership. OS birth checks have platform resolution and a
check-to-signal race (macOS ps start time has second resolution); they are not atomic process
handles. Unconfirmed records are retained and never authorize recovery signals. Investigate those
processes separately; once they are gone, `workflow unlock` clears the lock. Never unlock because a
checkpoint is old. No cleanup undoes edits.

Checkpoints contain plaintext workflow input/output, every completed step's full validated result
(including agent responses and files a local step read), and errors. Checkpoint files are created
0600; state/lock directories are created 0700. These modes do not repair pre-existing directory
permissions. New state containers get a non-overwriting `.gitignore` containing `*`, protecting
in-tree state from ordinary `git add -A`, `git clean -fd`, and `git stash -u`; `git clean -fdx` can
still remove it. External state avoids ordinary workspace cleanup but does not isolate same-user
unsandboxed code. There is no distributed lease, background scheduler, durable event bus, or global
spending ledger in this version.

## When checkpointing fails

The runner retries transient filesystem write errors up to three times, with 100 ms and 300 ms
between attempts. Writes stay ordered, and one failed write does not poison later saves. If writes
remain unsuccessful, the runner aborts and drains active work before releasing ownership; new
effects cannot start. A completed action is not marked failed or rerun in-process just because its
save failed. A later failure-state save may still recover the completion. If it did not, resume can
repeat the external action under the normal at-least-once contract.

A stale `running` checkpoint with `error: null` can mean storage failed, not only a crash or a long
call. Check the execution error as well as the saved record. Exported `CheckpointError` identifies
`save`, `release`, or `process` registry persistence; combined errors preserve the workflow error
first. If the state directory was removed, the runner names it and does not recreate it or silently
reacquire ownership.

After a persisted completion, lock release produces an invocation warning and preserves the
successful result when the lock directory is already gone, its removal fails with `EACCES`/`ENOENT`
after the ownership token was verified, or retained child records keep a released-owner lock. The
CLI prints the warning on stderr; embedded and JSON results expose `warnings`. These warnings are
not checkpointed. Lost ownership, and missing or unreadable `owner.json` in a remaining lock
directory, still fail, because another writer may have replaced the checkpoint. Inspect and repair
any retained lock before running again; do not repeat the effects merely to retry cleanup.
