# Setup and CLI

## Locate the runtime

The skill bundle contains documentation only. quiet-choir is a private, unpublished package. Use an
existing checkout of `https://github.com/plx/quiet-choir`, or clone it into the user's chosen
location. Do not assume `npm install quiet-choir` or `npx quiet-choir` can fetch it from a registry.
A consumer that installed a local checkout or tarball can use its `quiet-choir` executable and
import from `quiet-choir`.

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
`--state-dir` paths, the default `.quiet-choir/runs`, and each agent call's relative `cwd`. It must
match on resume; there is no `--cwd` flag. `npm run cli --` runs from the quiet-choir checkout even
when invoked in one of its subdirectories, so use these npm examples for the bundled workflows. For
another project, change to that project and invoke the checkout's launcher by absolute path (replace
both paths and provide that project's `workflow.ts`):

```sh
cd /path/to/target-project
node /absolute/path/to/quiet-choir/bin/run.js workflow execute workflow.ts --run-id project-run
```

Where the package is already installed, `npx --no-install quiet-choir workflow …` also preserves the
project directory. `npm run cli` runs `dist/`, so rebuild after changing `src/`. `cli:dev` also
loads `dist/commands`: this checkout's tsconfig has no `rootDir`/`outDir` mapping for oclif's
development command discovery.

## Choose the command

| Command after `npm run cli --`           | Behavior                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `workflow typecheck FILE`                | Compiler analysis only; does not import the workflow                                                      |
| `workflow validate FILE`                 | Typechecks and imports, checks the default export and input/output schema conversion; does not call `run` |
| `workflow execute FILE`                  | Typechecks, imports, and executes or resumes                                                              |
| `workflow check-resume FILE --run-id ID` | Typechecks/imports and compares run gates without a writer lock or workflow-body execution                |
| `workflow inspect RUN_ID`                | Reads the saved run without importing workflow code or acquiring a writer lock                            |

Entrypoints must be TypeScript source (`.ts`, `.tsx`, `.mts`, `.cts`), not declaration files. The
nearest `tsconfig.json` in or above the workflow directory applies and is fingerprinted. Under the
checkout this is the repo's strict config: an unused variable can block execution. Without a config,
strict Node defaults apply. `validate`, `check-resume`, and `execute` run module top-level code on
import, even for completed resumes. `validate` cannot check step schemas/options constructed inside
`run`.

From the checkout, using a fresh absolute state directory:

```sh
npm run --silent cli -- workflow validate examples/duet.workflow.ts --json
qc_duet_state_dir="$(mktemp -d)"
npm run cli -- workflow execute examples/duet.workflow.ts \
  --run-id duet --state-dir "$qc_duet_state_dir" \
  --input '{"topic":"durable agent workflows"}' --log-level debug
```

The execute command makes real harness calls and needs authentication. Use the local example to
check setup without paid calls.

## Run identity and output

- `--run-id ID` selects the run. New runs otherwise generate a UUID, printed only to stderr. Supply
  an ID in scripts. IDs allow 1–128 letters, numbers, underscores, or hyphens and must start with a
  letter or number.
- `--input JSON` supplies inline input. New CLI runs default to `{}`; omit it on resume to reuse the
  saved input. Forks also inherit source input by default; explicit fork input may differ. Resume
  still requires equal validated input.
- Resume with `--resume --run-id ID`, the same launch directory and `--state-dir`, and unchanged
  sources, name, version, and schemas. Reusing an ID without `--resume` fails.
- `--state-dir PATH` on execute/inspect/check-resume selects storage. Its default is
  `.quiet-choir/runs` under the CLI launch directory. Use an absolute path and repeat it for
  inspection/resume.
- `--json` on execute/inspect/validate writes one JSON line to stdout only on success: the run
  record for execute/inspect, or `{kind, ok, entrypoint, workflow}` for validate. It is unsupported
  by typecheck. Failed `execute --json` emits no result JSON; read stderr, then inspect the run if a
  checkpoint exists.
- Use `npm run --silent cli -- … --json` to suppress npm's banner when piping. Module-level
  `console.log` output precedes the JSON; workflow code must keep stdout clean too.
