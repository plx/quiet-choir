# Setup and CLI

## Locate the runtime

quiet-choir is a private, unpublished package. Use an existing checkout of
`https://github.com/plx/quiet-choir`, or clone it into the user's chosen location. Do not assume
`npm install quiet-choir` or `npx quiet-choir` can fetch it from a registry. A consumer that
installed a local checkout or tarball can use its `quiet-choir` executable and import from
`quiet-choir`.

Use Node.js 24.x (recommended), 22.x from 22.13, or 26.x, with npm 10.9+. Node 23.x and 25.x are
unsupported. From a fresh checkout:

```sh
npm ci
npm run build
qc_state_dir="$(mktemp -d)"
npm run cli -- workflow execute examples/local.workflow.ts --run-id first --state-dir "$qc_state_dir"
npm run --silent cli -- workflow inspect first --state-dir "$qc_state_dir" --json
```

Keep `qc_state_dir` for inspection and resume in this shell. The local example needs no harness
account. Agent effects need separately installed and authenticated `claude` and/or `codex` binaries;
`CliHarness` uses PATH and inherits their authentication, with no additional provider API key.

The CLI's launch directory becomes the recorded run `cwd`. It is the base for relative FILE and
`--state-dir` paths and each agent call's relative `cwd`. Execution with a file must match that
working directory on resume; resume by ID uses the stored launch directory. There is no `--cwd`
flag. `npm run cli --` runs from the quiet-choir checkout even when invoked in one of its
subdirectories, so use these npm examples for the bundled workflows. For another project, change to
that project and invoke the checkout's launcher by absolute path (replace both paths and provide
that project's `workflow.ts`):

```sh
cd /path/to/target-project
node /absolute/path/to/quiet-choir/bin/run.js workflow execute workflow.ts --run-id project-run
```

Where the package is already installed, `npx --no-install quiet-choir workflow …` also preserves the
project directory. `npm run cli` runs `dist/`, so rebuild after changing `src/`. `cli:dev` also
loads `dist/commands`: this checkout's tsconfig has no `rootDir`/`outDir` mapping for oclif's
development command discovery.

## Run against another project

Choose an import mode before writing the workflow:

| Mode                    | Import and launch                                                                                                                                         | Effect on the target                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| No install              | Import `{ defineWorkflow, z }` from `/absolute/path/to/quiet-choir/dist/index.js`; launch `node /absolute/path/to/quiet-choir/bin/run.js` from the target | No dependency or manifest changes                                                        |
| Local linked dependency | From the target, run `npm install /absolute/path/to/quiet-choir`; import `{ defineWorkflow, z }` from `quiet-choir`; use `npx --no-install quiet-choir`   | Changes target `package.json` and lockfile; use when those dependency edits are intended |

