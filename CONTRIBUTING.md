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

## Pull requests

Keep pull requests reviewable and explain observable behavior changes. CI must pass on every
supported Node.js line. Update hand-written guides and API comments in the same change as the
behavior they describe.

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