- Validate's `workflow.fingerprint` is the same full source/schema/engine fingerprint stored by
  execution. Per-file hashes use real, project-relative paths and exclude engine implementation
  files.
- `--log-level debug` includes step events on stderr. Levels range from `trace` to `silent`;
  `-v`/`--verbose` is an alternative and cannot be combined with `--log-level`.

Put flags after the command name, for example `workflow inspect first --json`.

| Exit | Meaning                                                                                                                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success. `inspect` also exits 0 for `failed` and `running` records: check `.status`. Misplaced flags between `workflow` and its command can print help and exit 0.                                                                                                   |
| 1    | Type errors, nonexistent FILE path, invalid run ID, existing/missing/locked run, incompatible resume, changed input, or workflow/step failure. Read stderr to distinguish them. An invalid run ID is checked after module import, so top-level code has already run. |
| 2    | Flag parse errors, invalid `--input` JSON, omitted FILE argument, `--resume` without `--run-id`, non-TypeScript or `.d.ts` entrypoints, or configuration stubs.                                                                                                      |
| 130  | SIGINT/SIGTERM during execution. The runner aborts, drains, and saves `cancelled` before exiting when storage is available; a storage failure can leave an older record.                                                                                             |

`configuration doctor --json` runs five checks for each installed harness: tested version range,
exact adapter argv with a zero-inference 404/400 rejection, hidden flags, enum drift and inherited
Codex model/effort/profile. Use `--harness claude|codex|all` (default all), executable overrides
`--claude-binary`/`--codex-binary`, and optional `--codex-home`/`--codex-profile`. Reports are
emitted on both pass (exit 0) and drift (exit 1). Auth/transport failures, stderr warnings and any
measured spend fail. Untested versions skip the exact-argv probe. Current tested bounds are Claude
2.1.283 and Codex 0.157.1. Codex's argv probe uses private temporary copies of config/auth and an
empty native profile; selected user/profile defaults are inspected separately, without printing
secrets. Project/managed layers can override those defaults. Exported `probeHarnessContracts`
supports CI. `harnesses` in run metadata and inspect records first live-use binary/version; version
drift warns on resume without invalidating completed results. Only `configuration get/set` remain
stubs. See [durability](durability.md) before recovery and [inspection](inspection.md) for saved
status.

## Execution policy flags

Repeat `--policy '{"match":"review","timeoutMs":600000}'` to append ordered, sticky JSON rules.
`--policy-reset` clears saved rules first. New model/effort rules also require
`--allow-model-override`; completed calls never rerun because of an override. Invalid rules fail
with exit 2 before module loading. See
[durability](durability.md#recovering-a-timeout-or-turn-limit) for compatibility and timeout
recovery.

## Code recovery flags

`--fork-from OLD` creates a new run, defaulting to prefix reuse. `--reuse matching` opts into all
matching completed effects; repeat `--invalidate 'reports/**'` to force chosen effects live.
`--fork-state-dir` selects alternate source storage. Fork modifiers require `--fork-from`, which
cannot be combined with `--resume`. `--accept-code-change` requires `--resume` and records accepted
source/schema changes while retaining step checks. `--strict-replay` stops at the early ordering
warning before live work. See [durability](durability.md#choose-a-recovery-path).

`check-resume --json` emits `{kind, ok, check}` for a compatibility report, including incompatible
reports (exit 1). A loading/reading error emits `{kind, ok:false, message, diagnostics}`. This is a
run-level check, not a preview of future steps. Its `--accept-code-change` flag checks the explicit
acceptance mode without saving that acceptance.

## Agent admission flags

`workflow execute --max-agents 5 --provider-limit codex=1 --provider-limit claude=3` caps live agent
calls across the entire run, including nested maps. Values must be positive safe decimal integers;
repeat provider rules and the last value wins. Omitted total uses min(8, max(1, available CPUs -
2)); unspecified providers share that total. The effective limits are logged at info level before
workflow loading. Repeat desired limits on resume; they are not sticky and do not change
completed-step identity. `--log-level debug` includes admission counts and wait time. `ctx.map`
still bounds local mapper concurrency independently.
