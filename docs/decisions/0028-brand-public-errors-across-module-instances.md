# 0028: Brand public errors across module instances

- Status: accepted
- Issue: #123

## Context

`workflow execute` imports a workflow with tsx `tsImport`, which namespaces the workflow's whole
import graph. Workflow and custom-adapter code therefore get their own copy of `quiet-choir` and
`quiet-choir/harness-kit`, separate from the copy the CLI runs. The runtime classified failures with
`instanceof` and kept adapter evidence in a module-scoped `WeakMap`, and both depend on object
identity. Under the CLI, a custom adapter's `HarnessError` with HTTP 429 classified as `unknown`, so
`retry.on: ['rate-limit']` never fired. A `ConfigurationError` was settled or retried instead of
rejecting, contrary to [ADR 0007](0007-durable-failure-outcomes.md), and `attachHarnessEvidence`
wrote to a map the host never read. `e instanceof ExecError` was also false in workflow code for
errors the runtime built. Embedded `runWorkflow` has one module instance, so its tests passed.

## Decision

Identity of public errors is structural and keyed by global registry symbols; the loader stays as it
is. Every `Error` subclass exported from `quiet-choir` or `quiet-choir/harness-kit` is branded by
`src/workflow/runtime/error-brand.ts`:

- The prototype carries a frozen, non-enumerable array under `Symbol.for('quiet-choir.error')`: the
  class's own name followed by its branded ancestors' names. `OrphanProcessesError` carries
  `['OrphanProcessesError', 'RunRefusedError']`.
- The class itself carries its own name under `Symbol.for('quiet-choir.error-name')`, and declares
  its own `static [Symbol.hasInstance]` type predicate. Declaring it on each class, not only on the
  root, keeps TypeScript's `instanceof` narrowing to the subclass type.
- `instanceof` first runs the ordinary prototype check, so one module instance behaves as before.
  Otherwise only a class with its own brand name accepts a value, and only when the value's chain
  contains that name. A parent instance is therefore never an instance of a subclass, and a user
  subclass without its own brand keeps plain prototype semantics.

Adapter evidence is a non-enumerable, writable property keyed by
`Symbol.for('quiet-choir.evidence')`. For a non-extensible (frozen) error, `attachHarnessEvidence`
falls back to a `WeakMap` kept on `globalThis` under `Symbol.for('quiet-choir.frozenEvidence')`
(#195), so every copy in the process shares one store. It is created lazily on the first such write,
never by a read, and is weakly keyed, so an error is not kept alive by its evidence.

Making the loader resolve `quiet-choir` to the host instance would also work. It would couple the
loader to tsx resolution internals and would not cover other duplicate installs, so it is left out.

## Consequences

- Every new public error class must be branded; `test/error-brand.test.ts` fails when an exported
  `Error` class lacks its own brand. Internal host-only errors, such as the loader's
  `WorkflowDefinitionError`, stay unbranded. Zod v4 already brands its own errors.
- The four `Symbol.for` keys (error, error-name, evidence, frozenEvidence) and the name-chain layout
  are a contract between quiet-choir copies, including different installed versions. Change them
  only with a compatibility plan. A value under the store key that is not a `WeakMap` is ignored
  rather than trusted or overwritten: reads find nothing and writes are dropped. A copy that
  predates the shared store still keeps frozen-error evidence in its own map, which a newer host
  cannot see.
- An error from any quiet-choir copy is trusted by class name. `errorKind` accepts a branded error's
  `kind` only when it is a known error kind and otherwise records `unknown`, so another version
  cannot write an invalid kind into a checkpoint. Other fields, such as diagnostics, `failure`,
  `cancelledBy` or `stop`, are assumed compatible. Anyone can forge a brand, but workflow code is
  trusted, as [ADR 0027](0027-typed-harness-registry-and-integration-helpers.md) already states for
  adapters.
- ADR 0007's infrastructure rule still uses identity for this run's own checkpoint failures. A
  `CheckpointError` built by workflow code is a domain error, whichever copy built it.
- Brand and evidence properties are non-enumerable and live on the prototype or behind a symbol, so
  they never reach JSON, spreads, checkpoint records or test snapshots.
