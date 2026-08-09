# Architecture

`quiet-choir` is intended to coordinate dynamic agent workflows without coupling workflow
definitions to a particular agent harness.

## Current layout

- `src/index.ts` is the only public package entry point. Public exports should be deliberate and
  documented there.
- `src/application/` contains framework-independent execution contracts and small executors.
- `src/workflow/` contains workflow-specific plans, results, analysis, and executors.
- `src/cli/` adapts oclif concerns such as inherited flags, logging, and presentation.
- `src/commands/` contains thin, filesystem-discovered oclif command adapters.
- `bin/` contains development and compiled CLI launchers.
- Generated JavaScript, declarations, and source maps go to `dist/`.
- `test/` contains behavior-focused tests. Tests consume the public entry point whenever practical.
- `docs/` contains hand-written guides. TypeDoc combines these guides with API doc comments and
  emits the publishable site to `docs/api/`.

## Dependency direction

As the engine grows, keep the workflow model and orchestration policy independent from harness,
storage, transport, and model-provider integrations. Integrations should depend on the core
contracts; the core should not import integrations. This keeps workflows portable and makes
deterministic unit testing possible.

Record consequential design choices as short architecture decision records under `docs/decisions/`.

## CLI execution boundary

Commands follow the plan-execute pattern recorded in [ADR 0001](decisions/0001-plan-execute-cli.md):

1. Parse and analyze CLI input into a plain-data plan while constructing the executor from runtime
   configuration.
2. Hand the plan to the executor.
3. Receive a plain-data result.
4. Render that result and translate it into CLI output and an exit status.

The application and workflow layers do not import oclif. Compiler objects, errors, filesystem
handles, loggers, and other live runtime objects must not escape through plan or result types.

The workflow typecheck executor currently embeds the stable TypeScript 6 compiler API as a runtime
dependency. The repository itself builds with the native TypeScript 7 compiler; TypeScript 7.0's
programmatic API is explicitly unstable. Keeping the compiler behind the executor boundary allows a
later native implementation without changing the command contract.

## Deferred configuration discovery

Oclif's `Config` represents framework and installation metadata and provides standard user data
directories. It does not recursively discover or merge application settings from `.quiet-choir`
directories. Project, local, and user configuration precedence is therefore deliberately outside
this spike rather than being conflated with oclif configuration.
