# Architecture

`quiet-choir` is intended to coordinate dynamic agent workflows without coupling workflow
definitions to a particular agent harness.

## Current layout

- `src/index.ts` is the main public package entry point; `quiet-choir/harness-kit` and
  `quiet-choir/decision` are deliberate adapter/helper subpaths. Public exports need API comments.
- `src/application/` contains framework-independent execution contracts and small executors.
- `src/workflow/` contains workflow-specific plans, results, analysis, and executors.
- `src/workflow/runtime/` defines the typed workflow API and local checkpoint/replay engine.
- `src/processes/` provides shared OS process identity and synchronous live ownership helpers.
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
context. Zod schemas alone infer callback types and validate workflow inputs/outputs, local step
results, and structured agent responses. Typed registered clients and the Claude/Codex shorthands
submit plain-data requests through named `HarnessAdapter` implementations or the compatibility
`Harness` port; the runtime owns step identity, replay, and validation independently of the CLI
processes that perform agent work. Direct-output `value()` calls use the same tracked effect and
checkpoint as `object()`/`text()`. Undefined object members are omitted at durable boundaries; array
holes and undefined elements remain errors. Fresh bodies and replayed results receive normalized
checkpoint copies. See [ADR 0017](decisions/0017-schema-first-values.md). Registered strict option
schemas validate explicit requests before recording an effect; adapters reuse the same validators
and apply their own defaults. Optional `Harness.policyDefaults` reports execution limits without
effects. The core resolves named profiles above adapter defaults, call-site policy, and sticky run
overrides before invoking the adapter, and records per-attempt limits and provenance. `runWorkflow`
and `readRun` share working-directory and storage resolution.

Plain-data profile declarations publish a capability manifest without running the body. Strict
profiles prohibit call-site capability replacements by default. The core preflights write/exec
grants for declared/default roles and checks elevated built-in calls before invocation. Named grants
are pinned to tools/permissions/sandbox and saved for resume. Profile names and limits are policy;
resolved semantic controls remain identity. See
[ADR 0010](decisions/0010-agent-profiles-and-grants.md).

The core resolves configuration isolation before agent identity, defaulting to `restricted`.
Adapters enforce native flags and scrub host-session environment before explicit set/unset edits.
Managed checkout selection remains above adapters. Environment values, Claude settings, MCP servers,
subagents, system prompts and Codex config stay in live requests; public manifests and checkpoint
diagnostics retain only names and hashes (see
[ADR 0033](decisions/0033-redact-free-form-controls-from-public-manifests.md)). Inherited host names
are diagnostic, not semantic identity. See
[ADR 0023](decisions/0023-restricted-harness-configuration.md).

Native output is parsed incrementally by adapters. The runtime owns private bounded transcripts,
early session saves, and per-attempt evidence; resource caps stay in policy. Progress events remain
lossy observations, while output/session callbacks apply backpressure and drain before process
ownership releases. See [ADR 0024](decisions/0024-stream-attempt-evidence.md).

Each local run has a directory containing a JSON snapshot, append-only journal, and exclusive owner
lock. Terminal named outcomes (successes or explicitly settled failures) are reused when their
identities match; unfinished steps execute again. A resumed workflow function starts from the
beginning, so everything outside a durable operation must be deterministic and free of side effects.
`ctx.map` provides locally bounded mapper concurrency, scoped cancellation, and drain-by-default
failure handling. Explicitly named settled maps also journal entire item outcomes and owned records;
resume skips committed mappers. Ordinary throwing maps have no collection journal. Named maps prefix
items by validated key or index; scope/within compose explicit leaves through a separate prefix
context, independent of cancellation ownership. A core-owned limiter independently caps live harness
invocations across all maps and composed helper workflows. The default is min(8, max(1, available
CPUs - 2)); data limits configure each run, and a shared limiter object can cap multiple runs.
Eligible FIFO admission skips providers at their own ceilings. Without run-budget caps, only
`Harness.invoke` holds a slot, released before response validation or outcome checkpoint writes.
Budgeted calls reserve before durable attempt setup so a reached cost gate can refuse queued work
without a record. See [ADR 0025](decisions/0025-attempt-usage-and-run-budgets.md). Queueing is
cancellable and outside per-call deadlines. Admission events are live status, not persisted
transitions; queued attempts remain `running`. See [ADR 0012](decisions/0012-agent-admission.md) and
[agent concurrency](agent-concurrency.md).

`ctx.sleep` records a durable wake deadline. The CLI checks canonical, project-relative source
hashes alongside explicit version and engine metadata. Strict resume remains the default. Explicit
code acceptance keeps step checks, and new-run forks copy matching terminal outcomes with provenance
(prefix reuse by default). Local identity includes callback source and version; captured values and
helpers remain declared dependencies. These checks guard compatibility without claiming to identify
changes in external dependencies or services. See
[ADR 0002](decisions/0002-durable-external-workflows.md) for the at-least-once execution contract,
[ADR 0005](decisions/0005-step-identity-and-policy.md) for step identity and execution policy,
[ADR 0004](decisions/0004-operation-ownership.md) for promise ownership,
[ADR 0006](decisions/0006-code-change-recovery.md) for code-change recovery,
[ADR 0007](decisions/0007-durable-failure-outcomes.md) for explicit failure outcomes,
[ADR 0008](decisions/0008-scoped-fan-out.md) for cancellation scopes and durable map items,
[ADR 0009](decisions/0009-scoped-step-ids.md) for stable scoped IDs, and
[research notes](research.md) for the comparison to Claude's dynamic workflows.

