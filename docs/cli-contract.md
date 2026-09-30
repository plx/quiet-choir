# Scriptable workflow commands

Place flags after the command name. `workflow execute FILE --json` and `workflow inspect ID --json`
each write one single-line JSON document. Validate, typecheck, and check-resume use the same failure
contract, including argument parsing errors. Request human help without `--json`. Use
`npm run --silent cli -- …` when invoking through npm; quiet-choir cannot suppress its parent
process's banner.

Success documents retain their shapes: execute returns a run plus its absolute `stateDir`, inspect
returns a run with current ownership diagnostics, validate returns workflow metadata, typecheck
returns its compiler result, and check-resume returns a compatible comparison in `check`.
`inspect --json --summary` returns the compact dashboard, and `workflow list --json` returns
`{kind, ok, stateDir, runs, warnings}`. `list --all` discovers registered XDG projects without
imports; rows include `cwd` and `stateDir`. `execute --resume --run-id ID` may omit FILE and use
stored launch paths, as does `resume ID`. A supplied different FILE is refused before import. See
[storage](storage.md). `inspect --watch --json` emits JSONL per checkpoint/ownership change, ending
with a snapshot and exit 0/1/130/3 for completed/failed/cancelled/stale. It does not add an error
document for an observed failure. An interrupted watcher emits an error document and leaves the
observed run untouched. See [run observability](observability.md) for polling, stale detection, and
partial usage. Non-watching inspect exits 0 for any readable checkpoint status, including `failed`,
`cancelled`, and `running`. `workflow pending --json` returns
`{kind:"workflow.pending.result", ok, pending}`, `workflow answer --json` returns
`{kind:"workflow.answer.result", ok, delivery}`, and a suspension returns
`{kind:"workflow.run.suspended", ok:true, exitCode:75, runId, stateDir, pending, resumeCommand, run}`.

`execute --dry-run --json` returns a `workflow.rehearsal` document with `ok:true`, calls, replays,
provider counts, nominal Claude ceiling, warnings, and its in-memory run record. Failures retain the
usual error document and exits, adding `rehearsal` and `error.stack`. Temporary state has already
been removed on normal exit; dry-run never overwrites the requested/default state directory.
`workflow fixtures ID --json` returns version-1 fixture JSON from a completed run. See
[workflow rehearsal](rehearsal.md).

Failures have these fields:

| Field                         | Meaning                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `kind`, `ok`, `exitCode`      | `"workflow.error"`, `false`, and the process exit code                                                                  |
| `error.code`, `error.message` | Stable code and diagnostic naming the root effect when available                                                        |
| `error.stepId`                | Root failing effect, or null for a body failure or interruption; never an aborted sibling                               |
| `error.details`               | Structured context: lock PID/host, schema issues, input source/position, compatibility comparison, or available run IDs |
| `runId`, `stateDir`           | Requested/generated ID and absolute storage directory when known; otherwise null                                        |
| `status`, `run`               | Actual saved checkpoint status and record, or null when unavailable                                                     |
| `failedSteps`                 | Saved failed/cancelled steps with ID, kind, attempts, and error                                                         |
| `diagnostics`                 | Compiler diagnostics, or an empty array                                                                                 |

The error codes map to numeric exits in one CLI table:

| Exit | Codes                                                                                                                                                                                                                 | Next step                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1    | `workflow.failed`                                                                                                                                                                                                     | A failed checkpoint was saved. Fix the workflow or execution policy and resume.                                          |
| 2    | `usage.flag`, `usage.file_not_found`, `usage.entrypoint`, `usage.run_id`, `usage.input_json`, `usage.input_file`, `usage.input_schema`, `usage.resume_requires_run_id`, `answer.invalid` (the answer was not written) | Correct arguments/input. No execution checkpoint was written.                                                            |
| 3    | `run.exists`, `run.not_found`, `run.locked`, `run.incompatible`, `run.input_changed`, `run.unreadable`, `run.orphans`, `answer.conflict` (the question is not waiting or already has a delivery)                      | Correct run/storage selection, wait for the owner, or explicitly resolve compatibility/ownership. No workflow body ran.  |
| 4    | `load.typecheck`, `load.import`, `load.definition`                                                                                                                                                                    | Fix trusted source or its definition. No execution checkpoint was written.                                               |
| 74   | `workflow.storage`                                                                                                                                                                                                    | Inspect saved state and fix storage/ownership before deciding how to resume. External effects may already have happened. |
| 75   | `workflow.run.suspended`                                                                                                                                                                                              | Saved suspension with pending waits; answer questions, deliver signals, or tick when due.                                |
| 130  | `workflow.interrupted`                                                                                                                                                                                                | Inspect the returned state and resume when ready.                                                                        |

