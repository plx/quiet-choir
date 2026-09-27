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
local effect callback.

## Compatibility gates

| Scope       | Must remain compatible                                                                  |
| ----------- | --------------------------------------------------------------------------------------- |
| Run         | Name, version, code/schema fingerprint, absolute working directory, and validated input |
| Step        | Unique ID, kind, dependencies/options, schema, and retry policy                         |
| Replay path | Every previously recorded step must be visited before the run completes                 |

The CLI fingerprints compiler-discovered local sources and the nearest tsconfig. It does not fully
capture runtime-computed dynamic imports, node_modules, external files, environment, or service
behavior. Bump the workflow version when such changes alter semantics, then start a new run.
Embedded callers must supply their own `fingerprint` to add code-change detection. Do not edit
checkpoints or relax fingerprints to force incompatible code through resume.

Saved values must survive lossless JSON serialization. Completed results are revalidated on replay;
plain JSON is also required for local-step dependencies. See [authoring](workflow-authoring.md) for
schemas and data restrictions.

## At-least-once effects

There is a crash window between external success and saving the result. Resuming can repeat the
external action, including an agent call that already changed files. Use the local step callback's
stable `idempotencyKey` with systems that support deduplication; it is not automatically sent to the
Claude/Codex CLIs. Workspace edits and harness conversation state are not transactional. Do not
assume that retrying an error is harmless or that a new run deduplicates an old run's work.

Local steps retry only when opted in; agent calls have no automatic retries. An explicit resume
retries unfinished work. `ctx.sleep` saves a wall-clock deadline and waits only its remaining
duration after resume; it neither schedules background work nor wakes a stopped process.

## Recovery procedure

1. Inspect the run in its original state directory; identify failed/running effects and any external
   actions that may already have happened. Stop orphaned harness children after a hard kill.
2. Repair transient dependencies (for example credentials or a service outage). Retain the original
   code, schemas, input, options, working directory, and version for a compatible resume.
3. Resume with the same ID and storage. If semantics need to change, start a new run and account for
   previous side effects instead of trying to migrate the checkpoint.

The checkout includes a local failure/recovery demonstration:

```sh
npm run cli -- workflow execute examples/local.workflow.ts \
  --run-id recovery --input '{"failOnce":true}'
# Expected exit 1: the word steps succeeded, the summary failed.
npm run cli -- workflow inspect recovery --json
npm run cli -- workflow execute examples/local.workflow.ts --run-id recovery --resume
```

Omit `--input` on resume to reuse the saved value. Repeat `--state-dir PATH` if the original run
used alternate storage. Completed word steps replay; the summary executes on its next attempt.

## Storage, ownership, and cancellation

The target is a local POSIX filesystem. Checkpoints are flushed to temporary files, atomically
renamed, then their directory entry is flushed. A per-run directory lock has `owner.json` containing
a PID, hostname, and token. Dead same-host owners can be recovered; live owners and foreign-host
owners are refused. Incomplete ownership metadata or an abandoned `recovery` directory requires
inspection and manual cleanup only after confirming there is no active owner. Do not delete a lock
merely because a run looks stalled.

Cancellation cooperatively aborts and drains active work before releasing the lock. Local callbacks
must honor their signal or draining can hang. A mapper failure cancels the whole run and stops
scheduling new items. Hard termination bypasses graceful cleanup and can leave children running.

Checkpoints use restrictive creation modes but contain plaintext input/output and error messages.
Keep the state directory out of version control. There is no migration engine, distributed lease,
background scheduler, approval inbox, durable event bus, or global spending ledger in this version.
