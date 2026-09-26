# Setup and CLI

## Locate the runtime

The skill bundle contains documentation only. quiet-choir is currently a private, unpublished
package. Use an existing checkout of `https://github.com/plx/quiet-choir`, or clone it into the
user's chosen development location if needed. Do not assume `npm install quiet-choir` or
`npx quiet-choir` can fetch this prototype from a registry.

In the checkout, use Node.js 24 LTS (also supported: 22.13+ and 26) and npm 10.9+:

```sh
npm ci
npm run build
npm run cli -- workflow execute examples/local.workflow.ts --run-id first
npm run cli -- workflow inspect first --json
```

The local example needs no harness account. For agent effects, install and authenticate `claude`
and/or `codex` separately. `CliHarness` invokes those executables from PATH and inherits their
authentication; quiet-choir requires no additional provider API key.

The commands below run from the checkout root. `npm run cli --` uses the built CLI;
`npm run cli:dev --` runs the source CLI. When a consumer has installed this package from a local
checkout or tarball, its executable is `quiet-choir` and its imports use `quiet-choir`.

## Choose the command

| Command after `npm run cli --` | Behavior                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `workflow typecheck FILE`      | Compiler analysis only; does not import the workflow                                                      |
| `workflow validate FILE`       | Typechecks and imports, checks the default export and input/output schema conversion; does not call `run` |
| `workflow execute FILE`        | Typechecks, imports, and executes or resumes                                                              |
| `workflow inspect RUN_ID`      | Reads the saved run without importing workflow code or acquiring a writer lock                            |

Entrypoints must be TypeScript source (`.ts`, `.tsx`, `.mts`, `.cts`), not declaration files.
Typechecking uses the nearest tsconfig or strict Node defaults. Both `validate` and `execute` run
module top-level code on import. Keep top-level code free of effects even for completed resumes.
`validate` cannot check step-specific schemas/options that are constructed only inside `run`.

```sh
npm run cli -- workflow validate examples/duet.workflow.ts --json
npm run cli -- workflow execute examples/duet.workflow.ts \
  --run-id duet --input '{"topic":"durable agent workflows"}' --log-level debug
```

The second command makes real harness calls. The local example is preferable for testing setup.

## Run identity and output

- `--run-id ID` selects the run; a new execution otherwise generates a UUID and prints it to stderr.
  IDs allow 1–128 letters, numbers, underscores, or hyphens and must start with a letter or number.
- `--input JSON` supplies input inline. New CLI runs default to `{}`. A resume with no `--input`
  uses the saved input; it must not be replaced with different input.
- `--resume --run-id ID` requires an existing run. Reusing an ID without `--resume` fails.
- `--state-dir PATH` on execute/inspect selects storage (default `.quiet-choir/runs`, relative to
  the shell working directory). Use the same directory for inspection and resume.
- `--json` is supported by validate, execute, and inspect, but not typecheck. For successful
  execute/inspect it is the run record. Use `npm run --silent cli -- ... --json` to suppress npm's
  script banner when piping; workflow code must also keep stdout clean. Failures can still emit
  diagnostics on stderr.
- `--log-level debug` includes step events on stderr. Log levels range from `trace` to `silent`;
  `-v`/`--verbose` is an alternative and cannot be combined with `--log-level`.

Put flags after the command name. Execution errors return exit 1; malformed CLI use can return 2,
and interrupted execution returns 130. `configuration get/set/doctor` are stubs (exit 2), not a
configuration system. See [durability](durability.md) before recovery and
[inspection](inspection.md) for machine-readable status.
