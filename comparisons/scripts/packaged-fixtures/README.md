# Batch 03 fixture modules

Every Batch 03 package beyond Batch 02's six has one fixture module here, `<name>.mjs`, named like
the package's workflow. `idiomatic-fixtures.mjs` loads every module at import (files starting with
`_` are support, not fixtures), and the per-package checks in `../packaged-checks.mjs` run it:
`verify-packaged-ports.mjs` for every package, and `check-packaged-port.mjs <name>` for one while
you author it. The modules live outside the package roots because every file under a root is
fingerprinted.

A module imports only Node built-ins, `./_support.mjs` and sibling fixture modules, never
`../idiomatic-fixtures.mjs`, which loads it with top-level await. A sibling imports only the same,
so importing one cannot deadlock: a package that composes another's workflow may delegate the
child's steps to the child's module, as prd-to-spec does for its design-tournament child, mapping
its own modes onto the child's. `_support.mjs` provides:

- `git(cwd, ...args)`, `writeFiles(cwd, files)` and `commitAll(cwd, message)`, with fixed dates and
  the fixture identity.
- `enumOf(schema, ...path)`, the members of an enum in a request's JSON Schema.
- `leaf(stepId)`, the segment after the last `/`.
- `ordered(calls, pattern)`, the calls whose step ID matches `pattern` in item order: by its first
  capture group when it has one, else by the step ID, numeric segments by value.
- `within(request, prefix)`, the request with `prefix` (for example `'tournament/'`) cut from its
  step ID, as the child's own `reply` and `fail` expect it.

## The fixture repository

Each run starts from a fresh Git repository (`env.cwd`) with two commits: `target.mjs`
(`export const value = 1;\n`) and `.gitignore` at `env.since`, then `README.md` at `env.until`
(HEAD). `env.root` is a scratch directory beside it; runs use `env.stateDir` and `env.worktrees`.
The run's grants are `all`, its agent limit is 1, and every harness reply is inert: nothing happens
unless a reply makes it happen.

## Exports