Build the checkout first (`npm ci && npm run build` there). Import `z` from the same runtime as
`defineWorkflow`; a separate `import ... from 'zod'` fails if the target does not depend on Zod. The
[first workflow](../SKILL.md#run-a-first-workflow-against-a-project) is a complete no-install
example. Put the workflow outside the worktree when it should leave no source changes.

Control the nearest `tsconfig.json` and package module type. A workflow inside either project
inherits that project's compiler options. With NodeNext, `.ts` without a nearby `"type": "module"`
is CommonJS; use `.mts` for an independent ESM workflow, especially for embedding scripts with
top-level await. An adjacent minimal `tsconfig.json` can isolate a workflow from unrelated project
compiler settings. Inspect the effective settings with `workflow typecheck`.

CLI fingerprints cover compiler-reached source files and the selected tsconfig, using real paths and
canonical project-relative names. They exclude `node_modules` and quiet-choir's own `src/` and
`dist/` (unless one is itself the entrypoint). Rebuilding the runtime's `dist/*.d.ts` therefore does
not by itself change a workflow's source fingerprint. Other imported helpers outside `node_modules`
are included; even comments change their hashes. Keep the runtime version fixed while recovering a
run: source hashing does not prove unchanged dependency behavior, and engine compatibility is a
separate gate. Use [code recovery](durability.md#choose-a-recovery-path) for intentional workflow
edits.

Storage resolves explicit `--state-dir`, then `QUIET_CHOIR_STATE_DIR`, then an existing run's legacy
`<launch-directory>/.quiet-choir/runs` location, then
`${XDG_STATE_HOME:-~/.local/state}/quiet-choir/<project>-<hash>/runs`. The project hash uses
canonical `realpath(cwd)`. The CLI prints the absolute state directory and includes it in
execute/resume JSON; retain it when operating from another project. `workflow list --all` discovers
registered default projects without importing code. New state containers self-ignore with
`.gitignore` containing `*`. Checkpoints contain plaintext inputs, prompts/previews, outputs,
errors, and answers; keep them private. See
[storage and ownership](durability.md#storage-ownership-and-cancellation).

## Choose the command

| Command after `npm run cli --`           | Behavior                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `workflow typecheck FILE`                | Compiler analysis only; does not import the workflow                                                      |
| `workflow validate FILE`                 | Typechecks, lints (QC findings exit 4), imports, checks the export and I/O schema conversion; skips `run` |
| `workflow execute FILE`                  | Typechecks, warns about durability lint findings, imports, and executes or resumes                        |
| `workflow start FILE`                    | Launches execute detached; returns once the run record exists                                             |
| `workflow check-resume FILE --run-id ID` | Typechecks/imports and compares run gates without a writer lock or workflow-body execution                |
| `workflow fixtures RUN_ID`               | Export agent outputs and settled agent failures as reusable fixture JSON without importing source         |
| `workflow list`                          | Lists run summaries with status filters without importing source                                          |
| `workflow inspect RUN_ID`                | Reads the saved run without importing workflow code or acquiring a writer lock                            |
| `workflow unlock RUN_ID`                 | Clears an abandoned lock without importing workflow code; refuses live owners and children                |
| `workflow rm RUN_ID`                     | Removes a saved run and its caches without importing source; `--dry-run` previews, `--force` for active   |
| `workflow prune`                         | Removes finished runs by `--older-than`, `--status` or `--missing-cwd` through rm; never forces           |
| `workflow cancel RUN_ID`                 | Ends a live local run as `cancelled`; signals only an identity-verified owner on this host, else exit 3   |

Entrypoints must be TypeScript source (`.ts`, `.tsx`, `.mts`, `.cts`), not declaration files. The
nearest `tsconfig.json` in or above the workflow directory applies and is fingerprinted. Under the
checkout this is the repo's strict config: an unused variable can block execution. Without a config,
built-in defaults enable `strict`, `noUncheckedIndexedAccess`, `forceConsistentCasingInFileNames`,
`allowImportingTsExtensions`, `resolveJsonModule`, `skipLibCheck`, and `noEmit`, with
`noCheck: false`, NodeNext module/resolution, preserved JSX, ES2023 target/lib, and bundled Node
types. They do not turn on `exactOptionalPropertyTypes`. `workflow typecheck` prints the effective
compiler flags; JSON contains `compilerOptions` (under `error.details` on failure). Stricter
defaults can block an unchanged in-flight resume before its body runs; fix the source and use
explicit code-change recovery. A project's own options still apply when a tsconfig exists.
`validate`, `check-resume`, and `execute` run module top-level code on import, even for completed
resumes. `validate` cannot check step schemas/options constructed inside `run`. After a clean type
check it runs the [durability lint](patterns.md#durability-lint) (QC001–QC005) before importing: any
finding fails with exit 4 (`load.typecheck`) and prints `path:line:col - error QCnnn: message`. A
`// quiet-choir-ignore QCnnn <reason>` line directly before the reported line silences that rule
there. `execute`, `start`, `resume`, `tick` and `check-resume` print the findings as `warning QCnnn`
log lines and run; `list-defs` lists such definitions and warns.

From the checkout, using a fresh absolute state directory:

```sh
npm run --silent cli -- workflow validate examples/duet.workflow.ts --json
qc_duet_state_dir="$(mktemp -d)"
npm run cli -- workflow execute examples/duet.workflow.ts \
  --run-id duet --state-dir "$qc_duet_state_dir" \
  --input '{"topic":"durable agent workflows"}' --log-level debug
```

This execute command makes real harness calls and needs authentication. Rehearse first by adding
`--dry-run --json`; inspect its reached calls, limits, and warnings before paying.
`--harness fixture:./fixtures.json` selects saved responses, and `--dry-run --resume --run-id ID`
previews the rest of a real run on temporary state. Local callbacks run unless matched by
`--stub-steps`. Changing the harness kind for actual resume/fork requires `--allow-harness-change`;
resuming or ticking under a different `--harness-config` (omitted means the defaults) requires
`--allow-harness-config-change`. See [rehearsal](rehearsal.md) for the complete loop and JSON report
contract.

`workflow pending --json` and `workflow answer RUN STEP --json VALUE` read stored question contracts
without importing workflow code. `pending` hides answered rows and rows of ended runs unless given
`--all`, and a refused answer exits 2 with `error.details.issues`. `workflow resume RUN --json`
loads its saved entrypoint and compiler configuration. See the
[suspension operating loop](operating-runs.md#answer-a-suspended-run).

## Run identity and output

- `--run-id ID` selects the run. New runs otherwise generate a UUID, printed to stderr and included
  in JSON success/failure output. IDs are validated before typecheck or import. IDs allow 1–128
  letters, numbers, underscores, or hyphens and must start with a letter or number.
- `--input JSON`, `--input @path/to/input.json`, or `--input -` supplies inline, file, or stdin
  input. JSON errors name the source and zero-based character position. New CLI runs default to
  `{}`; omit it on resume to reuse the saved input. Forks also inherit source input by default;
  explicit fork input may differ. Resume still requires equal validated input.
- Resume with `execute --resume --run-id ID` or `resume ID`; both can load stored launch paths. Use
  the printed `--state-dir` from another project. A supplied different FILE is refused before
  import. Old/embedded runs without launch metadata still need FILE or their embedding application.
  Source, name, version, schema, and step identity checks remain. Reusing an ID without resume
  fails.
- `--kill-grace-ms N` sets the TERM-to-KILL grace for calls and orphan recovery (default 3000).
  Repeat it on resume; it is not sticky. `--resume --kill-orphans` stops identity-confirmed children
  of a dead/released owner before replacement effects. Unverified identities refuse recovery.
- `--state-dir PATH` selects a runs container, resolving relative paths against the launch cwd.
  Without it, environment, legacy-run, and external project defaults apply as described above.
- `--json` on execute/inspect/validate/typecheck/check-resume writes exactly one JSON line to
  stdout, including failures and argument errors. Execute, resume and `answer --resume` return a
  compact
  `{kind:"workflow.run.result",ok:true,exitCode:0,runId,stateDir,status,output,usage,counts,rootCause,warnings}`
  (`usage` is `{costUsd,attempts,undercounted}`); add `--full` for the whole run record plus
  `stateDir`. A suspension (exit 75) has `pending` (with each `answerCommand`), `resumeCommand` and
  a `summary` of the same shape, or `run` under `--full`. Inspect adds current `ownership`; validate
  returns `{kind, ok, entrypoint, diagnostics: [], workflow}`; typecheck returns its compiler
  result. A failure's `diagnostics` holds compiler entries (`code`, `filePath`) or, from a validate
  that the lint failed, `{rule, category, file, line, column, message}` entries; never both.
  Failures use
  `{kind:"workflow.error",ok:false,exitCode,error:{code,message,stepId,details}, runId,stateDir,status,failedSteps,diagnostics,next,summary}`
  for execute, resume and answer, and `run` (the actual saved record or null) for other commands,
  `--dry-run`, or `--full`. `error.stepId` identifies the root effect; body failures and interrupts
  use null. Generated IDs are included, so no follow-up inspect is needed to recover the ID or the
  failed result. `next` lists runnable `{why, argv}` follow-ups; emitted argv start with the
  launcher of the invocation (`node` plus absolute `bin/run.js` here).
- Use `npm run --silent cli -- … --json` to suppress npm's banner when piping. Workflow console and
  `process.stdout.write` output during import/execution is redirected to stderr along with logs.
- Validate's `workflow.fingerprint` is the same full source/schema/engine fingerprint stored by
  execution. Per-file hashes use real, project-relative paths and exclude engine implementation
  files.
- `--log-level debug` includes timestamped run/step/admission events on stderr. Phase/log
  observations echo at info level, marked `(replay)` when already recorded. `-v` also prints saved
  failure stacks. Levels range from `trace` to `silent`; `-v`/`--verbose` is an alternative and
  cannot be combined with `--log-level`.

Put flags after the command name, for example `workflow inspect first --json`.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success. Non-watching inspect accepts any readable status; check `.status`. After a first signal, only a saved execute/resume completion or a delivered `workflow answer` exits 0.                                                                                                                                                                                                                                      |
| 1    | `workflow.failed`: execution failed and the failure checkpoint was saved. Fix and resume. A saved `failed` run reports this even when a signal arrived.                                                                                                                                                                                                                                                                 |
| 2    | `answer.invalid` for invalid answers, or `usage.*`: invalid flags, misplaced flags, omitted/nonexistent/unsupported FILE, invalid run ID, invalid input JSON/file/schema, or resume without an ID. No execution checkpoint is written.                                                                                                                                                                                  |
| 3    | `answer.conflict` for duplicate/closed questions, or `run.*`: existing/missing/locked/unreadable run, incompatible resume, changed input, surviving/unverified child processes (`run.orphans`), a `workflow cancel` that found no live owner (`run.unowned`), or a `workflow rm` without `--force` of a running, suspended or waiting run (`run.active`). No workflow body runs.                                        |
| 4    | `load.*`: typecheck, import, or workflow-definition failure. No execution checkpoint is written.                                                                                                                                                                                                                                                                                                                        |
| 66   | `watch.record_not_created`: `inspect --watch --wait-created` saw no record within the bound; check the run ID, `--state-dir` and whether the launch failed.                                                                                                                                                                                                                                                             |
| 70   | `start.exited`: the `workflow start` runner exited without a record or a readable result document; read its `launch.log`.                                                                                                                                                                                                                                                                                               |
| 74   | `workflow.storage`: saving, process registration, or releasing ownership failed. Inspect the reported saved state; it can still be `running`, `completed`, or absent.                                                                                                                                                                                                                                                   |
| 75   | Saved suspension with pending waits; answer questions, deliver signals, or tick when due. A saved suspension stands even when a signal arrived.                                                                                                                                                                                                                                                                         |
| 79   | `watch.timeout`: `inspect --watch --timeout`, `events --follow --timeout` or `cancel --timeout` stopped waiting while the run had not ended (`status` is the last observed one); the run continues, so wait again; a repeated `cancel` is the owner's second SIGINT and force-kills it.                                                                                                                                 |
| 130  | `workflow.interrupted`: SIGINT/SIGTERM/SIGHUP. A first signal drains and saves a resumable `suspended` run with `interruptedBy` (tick or resume continues it); if that save fails, the exit is 74 instead. A second signal kills tracked groups immediately and reports the last readable checkpoint, which may still be `running`. An owner stopped by `workflow cancel` saves `cancelled` instead and also exits 130. |
| 124  | `start.timeout`: `workflow start` saw no record owned by its runner within `--start-timeout` (default 60s) and stopped the runner; `runId` is set only if the runner saved a record.                                                                                                                                                                                                                                    |

`configuration doctor --json` runs five checks for each installed harness: tested version range,
exact adapter argv with a zero-inference 404/400 rejection, hidden flags, enum drift and inherited
Codex model/effort/profile. Use `--harness claude|codex|all` (default all), executable overrides
`--claude-binary`/`--codex-binary`, and optional `--codex-home`/`--codex-profile`. Each check has
`status` `pass`, `warn` or `fail`. A version inside the tested range passes; an untested patch of
the same major.minor warns; another major.minor, an unparseable or prerelease version, a nonzero
exit and process warnings fail. The exact-argv probe runs whenever `--version` answered, whatever
the grade. Reports carry `verdict` (`ok`, `usable-with-warnings`, `blocked`) and `warnings`; text
output ends with a verdict line and the next command, and the exit is 1 only when blocked, so a
warning exits 0. `--strict` turns an untested patch version into a failure. Auth/transport failures,
stderr warnings and any measured spend fail. The Claude probe caps spend (`maxBudgetUsd 0.01`,
nonexistent model); the Codex probe (invalid effort) has no cost cap and `zeroInference` is judged
after the call, so an untested CLI that stopped rejecting bad input could run one tiny inference.
Current tested bounds are Claude 2.1.283 and Codex 0.157.1; to widen them, run
`npm run build && npm run test:contract` from a checkout, review the captures, then raise
`testedHarnessVersions`. Codex's argv probe uses private temporary copies of config/auth and an
empty native profile; selected user/profile defaults are inspected separately, without printing
secrets. Project/managed layers can override those defaults. Exported `probeHarnessContracts`
supports CI. `harnesses` in run metadata and inspect records first live-use binary/version; version
drift warns on resume without invalidating completed results, and a run on an untested version
records one `harnessWarnings` entry naming `configuration doctor`. The configuration topic has one
command, `configuration doctor`. See [durability](durability.md) before recovery and
[inspection](inspection.md) for saved status.

## Execution policy flags

Repeat `--policy '{"match":"review","timeoutMs":600000}'` to append ordered, sticky JSON rules.
`--policy-reset` clears saved rules first. New model/effort rules also require
`--allow-model-override`; completed calls never rerun because of an override. Invalid rules fail
with exit 2 before module loading. See
[durability](durability.md#recovering-a-timeout-or-turn-limit) for compatibility and timeout
recovery.

## Worktree flags

`--worktree-keep all|failed|none` and `--worktree-root DIR` on `execute`, `start` and `resume`
replace the root definition's `worktrees.keep` and `worktrees.root`; a relative root resolves
against the launch cwd, and invalid values exit 2. Both are sticky: recorded in the launch policy,
inherited separately by `resume`, `answer --resume` and `tick` without them, and repeated on emitted
resume commands. A run keeps the cache root it first used. `setup` and `captureExclude` are declared
on `defineWorkflow`; see [worktrees](worktrees.md#cache-policy-and-cleanup).

## Code recovery flags

`--fork-from OLD` creates a new run, defaulting to prefix reuse. `--reuse matching` opts into all
matching completed effects; repeat `--invalidate 'reports/**'` to force chosen effects live.
`--fork-state-dir` selects alternate source storage. Fork modifiers require `--fork-from`, which
cannot be combined with `--resume`. `--accept-code-change` requires `--resume` and records accepted
source/schema changes while retaining step checks; when a completed step changed it refuses with
`run.incompatible` before recording anything, and `error.details.next` holds the fork command.
`--strict-replay` stops at the early ordering warning or a healed-failure warning before live work;
`workflow resume RUN --strict-replay` accepts it too. See
[durability](durability.md#choose-a-recovery-path).

`check-resume --json` emits `{kind, ok, check}` for a compatible report (exit 0). Incompatibility
uses `workflow.error` with `error.code:"run.incompatible"` and the comparison in `error.details`
(exit 3). Loading failures use `load.*` (exit 4); reading failures use `run.*` (exit 3). This is a
run-level check, not a preview of future steps. Its `--accept-code-change` flag checks the explicit
acceptance mode without saving that acceptance; `execute --dry-run --resume --accept-code-change`
previews the step checks.

## Agent admission flags

`workflow execute --max-agents 5 --harness-limit codex=1 --harness-limit claude=3` caps live agent
calls across the entire run, including nested maps. Values must be positive safe decimal integers;
repeat provider rules and the last value wins. Omitted total uses min(8, max(1, available CPUs -
2)); unspecified providers share that total. The effective limits are logged at info level before
workflow loading. Repeat desired limits on resume; they are not sticky and do not change
completed-step identity. `--log-level debug` includes admission counts and wait time. `ctx.map`
still bounds local mapper concurrency independently.

Doctor probes also drain on first SIGINT/SIGTERM/SIGHUP and force-kill on a second signal. They have
in-memory process ownership only, since there is no workflow run to resume.

For read-only monitoring, `workflow inspect ID` shows a dashboard, `--json --summary` gives its
compact data, and `--watch --interval 2s` waits for a terminal/stale state. Watch JSON is JSONL per
change, with final exits completed 0, failed 1, suspended 75, cancelled 130, stale 3. `--timeout 9m`
stops a watch whose run is still running that long after the first read (exit 79, `watch.timeout`;
the run keeps running), `--wait-created 30s` retries a record that does not exist yet (exit 66,
`watch.record_not_created`, when it never appears), and `--final` prints only the last snapshot or
error document. `workflow list --status stale --json` finds abandoned runs without importing source.
See [inspection](inspection.md) for status filters, unknown owners, warnings, partial usage, and
retention.

Use [workflow tick](waits.md) for due stored entrypoints and bounded watching; --wait-mode block on
execute/resume keeps waits live.

## Discover trusted definitions

`workflow list-defs [DIR…] --json` publishes schemas, descriptions and declared child trees without
calling bodies. It imports trusted modules on cache misses; `--refresh` forces revalidation.
`workflow execute NAME --registry-dir DIR` resolves a unique name and then uses normal execution.
Directory defaults to the current directory; duplicate names fail. See
[child workflows and discovery](child-workflows.md).
