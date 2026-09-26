# Durability and resumption

## What survives

The run checkpoint stores input/output, workflow identity, working directory, step records, and
errors as JSON. It stores neither closures nor a call stack. A resume runs the workflow body from
the beginning: completed effects replay saved results; unfinished/failed effects execute again. A
completed compatible strict resume returns saved final output without running the workflow body or a
harness. The CLI still typechecks and imports the module first.

Keep clocks, randomness, filesystem/network reads, and writes inside durable effects. Branch on
input and saved results. Local effects hash explicit `input`, callback source, an optional step
`version`, and run cwd. Callback source does not reveal captured values or helper implementations.
Await operations and compose at the workflow level, never by nesting steps inside a local effect
callback. The runtime drains launched operations and effects launched by their immediate
continuations before releasing its lock. An ignored rejection fails the run regardless of when it
settles; a failure that is awaited and caught may be handled in the workflow body. Arbitrary
detached async tasks are not owned by the runner, so this protection does not replace awaiting
operations.

## Compatibility gates

| Scope            | Compatibility rule                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Run              | Name, version, source/schema/engine fingerprint, canonical cwd, and validated input still match                                   |
| Completed step   | ID, kind, input/prompt, schema, local callback/version, model/effort, capabilities, and cwd match; errors name changed components |
| Unfinished step  | A changed identity is adopted, the old hashes remain in `redefinitions`, and `step.redefined` is emitted                          |
| Execution policy | `timeoutMs`, `maxTurns`, `maxBudgetUsd`, and `retry` may change without invalidating any step                                     |
| Replay path      | Every completed step must be visited; unvisited unfinished records become `superseded` when the body completes                    |

The CLI hashes raw bytes of compiler-discovered local source files and the nearest tsconfig, using
real paths named relative to the tsconfig directory (or nearest package root, then entrypoint
directory when neither exists). Symlink aliases share a fingerprint. Quiet-choir's own `src/` and
`dist/` implementation files are excluded, except an explicitly selected entrypoint; engine package
version and checkpoint format are recorded in `workflow.identity.engine`. A comment or formatting
edit still changes the strict **run** source hash. `workflow.identity.files` and schema hashes make
errors identify changed components and files. `validate --json` reports the same full fingerprint
that a new run stores.

Dynamic imports assembled at runtime, external files, installed dependencies, environment, and
native harness configuration are not fully captured. Embedded callers supply `fingerprint`, or
`source: { hash, files }` for detailed diagnostics, never both. Use declared inputs and explicit
step/workflow versions for semantic changes these hashes cannot see. Do not edit checkpoints.

Every completed step must still be visited on resume. Before the first live effect with unvisited
earlier completed `seq` values, the runner emits `replay.divergence` and records `replayWarnings`.
`--strict-replay` aborts before that effect and cancels/drains other work; default mode warns and
the end-of-body skipped-step check remains. Launch order can vary under `ctx.map`, so this early
check is a heuristic, not proof of incompatible logic. A warning may precede paid effects in default
mode. Results are revalidated on replay; dependencies/results must be lossless JSON.

## Choose a recovery path

| Path                            | What stays fixed and what can change                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--resume`                      | Same run, source/schema identity, name/version, engine, cwd, and validated input; unfinished work retries                          |
| `--resume --accept-code-change` | Explicitly waive only source/run-schema changes; keep name/version, engine, cwd, input, completed-step identity, and replay checks |
| `--fork-from OLD`               | New run, same workflow name; source/version/input may change, completed effects are copied only when their identity matches        |

Forks default to `--reuse prefix`: consume source steps in first-use `seq` order, stopping reuse at
the first missing, changed, unfinished, skipped, or invalidated effect. All later effects run live.
This avoids reusing later workspace-dependent work after an earlier effect reruns.
`--reuse matching` explicitly reuses every matching completed ID; it can reuse a result whose
undeclared filesystem inputs changed when an earlier effect reran. Choose it only when dependencies
are fully represented by input/prompt/schema/versions. Neither mode reconstructs workspace edits or
provides isolation. Review the workspace and previous effects before repeating writes.

From the original launch directory, with absolute `QC_CHECKOUT` and `qc_state_dir`:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow check-resume review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --json
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-2 --state-dir "$qc_state_dir" --fork-from review-1 \
  --invalidate 'report/**'
# Alternatively, explicitly accept a tail fix on the original run:
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --resume --accept-code-change
```

`check-resume` acquires no writer lock, never calls the workflow body or harness, and does not write
the checkpoint. It still typechecks/imports trusted module top-level code. Its JSON `check` reports
`compatible`, changed/unchanged components, file differences, whether code acceptance is possible,
and whether a failed run has only completed effects. Exit 0 means the run-level gates pass; exit 1
means incompatibility or a load/read failure. Add `--accept-code-change` to check that mode. It does
not predict dynamically constructed steps, step compatibility, or replay order, and a concurrent
writer can change state after the check.

A fork never modifies its source checkpoint. `--fork-state-dir` selects alternate source storage;
omitting `--input` inherits source input, while explicit input is validated for the new run. Forks
do not inherit source policy overrides; the target's rules are independent. `--invalidate` accepts
repeatable step-ID globs with the same `*`/`**` rules as policy. Invalidating a prefix effect closes
prefix reuse. `forkedFrom` records source identity/differences, mode, and globs; copied steps carry
`reusedFrom` and emit `step.reused`. Failed/running/superseded source records are never copied.
Resume the target with `--resume` alone after interruption. Reuse progress survives; if the source
snapshot changed or disappeared, existing copied results remain and remaining work runs live with a
warning instead of borrowing new source results.

