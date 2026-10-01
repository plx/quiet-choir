# 0034: Compact results for the run commands, the full record behind --full

- Status: accepted
- Issue: #133
- Supersedes the "CLI success shapes remain unchanged" consequence of
  [ADR 0014](0014-scriptable-cli-errors.md) for `workflow execute`, `resume` and `answer --resume`.

## Context

`workflow execute`, `resume` and `answer --resume` printed the whole run record on success, and
their suspension and failure documents embedded it as `run`. A reader of a finished run's stdout,
especially an agent session, got hundreds of kilobytes for a result of a few kilobytes. Measured on
fixture runs: `execute --json` of 180 fake calls printed 800,043 bytes for a 2,751-byte output, 40
calls printed 318,856 bytes, a successful `answer --resume --json` 29,457 bytes and an
`answer.invalid` error document about 20 KB. The success documents also lacked the `kind`, `ok` and
`exitCode` that suspension and failure documents carry, so a script first had to test whether `kind`
existed, and `answer --resume` printed no `stateDir`.

## Decision

One pure projection, `summarizeRunResult(run, stateDir)` in `src/workflow/loader/run-result.ts`,
reduces a run record to `{runId, stateDir, status, output, usage, counts, rootCause, warnings}`.
`usage` is `{costUsd, attempts, undercounted}` from `summarizeUsage`; `undercounted` is true when
the totals may be low, because of legacy ambiguity or because some attempts have unknown cost or
tokens. `counts` is the step total by status (`countSteps`, shared with `summarizeRun`). `warnings`
are the invocation warnings the runner returned or else the record's warning lists, de-duplicated
and capped at 20 plus one overflow note, so the envelope stays bounded. `output` is not truncated.

The CLI uses it in three places, for the three commands only:

- Success: `{kind:"workflow.run.result", ok:true, exitCode:0, ...summary}`.
- Suspension: the existing fields (`kind`, `ok`, `exitCode: 75`, `runId`, `stateDir`, `pending`,
  `resumeCommand`) with the projection under a new `summary` key instead of `run`.
- Failure: the existing fields with `summary` (null when no record was readable) instead of `run`.
  This includes `answer.invalid`, `answer.conflict` and `run.not_found` from `answer` without
  `--resume`; its `workflow.answer.result` success document is unchanged.

`summary` is a new key and `run` is absent, so a script that still reads `doc.run.steps` fails
loudly instead of silently reading a different shape under the old name.

A new `--full` flag on the three commands restores today's documents: `{...run, stateDir}` for
success (no `kind` or `ok`; `answer --resume` gains `stateDir`, which makes the three commands
consistent) and the suspension and failure documents with `run`. `--full` is read from argv before
the first `--`, as `--json` is, because the failure path can run before argument parsing succeeds,
including the synchronous write after a second signal.

`execute --dry-run` documents are unchanged: a rehearsal deletes its temporary state, so the
embedded record is the only copy. Compact mode applies only when there is no rehearsal. Every other
command's failure document keeps `run`: `workflowErrorDocument` takes an options argument,
`{compact}`, that defaults to the old behaviour, and `WorkflowCommand.compactRunDocuments()` is
false except in the three run commands. Human (non-JSON) output is unchanged.

## Consequences

- This is a documented contract break for every script that reads record fields (`steps`,
  `executions`, `harnesses`, `run.*`) from these commands' stdout. They pass `--full`, or read the
  envelope, or run `workflow inspect`. In-repo smokes were adapted the same way, and the pipe smoke
  (#122) keeps its large documents by passing `--full`.
- The default document is bounded by the output size and at most 21 warnings, not by the step count:
  the 180-call fixture run prints under 1 KB, and an `answer.invalid` document about 1 KB.
- Later tickets that add fields to these documents (failure categories, runnable next commands,
  structured answer issues) extend the same builders.
- ADR 0014's statement that CLI success shapes remain unchanged no longer holds for these commands.
