# Durability and resumption

## What survives

The run checkpoint stores input/output, workflow identity, working directory, step records, and
errors as JSON. It stores neither closures nor a call stack. A resume runs the workflow body from
the beginning: completed effects replay saved results; unfinished/failed effects execute again. A
completed compatible run returns saved final output without running the workflow body or a harness.
The CLI still typechecks and imports the module first.

Keep clocks, randomness, filesystem/network reads, and writes inside durable effects. Branch on
input and saved results. Local effects have explicit `input` dependencies; their closures are not
fingerprinted. Await operations and compose at the workflow level, never by nesting steps inside a
local effect callback. The runtime drains launched operations and effects launched by their
immediate continuations before releasing its lock. An ignored rejection fails the run regardless of
when it settles; a failure that is awaited and caught may be handled in the workflow body. Arbitrary
detached async tasks are not owned by the runner, so this protection does not replace awaiting
operations.

## Compatibility gates

| Scope            | Compatibility rule                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Run              | Name, version, source/schema fingerprint, absolute cwd, and validated input still match                            |
| Completed step   | ID, kind, input/prompt, schema, model/effort, capabilities, and resolved cwd match; errors name changed components |
| Unfinished step  | A changed identity is adopted, the old hashes remain in `redefinitions`, and `step.redefined` is emitted           |
| Execution policy | `timeoutMs`, `maxTurns`, `maxBudgetUsd`, and `retry` may change without invalidating any step                      |
| Replay path      | Every completed step must be visited; unvisited unfinished records become `superseded` when the body completes     |

The CLI fingerprints compiler-discovered local sources and the nearest tsconfig. It does not fully
capture runtime-computed dynamic imports, node_modules, external files, environment, or service
behavior. Bump the workflow version when such changes alter semantics, then start a new run.
Embedded callers must supply their own `fingerprint` to add code-change detection. Do not edit
checkpoints or relax fingerprints to force incompatible code through resume.

The skipped-completed-step check runs only after the body finishes. A divergent resume can perform
and pay for remaining effects before failing at that check; later resumes still fail until the
original compatible path is restored. Saved values must survive lossless JSON serialization.
Completed results are revalidated on replay; plain JSON is also required for local-step
dependencies. See [authoring](workflow-authoring.md) for schemas and data restrictions.

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
3. Resume with the same ID and storage. A change to completed-step semantics still requires a new
   run. Embedded callers can redefine unfinished steps; CLI source edits remain blocked by the
   source fingerprint until the separate code-compatibility work lands.

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
edit still fails the run-level gate. Completed results never rerun merely because policy changed.

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

New checkpoints use format version 2. Version 1 remains inspectable, but this runtime refuses to
resume it with a clear message and leaves its data unchanged: its opaque hash cannot reliably
separate policy from identity. Resume with the original runtime or start a new run after accounting
for previous effects. There is no automatic migration.

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