The attempt failure rules of [ADR 0007](decisions/0007-durable-failure-outcomes.md) live in one pure
function, `classifyAttemptFailure` in `src/workflow/runtime/attempt-failure.ts`. Only an aborted
signal that is not the run's own checkpoint failure is a scope cancellation. Cancellation (including
a callback's own `AbortError`), checkpoint failures and `ConfigurationError` are fatal, so they are
never retried and never settled; `ConfigurationError` is also marked fatal so it never becomes
settled map data. `retry.on` omitted retries every kind except `invalid-request`, the `'transient'`
filter expands to `rate-limit`, `overloaded` and `timeout`, and `[]` disables retry, all bounded by
`maxAttempts`. A failure settles only when it is not fatal, is exhausted or filtered out of retry,
and the effect uses `onError: 'return'`. The runner gathers the facts, calls the function once and
keeps saves, events, cancellation errors and backoff. An ESLint import guard keeps the module free
of I/O by allowing value imports only from `step-error.ts` and `configuration-error.ts`, and
`test/attempt-failure.test.ts` is the executable table of the rules.

The replay and redefinition rules live in one pure function, `decideReplay` in
`src/workflow/runtime/replay-decision.ts`, which returns an optional format-one migration and one
outcome: refuse, replay, reuse a fork step, redefine, or run fresh. Terminal identities are
immutable: a completed or settled-failed step replays only under the same kind and fingerprint.
Questions and waits are never redefined, even while unfinished. An original format-one step migrates
only on an exact old-fingerprint match, and never for a terminal agent step, whose isolation mode
was never pinned. Dry-run refuses Git effects after terminal replay but before fork reuse. Fork
reuse is considered only for an absent step in a forked run, and the lookup that advances or closes
the provenance cursor runs only when the decision reaches it. A strict healed divergence permits
terminal replay and fork reuse but stops before the next live effect. The runner keeps the migration
writes, saves, events, frame attribution and the divergence abort, and the same ESLint import guard
covers the module. `test/replay-decision.test.ts` is the executable table of these rules.

The recovery rules for runs whose owner may be gone live in
`src/workflow/runtime/recovery-decision.ts`. `classifyRecovery` sorts an ownership observation into
free, reclaimable, orphans or held; the inspection stale display and `workflow tick` both use it.
`decideStaleRecovery` applies tick's crash-loop cap of 3 consecutive recoveries with an unchanged
completed-step count. Tick keeps the lock recovery, the durable counter save and the resume; the
same ESLint import guard covers the module, and `test/recovery-decision.test.ts` is its executable
table.

HarnessInvocation carries run/step/attempt identity, the captured cancellation signal and a
process-registration port. The runtime persists child/group ownership inside the run lock; adapters
report spawns and release records only after reaping. Dead-owner recovery checks those records
before replacement work, and read-only inspection reports liveness separately from checkpoints. The
CLI owns INT/TERM/HUP handling and injects a live ProcessSupervisor outside the plain-data plan. See
[ADR 0013](decisions/0013-process-ownership.md) and [process lifecycle](process-lifecycle.md).

Phases and logs persist outside effect identity, with scoped attribution in a separate context. The
runtime owns their asynchronous saves and drains them before releasing the writer. Format 6 adds
body-execution history, per-attempt measurements, and a bounded event payload list. Inspection,
watch, and list project that record alongside ownership without source imports or lock acquisition.
See [ADR 0015](decisions/0015-observe-runs-without-changing-effect-identity.md) and
[run observability](observability.md).

## CLI execution boundary

Inline `ctx.workflow` enters a named child frame in the same run, with schema-validated I/O and
explicit profile delegation. Frames share admission, budgets and cancellation, retain their own
identity/status, and use compact namespaces for deep nesting. Settled map ownership includes child
frames; declared child identity is checked even when a committed mapper is skipped. Descriptive
metadata stays outside runtime fingerprints. The loader publishes schemas and declared trees, and
the directory registry caches plain metadata only; execution reimports the selected definition. See
[ADR 0026](decisions/0026-inline-children-and-definition-registry.md) and
[child workflows](child-workflows.md).

Commands follow the plan-execute pattern recorded in [ADR 0001](decisions/0001-plan-execute-cli.md):

1. Parse and analyze CLI input into a plain-data plan while constructing the executor from runtime
   configuration.
2. Hand the plan to the executor.
3. Receive a plain-data result.
4. Render that result and translate it into CLI output and an exit status.

The workflow executor preserves typed failure context as plain data. The CLI owns stable numeric
exits and JSON rendering, including parser failures and stdout redirection; see
[ADR 0014](decisions/0014-scriptable-cli-errors.md) and [CLI contract](cli-contract.md).

