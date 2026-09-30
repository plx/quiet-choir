# Contributing

## Development workflow

1. Use Node.js 24 (`nvm use`) and install the locked dependency graph with `npm ci`.
2. Make focused changes in `src/` and add behavior-focused tests in `test/`.
3. Document each public export with TypeDoc-compatible comments and re-export it from
   `src/index.ts`.
4. Run `npm run check` (or `just check`) before opening a pull request.

`npm run check` verifies formatting, type-aware lint rules, TypeScript, coverage thresholds, build
output, API documentation, and the packed module/type-resolution contract. `skills:check` validates
the two distributed skill packages and compiles their complete examples; `test:cli` also executes
the documented golden path and embedding recipes with temporary projects and fake harnesses. See
[skill maintenance](docs/plugins.md#packaging-and-maintenance). After the build, `comparisons:check`
also typechecks both Workflow Lab batches, preserves the Batch 01 differential baseline and verifies
the active Batch 02 fault matrix without rewriting reports. A primitive PR must update its matching
Batch 02 port, notes and fault row in the same PR, even if it still compiles; refresh API provenance
when the target API changes. The six ports are release-notes, project-bootstrap, test-gap-filler,
incident-investigation, sdlc-orchestrator and bug-hunt; see
[the batch policy](comparisons/README.md#regression-and-snapshot-policy).

`test:cli` first runs `test/cli-smoke-runner.test.mjs` (the runner's own `node:test` checks) and
then `scripts/run-cli-smokes.mjs`, which runs every `test/*smoke.mjs` against the built CLI, four at
a time by default. A new smoke needs no CI or `package.json` edit; CI runs the same
`npm run test:cli` step. Each smoke gets its own temporary `XDG_STATE_HOME` and none of the caller's
`QUIET_CHOIR_*` variables, and the runner fails if the real state directory
(`${XDG_STATE_HOME:-~/.local/state}/quiet-choir`) gains entries during the run. Pass name filters
and `--concurrency N` after `--` to iterate on a subset (`npm run test:cli -- worktrees`; a smoke's
exact name, such as `cli-smoke`, selects only that smoke); a failing smoke prints the tail of its
output and keeps its state directory. The Vitest suite has a similar guard
(`test/setup/state-guard.ts`). CI runs coverage thresholds on the Node 24 leg only; the Node 22.13
and 26 legs run `npm test`.

Cookbook changes must update `examples/patterns/` and the corresponding named fences in both
physical skill copies. `skills:check` enforces source equality and the 30-line workflow limit;
`test/patterns.test.ts` verifies failure/resume behavior with fake harnesses and temporary Git
worktrees. Keep support modules complete and bundled in the installed references. When a runtime
primitive supersedes a workaround, update its recipe and traps in the same PR.

## TypeScript and package conventions

- The project is ESM-only. Relative imports in TypeScript use `.js` suffixes so emitted files work
  in Node.js without rewriting.
- Keep `src/index.ts` as the intentional public API boundary. Do not export internal implementation
  details accidentally.
- Prefer small, feature-oriented modules. Keep agent-harness and provider integrations outside the
  core workflow model.
- Add or update an architecture decision record under `docs/decisions/` when a choice has durable,
  cross-cutting consequences.

## Dependency pin policy

`test/package.test.ts` enforces these relationships without naming versions, so an allowed bump
needs no test edit. `.github/dependabot.yml` applies the same policy.

- `@types/node` tracks the lowest supported Node.js `major.minor` in `engines.node` (currently
  22.13), so the bundled runtime type-check never offers an API the oldest supported Node.js lacks.
  Dependabot ignores its major and minor updates; patch updates are fine. Raise it together with the
  `engines.node` floor.
- `typescript` is an npm alias to `@typescript/typescript6`, the compiler behind the runtime
  type-check, and `@typescript/native` aliases TypeScript 7 for development. Do not move either
  across a major version without a deliberate change.
- `vitest` and `@vitest/*` move together through the `vitest` Dependabot group, because
  `@vitest/coverage-v8` peers on the exact `vitest` version.
- Other runtime dependencies, such as `@oclif/core`, are pinned to exact versions in `package.json`
  and may be bumped by Dependabot. The test checks that they are exact runtime dependencies, not
  which version they are.

## Pull requests

Keep pull requests reviewable and explain observable behavior changes. CI must pass on every
supported Node.js line. Update hand-written guides and API comments in the same change as the
behavior they describe.

## Test timeouts and storage sync

Unit tests run with runtime fsyncs turned off. Every in-process flush goes through `syncHandle` and
`syncDirectory` in `src/workflow/runtime/storage-io.ts`, and `test/setup/storage-sync.ts` (a Vitest
`setupFiles` entry) switches them off before each test. The switch is an internal module-level
setting. There is no environment variable, CLI flag or `RunOptions` field for it, the public entry
points do not export it, and the package `exports` map blocks deep imports, so the CLI and published
consumers cannot reach it. `test/storage-sync.test.ts` proves the production path still syncs the
journal, snapshot, lock, inbox, file and transcript writes, that a full workflow makes no
`FileHandle.sync` calls under the test default, and that no direct `.sync()` call exists in `src/`
outside `storage-io.ts` and the spawned `guard-program.ts` helper. New storage code must call the
helpers, not `handle.sync()`.

A test that injects faults through `FileHandle.sync`, or otherwise needs the flush to happen, opts
back in: call `enableRealStorageSync()` inside the test body, or `useRealStorageSync()` at the top
of a file or `describe` block (both from `test/setup/durable-sync.ts`). Crash, SIGKILL, benchmark
and CLI smoke tests run in child processes, which never load the setup file, so they keep real fsync
without any opt-in. A killed process cannot lose page-cache data anyway, so those tests never
depended on the flush; the kill-based recovery cases still prove replay.

Profile (macOS 27.0 on APFS, Node 26.8.1, Vitest 4.1.10, 56 test files in parallel; "before" is
`e68aba0` with 55 files). Alone means the single test in a fresh run; full means a whole-suite run.
The change was also run locally on Node 22.13.0 and 24.20.0 with coverage (all 1,047 tests passed;
92-157 s wall on a machine shared with other builds).

| Measurement                                  | Before, alone | Before, full run (no coverage / coverage) | After, alone | After, full coverage run (worst of 3) |
| -------------------------------------------- | ------------- | ----------------------------------------- | ------------ | ------------------------------------- |
| 144-leaf nested map (`[6, 8, 3]` at 2)       | 0.64 s        | 3.4 s / 3.7 s                             | 0.52 s       | 1.05 s                                |
| 200 nonterminal wait observations            | 1.39 s        | 7.8 s / 6.2 s                             | 0.07 s       | 0.38 s                                |
| children, no quadratic serialized collection | 0.90 s        | 5.0 s / 4.0 s                             | 0.09 s       | 0.25 s                                |
| journal 500 × 5 KiB at concurrency 8         | 0.85 s        | 4.1 s / 4.7 s                             | 0.47 s       | 1.53 s                                |
| Whole suite, wall clock                      |               | 91.6 s / 87.3 s                           |              | 26.4 s (no coverage), 70.8-75.6 s     |
| Whole suite, summed file durations           |               | 937 s / 881 s                             |              | 196 s (no coverage), 299-341 s        |

An A/B on the old code (stubbing `FileHandle.sync` and `datasync` in a temporary setup file) split
the cost: 25.2 s wall and 182 s summed without coverage, 69.5 s and 294 s with coverage, all with
unchanged CPU. So fsync was about 81% of summed test time without coverage and 67% with it. Alone, a
single test barely notices, because an uncontended APFS flush is cheap; the cost appears when 50
files flush concurrently, which is why the raised timeouts only showed up in full runs. Coverage
wall time is now dominated by TypeScript compiles in the loader, registry and typecheck suites. The
same profile shows `journal.ts` persisting whole `MapRecord`s per settled item (quadratic journal
bytes); that is tracked separately and does not affect the timeouts.

Linux CI runners behave differently. On `e68aba0`'s CI run (ext4, about two Vitest workers), the
fsync-heavy tests were already fast even with real syncs (144-leaf 1.5 s, 500 × 5 KiB 1.9 s), while
the compile-dominated tests were slowest on the Node 22.13 leg: the heaviest replay-loader case took
57.7 s, the registry doctor case 50.0 s, registry cache invalidation 30.6 s, tick 19.5 s, typecheck
15.1 s and the loader 10.0 s. Those suites keep a raised value of about 2x their slowest CI time.

Timeout rule: a test or suite timeout above Vitest's 5 s default needs an adjacent comment of the
form `// measured: 1.2 s alone, 4.1 s in the full coverage run (dominated by tsImport compile)`.
Measure in a full parallel `npm run test:coverage` run and check the per-test durations in the CI
log, where the Node 22.13 leg is usually slowest. Remove the raise when the test fits the default
with at least 3x headroom, and otherwise set the value to about 3x the local full-run time and at
least 2x the slowest CI leg. A timeout that flakes on a CI leg gets a new measured value and
comment, not the old number. Subprocess, `tsImport`, typecheck and Git suites usually keep a raised
value because compiles and process startup, not fsync, dominate them.

## Harness protocol captures

`test/fixtures/harness/` contains sanitized stdout/stderr and process exit codes captured with
Claude Code 2.1.283 and codex-cli 0.157.1. The tests replay those bytes through fake executables; no
credentials, network, or paid inference are needed. Exit 1 is the normal protocol-error path.

To refresh captures, use an isolated CLI configuration and a local fake API: set
`ANTHROPIC_BASE_URL` and `CLAUDE_CONFIG_DIR` for Claude, or a custom Responses API provider in an
isolated `CODEX_HOME` for Codex. Fake responses can exercise authentication errors, tool loops that
reach turn/budget limits, invalid structured output, rate limits, and dropped SSE connections.
Unknown Claude models and invalid Codex effort values can also be captured as zero-inference
validation probes. Explicitly capture stdout, stderr, exit code, and CLI version separately; do not
assume stderr carries the error. Replace session/UUID/tool IDs and local paths before checking in
captures, and review all bytes for credentials or private prompt content. Reported fake-API costs
are CLI calculations over fixture token counts, not actual spending.

The opt-in zero-cost native-envelope job is `npm run test:contract` after `npm run build`. It
launches installed CLIs with fake keys, isolated configuration and local fake Messages/Responses
APIs. `npm run test:contract -- --refresh` rewrites sanitized captures;
`--cases=<comma-separated names>` selects cases. Review captures before committing.
`test/bin/fake-claude.mjs` and `test/bin/fake-codex.mjs` replay them in ordinary adapter tests
without native CLIs, credentials, or network. See [rehearsal](docs/rehearsal.md) for scenario
routing and argv logging.

`npm run test:contract:isolation` additionally verifies restricted configuration, untrusted project
hooks, explicit opt-ins, and file-tool boundaries against local fake APIs. It also uses fresh homes
and dummy keys, and performs no upstream inference. See
[harness isolation](docs/harness-isolation.md).

The separate opt-in schema contract matrix uses the pinned Zod-generated fixtures in
`test/fixtures/codex-schema-matrix.json`. Run `npm run build` first, then:

```sh
node test/harness-schema-contract.mjs --codex
node test/harness-schema-contract.mjs --claude
```

These are excluded from `npm run check`. Codex uses an invalid reasoning effort to distinguish
schema rejection from accepted schemas without inference. Claude uses Haiku, no built-in tools,
isolated settings/MCP, three turns, and a $0.05 budget per shape; **it makes paid calls** and CLI
budgets may overshoot by the final turn. Pass comma-separated case names as a second argument to
retry selected cases. Set `QUIET_CHOIR_CONTRACT_REPORT` to save a JSON report. Authentication,
transport, or budget failures are inconclusive and must not be recorded as schema rejections.