Typechecking and import are distinct from workflow execution. Imports can have arbitrary side
effects; no exit status promises to undo them. Run-ID and input-JSON validation happen before
import. Schema validation needs the imported workflow definition. Resume with a schema-invalid
replacement input is usage failure; valid but changed input is `run.input_changed`.

An ordinary interrupt drains owned work and saves `cancelled` when storage permits. A second signal
kills tracked groups and writes the last readable checkpoint synchronously before exit 130;
`error.details.forced` is true and `status` may still be `running`. SIGKILL, process crashes, and a
closed output pipe cannot deliver a JSON document. Failure documents, like success documents, are
written in full before the process exits, including when stdout is a pipe. Storage failures use exit
74 so that a failed save never masquerades as exit 1, and a storage failure during an interrupt
keeps exit 74 rather than 130 because the cancellation checkpoint may not have been saved. A run
whose saved status is `failed` reports `workflow.failed` (exit 1) even when a signal arrived,
because the runner saves `cancelled` only when the interrupt caused the failure. Saved completion
with a known cleanup warning still succeeds under the
[process ownership contract](process-lifecycle.md), as does a completion or suspension (exit 75)
that `execute`, `resume`, or `answer --resume` saved before a late signal, or an answer that
`workflow answer` already delivered. Inspect, validate, typecheck, and check-resume report
`workflow.interrupted` after a first signal even when their work finishes.

`check-resume` incompatibility uses exit 3 with the full comparison in `error.details`. Its
compatible success retains `check`. A missing run includes `details.stateDir`, sorted
`details.available` (at most 20 IDs), and `details.count`. Storage resolves explicit options,
environment, existing legacy runs, then the external XDG project default; relative explicit paths
resolve against the launch directory.

Workflow `console.log` and `process.stdout.write` during import/execution are redirected to stderr
in JSON mode. `Run ID:`, debug logs, warnings, and human diagnostics also use stderr. Redirecting
output does not sandbox trusted workflow code.

## File and stdin input

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute workflow.ts --input @input.json --json
cat input.json | node "$QC_CHECKOUT/bin/run.js" workflow execute workflow.ts --input - --json
```

File paths resolve against the shell's working directory. Unreadable files report
`usage.input_file`; invalid JSON reports `usage.input_json` with the source and zero-based character
offset. Omitting input retains `{}` for new runs and the saved/source input for resume/fork.

## Embedding migration

`runWorkflow` throws `WorkflowRunError` after saving a failed/cancelled run. Its `run` is the saved
snapshot, `runId` identifies it, `stepId` is the root effect, and `cause` is the prior rejection.
Match application errors, `HarnessError`, or `FanOutError` through `cause`. If checkpoint problems
were combined, that cause is the existing `AggregateError`, whose cause remains the original primary
failure. An unsuccessful failure save leaves the existing checkpoint-error behavior intact and does
not invent a saved run.

`RunRefusedError` has a stable `run.*` code, run ID, plain details, and an optional underlying
cause. `WorkflowInputError` has `usage.input_schema`, validation issues, and the validator cause.
`isValidRunId` and `CliErrorCode` are exported for callers. `readRun` retains its low-level ENOENT
contract. See [the changelog](../CHANGELOG.md) for the prototype API break.

`workflow typecheck` lists effective compiler flags in human output. JSON success includes
`compilerOptions`; a typecheck failure includes it in `error.details`, alongside compiler version
and config path. Built-in defaults add `noUncheckedIndexedAccess` to strict Node/ES2023 checking;
`exactOptionalPropertyTypes` is enabled only by a project config. Resume also typechecks, so an
unchanged in-flight run can be blocked by these stricter defaults before import or effects.

## Tick

`workflow tick` returns a single aggregate JSON document: `resumed` entries with each started
resume's outcome (completed, suspended, failed, cancelled or incompatible), `skipped` entries with a
reason (not due, no longer due, locked, running, incompatible or unreadable), and an `observed`
count of already-terminal runs. Each run appears in at most one entry. With --run, exits are 0
completed (now or earlier), 75 pending, locked or running, and 1 failed, cancelled, incompatible or
unreadable; batch per-run failures remain data with exit 0. Usage/infrastructure errors retain the
command failure document. --watch is bounded by --timeout (default 540s), with --max-runs limiting
executed resumes. `--harness-config` supplies CLI harness configuration (JSON or `@file`) for
resumed CLI runs, since the checkpoint stores only the harness kind, not its config. See
[waits](waits.md) for due detection and notification hooks.