The application and workflow layers do not import oclif. Compiler objects, errors, filesystem
handles, loggers, and other live runtime objects must not escape through plan or result types.
Workflow definitions themselves contain schemas and callbacks; they are loaded executable code, not
serializable CLI plans. Checkpoints contain only validated JSON data. The loader imports workflow
code in its own module instance, with its own copy of `quiet-choir` and `quiet-choir/harness-kit`;
the runtime recognizes public errors and adapter evidence from that copy by registry-symbol brands,
not object identity. See [ADR 0028](decisions/0028-brand-public-errors-across-module-instances.md).

The workflow typecheck executor currently embeds the stable TypeScript 6 compiler API as a runtime
dependency. The repository itself builds with the native TypeScript 7 compiler; TypeScript 7.0's
programmatic API is explicitly unstable. Keeping the compiler behind the executor boundary allows a
later native implementation without changing the command contract.

## Rehearsal

The CLI executor selects native or fixture adapters through plain-data plans. Dry-run uses the
native pure argument planner, fixture/synthesized outputs, and temporary checkpoint storage; resume
copies source record data without acquiring its owner lock. Core rehearsal hooks preserve local
identity while optionally replacing callbacks and skipping durable sleeps. Call metadata and
harness-kind provenance live outside semantic fingerprints. See [workflow rehearsal](rehearsal.md)
and [ADR 0016](decisions/0016-workflow-rehearsal.md).

## Deferred configuration discovery

Oclif's `Config` represents framework and installation metadata and provides standard user data
directories. It does not recursively discover or merge application settings from `.quiet-choir`
directories. Project, local, and user configuration precedence is therefore deliberately outside
this spike rather than being conflated with oclif configuration.

## External questions

Question registration and inbox consumption live in the runtime, behind `ask`/`approve` and the
public `writeAnswer`/`listPending` helpers. `activity.ts` counts live effects/registrations/writes;
`tracking.ts` still owns failures and container operations, but drains exclude externally waiting
questions. Stable quiescence returns a suspended result without rejecting body promises or
cancelling siblings. The owner alone writes checkpoints; answer writers use exclusive inbox links.
CLI commands translate answer/pending/resume arguments into plain plans for `WorkflowExecutor`.
Stored launch paths enable resume by ID and code-free drift hints; core execution never imports
those paths. See [ADR 0018](decisions/0018-durable-questions.md) and
[question semantics](questions.md).

## Journal storage

`RunStore` separates owned read/write/compaction/process registration from orchestration. The file
implementation coalesces concurrent saves, validates changed journal records, and commits observable
outcomes before their promises settle. Readers reconstruct the snapshot plus newer entries without a
writer lock. Storage format 7 preserves replay contract 6 and existing step identities. Default
state lives under a canonical-project XDG root; the CLI discovers projects and stored launch paths
without importing workflows. Migration retains original bytes and coordinates both lock layouts. See
[storage](storage.md) and [ADR 0019](decisions/0019-journal-storage-and-project-state.md).

## External readiness and ticking

The wait coordinator unifies question inbox consumption, read-only poll observations, and pinned
deadlines. It owns parked promises separately from active work, preserving quiescent suspension and
sibling draining. New sleeps use wait records; old sleep records retain their replay bridge.
Plain-data `workflow tick` checks readiness/source bytes, acquires the ordinary writer before
imports, and injects that owned store into the loader/runtime. Operator hooks run outside durable
effects and drain after ownership release. A marked external interruption (a CLI signal or tick's
deadline) saves a resumable suspension that is due at once. See [waits](waits.md),
[ADR 0020](decisions/0020-durable-waits-and-tick.md) and
[ADR 0029](decisions/0029-persist-interruptions-as-resumable-suspensions.md).

Durable commands depend on `ProcessRunner`, injected by the CLI as `NodeProcessRunner`. The shared
`processes/run.ts` handles native child ownership and capture; core orchestration never spawns. Exec
does not consume agent admission or inherit agent grants. File effects own atomic publication and
bounded snapshots. See [ADR 0021](decisions/0021-durable-commands-and-files.md).

Worktree isolation also uses `ProcessRunner` above harness adapters. The runtime pins bases, owns
per-attempt directories, and holds shared-handle locks through snapshot persistence. Explicit merge
effects checkpoint inputs and publication intent before updating refs or a requested clean checkout.
The source-free clean executor acquires ordinary run ownership and removes only recorded caches and
pins. See [ADR 0022](decisions/0022-runtime-owned-worktree-isolation.md) and
[worktrees](worktrees.md).

## Integration boundary

The workflow module declares package harnesses explicitly. Core execution resolves the registry,
profiles and named adapters without loading native implementations. The two implicit built-in
contracts retain their revision-one identities. Adapter implementation modules use the public
harness kit; ordinary service integrations use helpers over public context methods. See
[ADR 0027](decisions/0027-typed-harness-registry-and-integration-helpers.md) for lookup precedence,
record migration, package revision policy and the deliberate departure from new service-specific
context properties.
