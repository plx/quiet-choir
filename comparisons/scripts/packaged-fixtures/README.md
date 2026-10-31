# Batch 03 fixture modules

Every Batch 03 package beyond Batch 02's six has one fixture module here, `<name>.mjs`, named like
the package's workflow. `idiomatic-fixtures.mjs` loads every module at import (files starting with
`_` are support, not fixtures), and the per-package checks in `../packaged-checks.mjs` run it:
`verify-packaged-ports.mjs` for every package, and `check-packaged-port.mjs <name>` for one while
you author it (see [Checking one package](#checking-one-package)). The modules live outside the
package roots because every file under a root is fingerprinted.

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
(HEAD). `env.root` is the scratch directory that holds it and the run's `env.stateDir` and
`env.worktrees`. The run's grants are `all`, its agent limit is 1, and every harness reply is inert:
nothing happens unless a reply makes it happen.

## Exports

| Export                                                        | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input(env)`                                                  | yes      | The workflow input of the success run, of the fault matrix and of each mode without its own `input`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `reply(request, env, mode)`                                   | yes      | The output of one agent call: an object for a schema call, else a string. Key on `request.call.stepId`; `request.options.prompt` is the rendered text, `request.cwd` the call's working directory (a worktree for an isolated writer), `request.outputSchema` the JSON Schema. A writer's reply may write files under `request.cwd` before it returns. Throw for an unexpected step: the engine records a throw as an agent failure of kind `unknown`, which a settled call or map keeps as data, so every check (the success run, the F1–F4 runs, each mode) fails when a reply threw. Inject a failure on purpose with `fail`, not by throwing.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `check({ result, env, calls, record, suspended, questions })` | yes      | Assert the success run: `result` is the completed run, `calls` the harness requests, `record` the saved run, `suspended` how many times it suspended, `questions` the `{ question, value }` pairs answered, in order. `calls` are in admission order, which need not be item order inside a concurrent map, even at agent limit 1; sort them with `ordered`. Check the output contract and the filesystem the workflow should leave.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `setup(env, mode)`                                            | no       | Add files to the fixture repository before the run (use `writeFiles` and `commitAll`); it may add fields to `env`, which the kill worker receives too. `mode` is the mode about to run, `'normal'` for the success run, the fault matrix and the kill case; a mode's own `setup` runs after it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `answer(question, env, mode)`                                 | no       | The inbox answer of a durable question, or `undefined` for the default: `{ approved: true }` for a step whose leaf is `approve-<name>`, else `{ decision: 'continue', answer: '' }`. `env` is the run's fixture and `mode` its mode, `'normal'` outside modes, so a mode can decline, or change the repository while the question waits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `fail(request, mode)`                                         | no       | Return true to fail this call as a nonzero process exit. It is asked for every call of every run that F1 or F2 does not fault, so key it on `mode` unless the success run should fail the call too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `faults`                                                      | no       | The F1 and F2 targets: `{ F1?, F2? }`, each a regular expression source matched against step IDs like `kill.step`. F1 fails the first call whose step matches, F2 the first matching schema call; the cell records the step as `faultedStep`, and a pattern that matches no call fails the check. Without it F1 takes the first call and F2 the first schema call, which a concurrent map admits in no fixed order even at agent limit 1. A port whose first agent stage is a concurrent or settled fan-out should name a step, preferably one whose failure fails the run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `kill`                                                        | no       | The F3 kill point of a port that writes: `{ step, boundary, writeLocation, pristine? }`. `step` is a regular expression source matched against step IDs; `boundary` is `'response'` (killed after the matching agent's reply wrote its files, before its response is recorded) or `'checkpoint'` (killed after the matching step completed, before its checkpoint is appended); `writeLocation` is `'isolated-checkout'` or `'source-checkout'`; `pristine: false` when the run legitimately leaves `target.mjs` changed. When the items of a concurrent map call agents, `step` must match every item (`\d+`, not `0`): naming one item lets the kill land before a sibling's completion is checkpointed, so that sibling's agent call is paid again on some runs and `callsPaidAgain` varies between verifications. A map whose items run only code and commands may name one item (acceptance-qa-batch kills at `criteria/QA-1/0/probe`), because `callsPaidAgain` counts agent calls and a re-run command is not one. Omit `kill` for a read-only port. |
| `faultCheck`                                                  | no       | `true` fails the check when the F3 or F4 resumed output differs from the success run's. Without it the cells only record the comparison as `outputMatchesSuccess`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `degraded(output)`                                            | no       | True when the output admits a degradation that the fault matrix does not already count from its own status list (`degraded`, `call-limit`, `needs-review`, `verification-failed`, `baseline-failed`, `gaps-remain`): a failed tolerant member, an unchecked candidate, or a status of the package's own vocabulary such as `'limited'`. The matrix records either as `outputAdmitsDegradation`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `readOnly`                                                    | no       | The F3 "not applicable" reason for a read-only port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `modes`                                                       | no       | Extra contracts, each a fresh run; see [Modes](#modes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

`setup`, `input`, `reply`, `check` and a mode's `setup`, `input`, `check`, `repair.run` and
`resumeCheck` may be async; the checks await them. `answer`, `fail`, `degraded` and a mode's
`options` must return their value synchronously.

## Modes

`modes` is a list of
`{ mode, setup?, input?, options?, rejects?, repair?, resumeCheck?, allowReplyErrors?, check }`
(`check` is optional only for a rejects mode). Each runs fresh under `harnessFor(..., { mode })`, so
`reply`, `fail` and `answer` see `mode`, and the run ID is `mode-<mode>`:

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
  from the failed run; a further resume must pay nothing, and the row records `resumedStatus` and
  `resumedCalls`. A run refused before it saved a record has nothing to resume, so its mode fails.
- `allowReplyErrors: true` lets a mode's replies throw.

## Faults

F1 fails the first agent call (or the first call `faults.F1` names) as a process exit. F2 returns a
schema-invalid reply to the first schema call (or the first call `faults.F2` names) and to every
in-run retry of that step, so a schema retry policy cannot absorb it; the resume gets valid replies.
Both must resume to completion without paying for a completed call again. F3 kills the run at `kill`
and resumes it. F4 wraps the workflow so that its first run throws, then accepts a one-statement
code fix on resume. F5 counts how many times the success run suspended on durable questions.

F3 and F4 end where the success run does, so their cells record `outputMatchesSuccess`: whether the
resumed output equals the success output once what differs between any two runs is replaced (each
run's checkout, scratch root and run ID, every UUID, and every number under a key ending in `Ms`). A
Git object ID of the fixture repository as setup made it (reachable from `env.since`, `env.until` or
another commit `setup` stored in `env`, such as `env.base`) is compared as it is, since fixture
commits have fixed dates; any other object ID, such as a commit dated at run time, is compared only
by where it recurs. So a resumed output that names the wrong fixture commit differs. A kill at a
write checkpoint, for example, resumes to a receipt whose `previousSha256` is the file's own digest,
which the cell shows as `false`.

## Checking one package

`check-packaged-port.mjs` runs what `verify-packaged-ports.mjs` runs, for one package and without
writing a report: hygiene and CLI validation, the success run with its completed replay, the F1–F5
matrix and every mode.

```sh
node --import tsx comparisons/scripts/check-packaged-port.mjs <name> [--no-faults] [--no-success] \
  [--mode <mode>]... [--root <dir>] [--mutant <file>]
```

Validation always runs. `--no-faults` skips the matrix; `--no-success` skips the success run and,
with it, the matrix. `--mode <mode>`, which may repeat, runs only the modes it names, and a name the
module does not declare fails before any run.

Each fault prints one line: its initial and final status, then `repaid` (`callsPaidAgain`),
`degraded` (`outputAdmitsDegradation`, left out of a not-applicable cell), `faulted` (the
`faultedStep` of a fixture module's F1 and F2), `matches success` (`outputMatchesSuccess` of a
fixture module's F3 and F4) and a not-applicable cell's reason.

A check that fails prints its error, which names the check and the first line of what failed, then
summarizes the saved run: its status and error, and each failed step with its error kind and the
first line of its message. The settled failures follow under their own heading, because the run went
on past them and some are expected (a settled read of a file that should not exist yet): each
settled-failed step, and each failed item of a settled map with its index and the step it failed at.
A completed run whose check failed has no failed step, so its error is the assertion's. For a
node:assert message whose first line names no value (`Expected values to be strictly equal:`), the
line goes on with the values that follow it, or with a diff's first actual (`+`) and expected (`-`)
lines. The original error follows as the `cause`. The success check and every mode throw this error,
in `verify-packaged-ports.mjs` too.

### Another root, and mutants

`--root <dir>` checks the package directory `<dir>`, which holds `workflows/<name>.ts`, instead of
`ported/<name>.quiet-choir`, against the same fixture module. The script copies it into a temporary
directory beside copies of the other packages, so a composite still finds its children. The
directory also gets a `package.json` of `{"type":"module"}` and a `node_modules/quiet-choir` link to
this checkout: without them the copy's `.ts` modules neither load as ES modules nor resolve
`quiet-choir`. The script then sets `QUIET_CHOIR_LAB_PACKAGE_DIR` to the directory. `packageRoot`
reads the variable on every call, and the kill worker and the CLI inherit it, so every process of
the check loads the copy. A directory you name in the variable yourself must be an absolute path and
hold the same `package.json` and link. `verify-packaged-ports.mjs` refuses to run while the variable
is set, because its reports describe `ported/`.

`--mutant <file>` changes that copy, of `<dir>` or of the committed package, and never the
repository. The file is a JSON list of `{ "file"?, "old", "new" }` replacements, applied in order.
`file` is relative to the package root; without it, `old` is looked for in every file of the
package. `old` must occur exactly once where it is looked for, so a mutant that no longer applies
fails instead of passing unchanged.

To ask whether a plausibly broken port would still pass, write one mutant file per defect and check
each. Every mutant should fail at least one check; one that passes names a contract the fixture
module does not assert yet. Keep mutants type-correct: the CLI validation type-checks the package,
so a mutant that does not compile fails there and says nothing about the fixture's contracts.
`--no-success` and `--mode` narrow a run to the contracts meant to catch a mutant.
