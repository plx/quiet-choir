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
Batch 02 port, notes and fault row in the same PR, even if it still compiles. `comparisons:check`
fails when any upstream original or batch `LICENSE` differs from its hash in `source-hashes.json`,
and also fails until `apiSnapshot.sha256` in every batch matches `src/workflow/runtime/model.ts`;
never record a commit. The six ports are release-notes, project-bootstrap, test-gap-filler,
incident-investigation, sdlc-orchestrator and bug-hunt; see
[the batch policy](comparisons/README.md#regression-and-snapshot-policy). Then `durability:check`
runs the durability lint that `workflow validate` runs
([ADR 0041](docs/decisions/0041-static-durability-lint.md)) over every `examples/` and ported
Workflow Lab workflow, and fails on any finding, type error or `// quiet-choir-ignore` comment
without a reason.

`test:cli` first runs `test/cli-smoke-runner.test.mjs` (the runner's own `node:test` checks) and
then `scripts/run-cli-smokes.mjs`, which runs every `test/*smoke.mjs` against the built CLI, four at
a time by default. A new smoke needs no CI or `package.json` edit; CI runs `npm run test:cli` in a
separate CLI smokes job, alongside Quality and package. Each smoke gets its own temporary
`XDG_STATE_HOME` and none of the caller's `QUIET_CHOIR_*` variables, and the runner fails if the
real state directory (`${XDG_STATE_HOME:-~/.local/state}/quiet-choir`) gains entries during the run.
Pass name filters and `--concurrency N` after `--` to iterate on a subset
(`npm run test:cli -- worktrees`; a smoke's exact name, such as `cli-smoke`, selects only that
smoke); a failing smoke prints the tail of its output and keeps its state directory. The Vitest
suite has a similar guard (`test/setup/state-guard.ts`). CI runs coverage thresholds on the Node 24
leg only; the Node 22.13 and 26 legs run `npm test`. Coverage slows the subprocess-heavy suites
about 2.4x (Vitest 595 s on Node 24 against 208 s on Node 22.13 for the same tests, 2026-10-02), so
the test jobs have a 15-minute limit; keep new CLI-driving tests lean rather than raising it again.

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
- Persisted run records: adding a run-level field, or changing the accepted shape of one (including
  fields nested inside run-level objects), bumps `SUPPORTED_SCHEMA_REVISION` in
  `src/workflow/runtime/record.ts` and adds a revision to
  `test/fixtures/schema-revision/record-keys.json` with its digest pinned in
  `test/record-schema-revision.test.ts`; never edit a released revision. Builds with the guard then
  refuse to rewrite newer records, but builds that predate it still drop unknown fields (see
  [record schema revision](docs/storage.md#record-schema-revision)). Any persisted-shape change also
  pins a fixture or golden digest generated with the unmodified main runtime before the edit, as
  `test/fixtures/schema-revision/` and `test/fixtures/codex-effort/` do, and keeps old records
  readable.

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

A failing golden in `test/schema-identity.test.ts` after a dependency bump (usually zod, or tsx when
it alters a schema encoding) is a gate, not a snapshot to refresh: the encoding enters step
identity, so changing it needs an explicit decision under ADR 0005 and ADR 0006 (see the durability
reference) before the expected value moves. The gate does not catch callback-text drift from a tsx
upgrade.

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
files flush concurrently, which is why the raised timeouts only showed up in full runs. TypeScript
compiles in the loader, registry and typecheck suites then dominated coverage wall time; a shared
program cache now covers them (see below). The same profile shows `journal.ts` persisting whole
`MapRecord`s per settled item (quadratic journal bytes); that is tracked separately and does not
affect the timeouts.

Linux CI runners behave differently. On `e68aba0`'s CI run (ext4, about two Vitest workers), the
fsync-heavy tests were already fast even with real syncs (144-leaf 1.5 s, 500 × 5 KiB 1.9 s), while
the compile-dominated tests were slowest. Since the Node 24 leg gained coverage it is the slowest
leg: on `81c3f5a`, before the program cache, the replay-loader symlink case took 30.0 s on Node
22.13 and 60.6 s on Node 24, the registry doctor case 30.3 s and 60.3 s, registry cache invalidation
13.1 s and 28.3 s, and typecheck schema-only inference 8.1 s and 15.8 s. Raised timeouts must cover
twice the Node 24 value.

Compile-heavy suites share one internal `TypecheckProgramCache`
(`src/workflow/typecheck/program-cache.ts`) per file, passed as `typecheckCache` to
`WorkflowExecutor`, as the last `DoctorExecutor` argument or as `cache` to `TypeScriptExecutor`. The
first compile per compiler-options set is a full check. Later compiles build a new program with
fresh module resolution but reuse the parsed text of unchanged files and, through TypeScript's
builder program (the `tsc --watch` model), their semantic diagnostics, so an edited file and the
files that depend on it are checked again. A changed module or type reference resolution in a file
both programs share, such as a removed package.json export, forces a full check, as does an added,
removed or changed file that affects the global scope in its old or new version (a script, a module
with a `declare global` block, or a UMD `export as namespace`), and the
`assumeChangesOnlyAffectDirectDependencies` option. The replay-loader, registry, registry-cli and
typecheck suites do this; typecheck keeps schema-only inference as an uncached full-engine check.
Locally (macOS, Node 26.10, worst of three `npm run test:coverage` runs on a shared machine) the
symlink case fell from 31.5 s to 8.7 s, doctor from 24.2 s to 6.4 s, the slowest registry
invalidation case from 13.1 s to 3.6 s, and the whole run from 247-270 s to 163-164 s; schema-only
inference stayed at about 6 s. The CLI passes no cache.

Timeout rule: a test or suite timeout above Vitest's 5 s default needs an adjacent comment of the
form `// measured: 1.2 s alone, 4.1 s in the full coverage run (dominated by tsImport compile)`.
Measure in a full parallel `npm run test:coverage` run and check the per-test durations in the CI
log, where the Node 24 coverage leg is now usually slowest. Remove the raise when the test fits the
default with at least 3x headroom, and otherwise set the value to about 3x the local full-run time
and at least 2x the slowest CI leg. A timeout that flakes on a CI leg gets a new measured value and
comment, not the old number. Subprocess, `tsImport`, typecheck and Git suites usually keep a raised
value because compiles and process startup, not fsync, dominate them.

## Per-test state directories

A test that starts a run or forks a process that writes into a state directory should take its
directory from the fixture in `test/setup/state-dir.ts` instead of a module-level `stateDir` with
`beforeEach`/`afterEach` hooks (#174). Import `it` from that module and destructure the fixtures in
the handler's first parameter: `async ({ stateDir, runs }) => …`. Vitest finds a test's fixtures by
parsing that destructuring, so `(context) => …` gets none. Parameterised cases must use
`it.for(cases)(name, async (value, { stateDir, runs }) => …)`, because `it.each` passes no fixtures;
`it.for` takes a raised timeout as `{ timeout }` before the handler.

- `stateDir` is a fresh `mkdtemp` directory per test, named after the test file.
- `runs.run` is `runWorkflow` with `runs.signal` combined into `options.signal`. That signal aborts
  when the test times out or is cancelled (`TestContext.signal`) and when teardown starts. Every
  `runWorkflow` call that writes into the directory goes through it, including runs the test does
  not await.
- `runs.child(child)` records a child process; create it with
  `{ signal: runs.signal, killSignal: 'SIGKILL' }` so a timeout kills it. `runs.track(promise)`
  records any other work.

At teardown, `runs` aborts its signal, then waits for every tracked run and child to settle, and
only then is `stateDir` removed, without retries. Before the fixture, a timed-out run kept writing
while `afterEach` removed the shared directory, so `rm` failed with ENOTEMPTY and one timeout became
several failures. The wait is bounded by `SETTLE_TIMEOUT_MS` (10 s), because Vitest gives fixture
teardown no timeout. Past it, teardown fails that test with an error naming the directory and leaves
the directory in place rather than removing it under a live writer. `test/state-dir-fixture.test.ts`
forces timeouts with an in-process run and with a child process, and checks that only the timeout is
reported and that the directory is removed after the writer settles.

The journal suite uses the fixture. The other suites still keep a module-level directory and move to
the fixture incrementally; any suite that forks writers or can leave a run unawaited is a good next
candidate.

## CLI command capture

Vitest does not cancel a timed-out test body: the test fails, its fixtures tear down and the next
test starts while the old body keeps running. In `test/cli.test.ts` that abandoned body kept calling
the shared `captureCommand` helper during later tests (#249). Each of its calls re-pointed the
current test's `console.log` and `console.error` spies (`vi.spyOn` reuses an existing spy) into the
stale output array, overwrote the current test's executor prototype mocks, and wrote
`process.exitCode`, so one slow test was followed by tests that saw empty stdout or the wrong exit
code. Reproduce it with a short timeout, which turns the slowest cases into timeouts:
`npx vitest run test/cli.test.ts --testTimeout=40`. On the old helper this reported the genuine
timeouts plus empty-stdout failures in the tests after them; now it reports only the timeouts.

CLI adapter tests take their capture from the `cli` fixture in `test/setup/cli-capture.ts`. Import
`it` from that module (it extends the state-directory `it`, so `stateDir` and `runs` remain
available) and destructure it: `async ({ cli }) => …`, or `async (value, { cli }) => …` with
`it.for`. `cli.run(Command, argv)` runs one command class from the project root and returns its
`error`, `stdout`, `stderr` and `exitCode`.

- Each call installs and restores its own console spies, and resets `process.exitCode` before the
  command runs and again after reading it. Assert on the result's `exitCode`; never read or assign
  `process.exitCode` in these tests.
- A second `cli.run` while one is in flight from the same test is refused.
- At teardown the handle is closed, so a timed-out body's later `cli.run` is refused, and the call
  in flight is awaited, while that test's mocks are still installed, before the next test starts.
  The wait is bounded by the `settleTimeoutMs` fixture (`SETTLE_TIMEOUT_MS`, 10 s); past it,
  teardown fails the test with an error naming it.

A stale body can still run code between its awaits that does not go through `cli.run`, such as a
`vi.spyOn` on an executor prototype after an `await` on `mkdtemp`, so keep the slow work in a test
inside `cli.run` and keep timeouts measured. `test/cli-capture-fixture.test.ts` forces a timeout
with a fake command and checks the drain, the refusal and the next test's clean state. Other suites
with a local console-spy capture helper (`run-result-cli`, `pending-cli`, `run-prune`,
`events-follow`, `doctor`) can move to the fixture incrementally.

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
