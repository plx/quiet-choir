# Contributing

## Development workflow

1. Use Node.js 24 (`nvm use`) and install the locked dependency graph with `npm ci`.
2. Make focused changes in `src/` and add behavior-focused tests in `test/`.
3. Document each public export with TypeDoc-compatible comments and re-export it from
   `src/index.ts`.
4. Run `npm run check` (or `just check`) before opening a pull request.

`npm run check` verifies formatting, type-aware lint rules, TypeScript, coverage thresholds, build
output, API documentation, and the packed module/type-resolution contract. After the build,
`comparisons:check` also typechecks the active Workflow Lab batch and verifies its saved fixture
report without rewriting it. An API change that breaks a port must update the port, report, and API
snapshot in the same PR; see
[the batch policy](comparisons/README.md#regression-and-snapshot-policy).

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

The opt-in schema contract matrix uses the pinned Zod-generated fixtures in
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
