# Architecture

`quiet-choir` is intended to coordinate dynamic agent workflows without coupling workflow
definitions to a particular agent harness.

## Current layout

- `src/index.ts` is the only public package entry point. Public exports should be deliberate and
  documented there.
- `src/` contains production TypeScript. Generated JavaScript, declarations, and source maps go to
  `dist/`.
- `test/` contains behavior-focused tests. Tests consume the public entry point whenever practical.
- `docs/` contains hand-written guides. TypeDoc combines these guides with API doc comments and
  emits the publishable site to `docs/api/`.

## Dependency direction

As the engine grows, keep the workflow model and orchestration policy independent from harness,
storage, transport, and model-provider integrations. Integrations should depend on the core
contracts; the core should not import integrations. This keeps workflows portable and makes
deterministic unit testing possible.

Record consequential design choices as short architecture decision records under `docs/decisions/`.