Each use of `--accept-code-change` records `codeChanges` with old/new fingerprints, changed files,
components, and time, even if execution later fails. It runs the body even for a previously
completed run. A fixed unfinished callback can execute again; a changed completed callback still
fails its step check. If only the body tail/output validation failed, a tail-only fix can finish
with zero repeated effects. `recoveryHint` and CLI errors identify this case, subject to step
checks. The accepted source becomes the basis for later strict resumes.

Local callback identity uses the loaded function's `toString()` plus optional `version`. Under the
CLI's tsx loader, comment/formatting-only callback edits preserve that source string; logic changes
do not. Other loaders and transpiler upgrades can cause extra misses. Captured values, external
helpers, environment, and bound/native function implementations are **not** visible to this hash.
Put values in `input`, bump the step `version`, or invalidate the step in a fork when they change.
The run's source guard remains useful; callback hashing alone does not make arbitrary edits safe.

Embedded equivalents are `forkFrom: { runId, stateDir?, reuse?, invalidate? }`,
`resume: true, acceptCodeChange: true`, and `strictReplay: true`. Exported
`checkResume(definition, { runId, stateDir, cwd, fingerprint?, source?, acceptCodeChange? })` checks
run gates without executing the supplied definition. `forkFrom` and `resume` are mutually exclusive.

## At-least-once effects

Effects can succeed without being saved after a crash or hard kill. Cancellation by Ctrl-C, SIGTERM,
a failing `ctx.map` sibling, or an uncaught failure can do this too: an action that finishes after
cancellation is recorded `failed`, its result is discarded, and it repeats on resume. Agent calls
stopped by cancellation or `timeoutMs` may already have edited files. A storage-triggered abort is
different: the runner preserves successful results for a later save, as described below. Use the
local step callback's stable `idempotencyKey` with systems that support deduplication; it is not
automatically sent to the Claude/Codex CLIs. Workspace edits and harness conversation state are not
transactional. Do not assume that retrying an error is harmless or that a new run deduplicates an
old run's work.

Local and agent steps retry only when explicitly given a `retry` policy; the default is one attempt.
An explicit resume retries unfinished work. `ctx.sleep` saves a wall-clock deadline and waits only
its remaining duration after resume; it neither schedules background work nor wakes a stopped
process.

## Recovery procedure

1. Inspect the run in its original state directory; identify failed/running effects and any external
   actions that may already have happened. Stop orphaned harness children after a hard kill.
2. Repair transient dependencies (for example credentials or a service outage). Retain the original
   source, run schemas, input, working directory, version, and completed-step identity. Execution
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

New checkpoints use format version 3. Versions 1 and 2 remain inspectable, but cannot resume or be
fork sources here: they lack the current callback/order/source contract. Refusal leaves their
checkpoint data unchanged. Use the original runtime to resume them, or start a new run after
accounting for previous effects. There is no automatic migration.

## Storage, ownership, and cancellation

The target is a local POSIX filesystem. Checkpoints are flushed to temporary files, atomically
renamed, then their directory entry is flushed. A per-run directory lock has `owner.json` containing
a PID, hostname, and token. Dead same-host owners can be recovered; live owners and foreign-host
owners are refused. Incomplete ownership metadata or an abandoned `recovery` directory requires
inspection and manual cleanup only after confirming there is no active owner. Do not delete a lock
merely because a run looks stalled. After acquiring ownership, the runner removes only that run's
abandoned `<runId>.json.<uuid>.tmp` files; it preserves other runs' files and unrelated temporary
data.

Cancellation cooperatively aborts and drains active work before releasing the lock. Local callbacks
must honor their signal or draining can hang. A mapper failure cancels the whole run and stops
scheduling new items. One Ctrl-C or SIGTERM terminates harness processes, drains active work, and
exits 130. A second Ctrl-C kills the runner mid-drain and can leave its lock and a `running` record.
SIGKILL, SIGHUP (closed terminal or dropped SSH), or a crash can leave detached harness children
running and editing. Before resuming, check `pgrep -fl 'claude --print|codex exec'` and identify any
children belonging to the interrupted run. SIGHUP handling and stronger orphan cleanup are deferred
to [#48](https://github.com/plx/quiet-choir/issues/48).

Checkpoints contain plaintext workflow input/output, every completed step's full validated result
(including agent responses and files a local step read), and errors. Checkpoint files are created
0600; state/lock directories are created 0700. These modes do not repair pre-existing directory
permissions. `.quiet-choir/` is gitignored only in this repository; exclude your chosen state
directory in other projects too. There is no migration engine, distributed lease, background
scheduler, approval inbox, durable event bus, or global spending ledger in this version.

## When checkpointing fails

The runner retries transient filesystem write errors up to three times, with 100 ms and 300 ms
between attempts. Writes stay ordered, and one failed write does not poison later saves. If writes
remain unsuccessful, the runner aborts and drains active work before releasing ownership; new
effects cannot start. A completed action is not marked failed or rerun in-process just because its
save failed. A later failure-state save may still recover the completion. If it did not, resume can
repeat the external action under the normal at-least-once contract.

A stale `running` checkpoint with `error: null` can mean storage failed, not only a crash or a long
call. Check the execution error as well as the saved record. Exported `CheckpointError` identifies
`save` versus `release`; combined errors preserve the workflow error first. If the state directory
was removed, the runner names it and does not recreate it or silently reacquire ownership.

After a persisted completion, `EACCES`/`ENOENT` during lock release produces an invocation warning
and preserves the successful result. The CLI prints the warning on stderr; embedded and JSON results
expose `warnings`. These warnings are not checkpointed. Lost or uncertain ownership still fails,
because another writer may have replaced the checkpoint. Inspect and repair any retained lock before
running again; do not repeat the effects merely to retry cleanup.
