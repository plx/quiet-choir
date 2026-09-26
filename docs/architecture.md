# Architecture

`quiet-choir` is intended to coordinate dynamic agent workflows without coupling workflow
definitions to a particular agent harness.

## Current layout

- `src/index.ts` is the only public package entry point. Public exports should be deliberate and
  documented there.
- `src/application/` contains framework-independent execution contracts and small executors.
- `src/workflow/` contains workflow-specific plans, results, analysis, and executors.
- `src/workflow/runtime/` defines the typed workflow API and local checkpoint/replay engine.
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

## Workflow execution

Workflow definitions combine ordinary TypeScript control flow with durable operations on a supplied
context. Zod schemas infer and validate workflow inputs/outputs, local step results, and structured
agent responses. Dedicated Claude and Codex clients submit plain-data requests through the
replaceable `Harness` interface; the runtime owns step identity, replay, and validation
independently of the CLI processes that perform agent work. Core-owned option schemas validate
explicit requests before recording an effect; adapters reuse the same validators and apply their own
defaults. Optional `Harness.policyDefaults` reports execution limits without effects. The core
resolves those defaults, call-site policy, and sticky run overrides before invoking the adapter, and
records per-attempt limits and provenance. `runWorkflow` and `readRun` share working-directory and
storage resolution.

Each local run has a JSON checkpoint and an exclusive owner lock. Completed named steps are reused
when their inputs match; unfinished steps execute again. A resumed workflow function starts from the
beginning, so everything outside a durable operation must be deterministic and free of side effects.
`ctx.map` provides bounded concurrency and `ctx.sleep` records a durable wake deadline. The CLI
checks canonical, project-relative source hashes alongside explicit version and engine metadata.
Strict resume remains the default. Explicit code acceptance keeps step checks, and new-run forks
copy matching completed effects with provenance (prefix reuse by default). Local identity includes
callback source and version; captured values and helpers remain declared dependencies. These checks
guard compatibility without claiming to identify changes in external dependencies or services. See
[ADR 0002](decisions/0002-durable-external-workflows.md) for the at-least-once execution contract,
[ADR 0005](decisions/0005-step-identity-and-policy.md) for step identity and execution policy,
[ADR 0004](decisions/0004-operation-ownership.md) for promise ownership,
[ADR 0006](decisions/0006-code-change-recovery.md) for code-change recovery, and
[research notes](research.md) for the comparison to Claude's dynamic workflows.

## CLI execution boundary

Commands follow the plan-execute pattern recorded in [ADR 0001](decisions/0001-plan-execute-cli.md):

1. Parse and analyze CLI input into a plain-data plan while constructing the executor from runtime
   configuration.
2. Hand the plan to the executor.
3. Receive a plain-data result.
4. Render that result and translate it into CLI output and an exit status.

The application and workflow layers do not import oclif. Compiler objects, errors, filesystem
handles, loggers, and other live runtime objects must not escape through plan or result types.
Workflow definitions themselves contain schemas and callbacks; they are loaded executable code, not
serializable CLI plans. Checkpoints contain only validated JSON data.

The workflow typecheck executor currently embeds the stable TypeScript 6 compiler API as a runtime
dependency. The repository itself builds with the native TypeScript 7 compiler; TypeScript 7.0's
programmatic API is explicitly unstable. Keeping the compiler behind the executor boundary allows a
later native implementation without changing the command contract.

## Deferred configuration discovery

Oclif's `Config` represents framework and installation metadata and provides standard user data
directories. It does not recursively discover or merge application settings from `.quiet-choir`
directories. Project, local, and user configuration precedence is therefore deliberately outside
this spike rather than being conflated with oclif configuration.
