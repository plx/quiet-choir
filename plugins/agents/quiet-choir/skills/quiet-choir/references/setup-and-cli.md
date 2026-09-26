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

| Command after `npm run cli --` | Behavior                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `workflow typecheck FILE`      | Compiler analysis only; does not import the workflow                                                      |
| `workflow validate FILE`       | Typechecks and imports, checks the default export and input/output schema conversion; does not call `run` |
| `workflow execute FILE`        | Typechecks, imports, and executes or resumes                                                              |
| `workflow inspect RUN_ID`      | Reads the saved run without importing workflow code or acquiring a writer lock                            |

Entrypoints must be TypeScript source (`.ts`, `.tsx`, `.mts`, `.cts`), not declaration files. The
nearest `tsconfig.json` in or above the workflow directory applies and is fingerprinted. Under the
checkout this is the repo's strict config: an unused variable can block execution. Without a config,
strict Node defaults apply. Both `validate` and `execute` run module top-level code on import, even
for completed resumes. `validate` cannot check step schemas/options constructed inside `run`.

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
  saved input. Changed input is refused.
- Resume with `--resume --run-id ID`, the same launch directory and `--state-dir`, and unchanged
  sources, name, version, and schemas. Reusing an ID without `--resume` fails.
- `--state-dir PATH` on execute/inspect selects storage. Its default is `.quiet-choir/runs` under
  the CLI launch directory. Use an absolute path and repeat it for inspection/resume.
- `--json` writes one JSON line to stdout only on success: the run record for execute/inspect, or
  `{kind, ok, entrypoint, workflow}` for validate. It is unsupported by typecheck. Failed
  `execute --json` emits no result JSON; read stderr, then inspect the run if a checkpoint exists.
- Use `npm run --silent cli -- … --json` to suppress npm's banner when piping. Module-level
  `console.log` output precedes the JSON; workflow code must keep stdout clean too.
- Validate's `workflow.fingerprint` is a source hash. Execution hashes that value together with
  schemas, so it is a different fingerprint from the saved run's `workflow.fingerprint`.
- `--log-level debug` includes step events on stderr. Levels range from `trace` to `silent`;
  `-v`/`--verbose` is an alternative and cannot be combined with `--log-level`.

Put flags after the command name, for example `workflow inspect first --json`.

| Exit | Meaning                                                                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success. `inspect` also exits 0 for `failed` and `running` records: check `.status`. Misplaced flags between `workflow` and its command can print help and exit 0.                                                                                          |
| 1    | Type errors, missing FILE, invalid run ID, existing/missing/locked run, incompatible resume, changed input, or workflow/step failure. Read stderr to distinguish them. An invalid run ID is checked after module import, so top-level code has already run. |
| 2    | Flag parse errors, invalid `--input` JSON, `--resume` without `--run-id`, non-TypeScript or `.d.ts` entrypoints, or configuration stubs.                                                                                                                    |
| 130  | SIGINT/SIGTERM during execution. The runner aborts, drains, and saves `failed` before exiting when storage is available; a storage failure can leave an older record.                                                                                       |

`configuration get/set/doctor` are stubs, not a configuration system. See
[durability](durability.md) before recovery and [inspection](inspection.md) for saved status.

## Execution policy flags

Repeat `--policy '{"match":"review","timeoutMs":600000}'` to append ordered, sticky JSON rules.
`--policy-reset` clears saved rules first. New model/effort rules also require
`--allow-model-override`; completed calls never rerun because of an override. Invalid rules fail
with exit 2 before module loading. See
[durability](durability.md#recovering-a-timeout-or-turn-limit) for compatibility and timeout
recovery.
