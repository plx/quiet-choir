# Architecture

`quiet-choir` is intended to coordinate dynamic agent workflows without coupling workflow
definitions to a particular agent harness.

## Current layout

- `src/index.ts` is the only public package entry point. Public exports should be deliberate and
  documented there.
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
results, and structured agent responses. Dedicated Claude and Codex clients submit plain-data
requests through the replaceable `Harness` interface; the runtime owns step identity, replay, and
validation independently of the CLI processes that perform agent work. Direct-output `value()` calls
use the same tracked effect and checkpoint as `object()`/`text()`. Undefined object members are
omitted at durable boundaries; array holes and undefined elements remain errors. Fresh bodies and
replayed results receive normalized checkpoint copies. See
[ADR 0017](decisions/0017-schema-first-values.md). Core-owned option schemas validate explicit
requests before recording an effect; adapters reuse the same validators and apply their own
defaults. Optional `Harness.policyDefaults` reports execution limits without effects. The core
resolves named profiles above adapter defaults, call-site policy, and sticky run overrides before
invoking the adapter, and records per-attempt limits and provenance. `runWorkflow` and `readRun`
share working-directory and storage resolution.

Plain-data profile declarations publish a capability manifest without running the body. Strict
profiles prohibit call-site capability replacements by default. The core preflights write/exec
grants for declared/default roles and checks elevated built-in calls before invocation. Named grants
are pinned to tools/permissions/sandbox and saved for resume. Profile names and limits are policy;
resolved semantic controls remain identity. See
[ADR 0010](decisions/0010-agent-profiles-and-grants.md).

The core resolves configuration isolation before agent identity, defaulting to `restricted`.
Adapters enforce native flags and scrub host-session environment before explicit set/unset edits.
Managed checkout selection remains above adapters. Environment values stay in live requests; public
manifests and checkpoint diagnostics retain only names and hashes. Inherited host names are
diagnostic, not semantic identity. See
[ADR 0023](decisions/0023-restricted-harness-configuration.md).

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
Eligible FIFO admission skips providers at their own ceilings. Only `Harness.invoke` holds a slot,
released before response validation or checkpoint writes. Queueing is cancellable and outside
per-call deadlines. Admission events are live status, not persisted transitions; queued attempts
remain `running`. See [ADR 0012](decisions/0012-agent-admission.md) and
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
serializable CLI plans. Checkpoints contain only validated JSON data.

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
effects and drain after ownership release. See [waits](waits.md) and
[ADR 0020](decisions/0020-durable-waits-and-tick.md).

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