| Export                                                        | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `input(env)`                                                  | yes      | The workflow input of the success run and of the fault matrix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `reply(request, env, mode)`                                   | yes      | The output of one agent call: an object for a schema call, else a string. Key on `request.call.stepId`; `request.options.prompt` is the rendered text, `request.cwd` the call's working directory (a worktree for an isolated writer), `request.outputSchema` the JSON Schema. A writer's reply may write files under `request.cwd` before it returns. Throw for an unexpected step: the engine records a throw as an agent failure of kind `unknown`, which a settled call or map keeps as data, so every check (the success run, the F1–F4 runs, each mode) fails when a reply threw. Inject a failure on purpose with `fail`, not by throwing.                                                                                                                                                                  |
| `check({ result, env, calls, record, suspended, questions })` | yes      | Assert the success run: `result` is the completed run, `calls` the harness requests, `record` the saved run, `suspended` how many times it suspended, `questions` the `{ question, value }` pairs answered, in order. `calls` are in admission order, which need not be item order inside a concurrent map, even at agent limit 1; sort them with `ordered`. Check the output contract and the filesystem the workflow should leave.                                                                                                                                                                                                                                                                                                                                                                               |
| `setup(env, mode)`                                            | no       | Add files to the fixture repository before the run (use `writeFiles` and `commitAll`); it may add fields to `env`, which the kill worker receives too. `mode` is the mode about to run, `'normal'` for the success run, the fault matrix and the kill case; a mode's own `setup` runs after it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `answer(question, env, mode)`                                 | no       | The inbox answer of a durable question, or `undefined` for the default: `{ approved: true }` for a step whose leaf is `approve-<name>`. `env` is the run's fixture and `mode` its mode, `'normal'` outside modes, so a mode can decline, or change the repository while the question waits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `fail(request, mode)`                                         | no       | Return true to fail this call as a nonzero process exit (for modes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `faults`                                                      | no       | The F1 and F2 targets: `{ F1?, F2? }`, each a regular expression source matched against step IDs like `kill.step`. F1 fails the first call whose step matches, F2 the first matching schema call; the cell records the step as `faultedStep`, and a pattern that matches no call fails the check. Without it F1 takes the first call and F2 the first schema call, which a concurrent map admits in no fixed order even at agent limit 1. A port whose first agent stage is a concurrent or settled fan-out should name a step, preferably one whose failure fails the run.                                                                                                                                                                                                                                        |
| `kill`                                                        | no       | The F3 kill point of a port that writes: `{ step, boundary, writeLocation, pristine? }`. `step` is a regular expression source matched against step IDs; `boundary` is `'response'` (killed after the matching agent's reply wrote its files, before its response is recorded) or `'checkpoint'` (killed after the matching step completed, before its checkpoint is appended); `writeLocation` is `'isolated-checkout'` or `'source-checkout'`; `pristine: false` when the run legitimately leaves `target.mjs` changed. Inside a concurrent map `step` must match every item (`\d+`, not `0`): naming one item lets the kill land before a sibling's completion is checkpointed, so that sibling is paid again on some runs and `callsPaidAgain` varies between verifications. Omit `kill` for a read-only port. |
| `faultCheck`                                                  | no       | `true` fails the check when the F3 or F4 resumed output differs from the success run's. Without it the cells only record the comparison as `outputMatchesSuccess`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `degraded(output)`                                            | no       | True when the output admits a degradation that the fault matrix does not already count from its own status list (`degraded`, `call-limit`, `needs-review`, `verification-failed`, `baseline-failed`, `gaps-remain`): a failed tolerant member, an unchecked candidate, or a status of the package's own vocabulary such as `'limited'`. The matrix records either as `outputAdmitsDegradation`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `readOnly`                                                    | no       | The F3 "not applicable" reason for a read-only port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `modes`                                                       | no       | Extra contracts, each a fresh run; see [Modes](#modes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`setup`, `input`, `reply`, `check` and a mode's `setup`, `input`, `check`, `repair.run` and
`resumeCheck` may be async; the checks await them. `answer`, `fail`, `degraded` and a mode's
`options` must return their value synchronously.

## Modes

`modes` is a list of
`{ mode, setup?, input?, options?, rejects?, repair?, resumeCheck?, allowReplyErrors?, check }`.
Each runs fresh under `harnessFor(..., { mode })`, so `reply`, `fail` and `answer` see `mode`, and
the run ID is `mode-<mode>`:

- `setup(env)` changes the repository for this mode alone, after the module's `setup` and before
  `input`; prefer it to changing the repository inside `input` or `options`.
- `input(env)` replaces the module's input; `options(opts, env)` returns the run options, for
  example with a wrapped harness or `requireGrants`.
- `check({ result, env, calls, record, suspended, questions })` asserts the outcome, with the
  arguments of the success run's `check`; then a resume must pay nothing again.
- `rejects` (a RegExp) expects the run to fail with it. `check` then gets
  `{ result: record, env, calls, record, questions }`: the failed record, or `null` for both when
  the run was refused before it saved a record (an input the schema rejects, a missing grant), and
  the row's `finalStatus` is `'refused'`.
- `repair: { run?(env, record), mode?, paid? }` on a rejects mode heals the cause after `check` and
  resumes the failed run under a fresh harness in `repair.mode` (the mode itself by default; a
  harness that `options` wrapped is not reused). The resume must complete, pay no completed call
  again and, when `paid` lists step IDs, pay exactly those, in any order. `resumeCheck` then gets
  `{ result, env, calls, record, suspended, questions }`, with `calls` and `questions` running on
  from the failed run, and the row records `resumedStatus` and `resumedCalls`.
- `allowReplyErrors: true` lets a mode's replies throw.

## Faults

F1 fails the first agent call (or the first call `faults.F1` names) as a process exit. F2 returns a
schema-invalid reply to the first schema call (or the first call `faults.F2` names) and to every
in-run retry of that step, so a schema retry policy cannot absorb it; the resume gets valid replies.
Both must resume to completion without paying for a completed call again. F3 kills the run at `kill`
and resumes it. F4 wraps the workflow so that its first run throws, then accepts a one-statement
code fix on resume. F5 counts the durable questions the success run suspended on.

F3 and F4 end where the success run does, so their cells record `outputMatchesSuccess`: whether the
resumed output equals the success output once what differs between any two runs is replaced (each
run's checkout, scratch root and run ID, every UUID, and every number under a key ending in `Ms`)
and Git object IDs, which commits dated at run time change, are compared only by where each one
recurs. A kill at a write checkpoint, for example, resumes to a receipt whose `previousSha256` is
the file's own digest, which the cell shows as `false`.
