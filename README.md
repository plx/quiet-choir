# quiet-choir

Write agent workflows in TypeScript. Call Claude Code and Codex through dedicated typed APIs, use
ordinary loops and branches, and resume from local checkpoints after a failure.

**Status: serious prototype spike, version 0.0.0, private package.** The CLI, runtime, and both
harness adapters work. This is a local execution engine with at-least-once effects, not a production
service.

## Agent documentation

For agents working on this repository, start with [AGENTS.md](AGENTS.md). To teach an agent to use
quiet-choir, install its [Claude Code or Codex reference plugin](docs/plugins.md). Each plugin
bundles a concise skill with topic-specific references for authoring, harness options, durability,
inspection, and extensions; the runtime is installed separately.

Use [inline child workflows](docs/child-workflows.md) to compose typed workflows in one run with
recorded identities, delegated profiles and a visible tree. `workflow validate --json` publishes
schemas and descriptions; `workflow list-defs` discovers trusted definitions for execution by name.

## Try it without an agent subscription

Use Node.js 24.x (recommended), 22.x from 22.13, or 26.x, and npm 10.9+. Node 23.x and 25.x are
unsupported. Run these bundled examples from the checkout root.

```sh
npm ci
npm run build
qc_state_dir="$(mktemp -d)"
npm run cli -- workflow execute examples/local.workflow.ts --run-id first --state-dir "$qc_state_dir"
npm run --silent cli -- workflow inspect first --state-dir "$qc_state_dir" --json
```

The local example uppercases words with bounded parallelism and checkpoints the results. To see
recovery, deliberately fail its final step, then resume with the same command and `--resume`:

```sh
qc_recovery_state_dir="$(mktemp -d)"
npm run cli -- workflow execute examples/local.workflow.ts \
  --run-id recovery --state-dir "$qc_recovery_state_dir" --input '{"failOnce":true}'
# Expected: exit 1, after the word steps have completed.

npm run --silent cli -- workflow inspect recovery --state-dir "$qc_recovery_state_dir" --json
npm run cli -- workflow execute examples/local.workflow.ts \
  --run-id recovery --state-dir "$qc_recovery_state_dir" --resume
# Word steps replay from disk; only the failed summary step executes again.
```

The CLI prints the run ID and absolute state directory before executing. Without `--run-id`, it
generates one. Reusing an existing ID requires `--resume`; a completed run returns its saved output
without calling any harness. Keep the absolute state directory for inspection and resume.

The CLI launch directory becomes the recorded run `cwd`, the base for relative FILE and
`--state-dir` paths and agent calls' relative `cwd`. The default state container is outside the
workspace under a project-specific XDG root. `workflow execute --resume --run-id RUN` and
`workflow resume RUN` can load the stored entrypoint/cwd; pass `--state-dir` when operating from
another project. A supplied FILE must match the original entrypoint. There is no `--cwd` flag.
`npm run cli --` launches from this checkout even when run in a subdirectory. For work in another
project, change to that project and invoke
`node /absolute/path/to/quiet-choir/bin/run.js workflow …`, or use `npx --no-install quiet-choir`
where the package is already installed. An agent option's absolute `cwd` is accepted without
confinement and must name an existing directory.

## Rehearse before you pay

```sh
npm run --silent cli -- workflow execute examples/duet.workflow.ts \
  --input '{"topic":"durable agent workflows"}' --dry-run --json
```

Dry-run synthesizes agent responses, validates the same native argv/schema plans, skips durable
sleeps, and removes its temporary checkpoints. **Local callbacks and imported code run for real**;
use `--stub-steps 'publish/**'` to synthesize selected local effects. Inspect full prompts, resolved
limits, per-harness counts, the nominal Claude ceiling, and warnings before a native run. Only the
rehearsed path is covered; minimal arrays can understate fan-out.

Use `--harness fixture:./fixtures.json` for named fixture responses (agent `calls` and command
`exec` rules), or combine it with `--dry-run` for temporary execution and synthesis of missing
calls. `workflow fixtures RUN_ID --json` exports completed agent outputs, settled and absorbed agent
failures and command results from a completed run. `--dry-run --resume --run-id RUN_ID` previews the
remaining work on a copy of real state. Changing a recorded harness kind for actual resume/fork
requires `--allow-harness-change`. Configure CLI paths/limits with `--harness-config` JSON or @file;
a run records its digest, so resume and tick must repeat the same configuration (omitted means the
defaults) or pass `--allow-harness-config-change`. See [workflow rehearsal](docs/rehearsal.md) for
fixture format, report fields, and free native protocol tests.

## Author a workflow

Workflows default-export `defineWorkflow(...)`. Input, final output, and structured agent responses
use [Zod](https://zod.dev/) schemas for TypeScript inference and runtime validation. Schemas alone
infer input/output types; callbacks cannot widen their contracts. Never cast the output schema:
write the actual shape, or use `z.json()` without a cast. Zero-parameter callbacks returning enum
literals may need `as const` (especially async local steps).

```ts
import { defineWorkflow, z } from 'quiet-choir';

export default defineWorkflow({
  name: 'review-label',
  version: '1',
  input: z.object({ topic: z.string() }),
  output: z.object({ label: z.string(), accepted: z.boolean() }),
  async run(ctx, input) {
    const proposal = await ctx.claude.value('propose', {
      prompt: `Suggest a short label for: ${input.topic}`,
      model: 'haiku',
      schema: z.object({ label: z.string() }),
    });
    const review = await ctx.codex.value('review', {
      prompt: `Is this label clear? ${proposal.label}`,
      schema: z.object({ accepted: z.boolean() }),
    });
    return { label: proposal.label, accepted: review.accepted };
  },
});
```

The checked-in [duet example](examples/duet.workflow.ts) is a small real two-harness workflow:

```sh
npm run --silent cli -- workflow validate examples/duet.workflow.ts --json
qc_duet_state_dir="$(mktemp -d)"
npm run cli -- workflow execute examples/duet.workflow.ts \
  --run-id duet --state-dir "$qc_duet_state_dir" --input '{"topic":"durable agent workflows"}'
```

Install and sign in to `claude` and `codex` separately. The adapters invoke the installed CLIs and
retain native authentication; restricted configuration loading is the default. No separate provider
API key is required. See [harness isolation](docs/harness-isolation.md). The source examples import
`../src/index.js` so they work directly in this private repository. An installed consumer imports
`quiet-choir` as above.

## Operations

| API                                                                            | Behavior                                                                      |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `ctx.claude.value(id, { schema?, ...options })`                                | Schema-inferred output, or plain text without a schema                        |
| `ctx.codex.value`                                                              | Equivalent Codex direct-output API                                            |
| `ctx.claude.text(id, options)`                                                 | Durable Claude text result                                                    |
| `ctx.claude.object(id, { schema, ...options })`                                | Durable, validated Claude structured result                                   |
| `ctx.codex.text` / `ctx.codex.object`                                          | Equivalent Codex APIs with Codex-specific options                             |
| `ctx.step(id, { input, schema, run, retry? })`                                 | Checkpoint a local effect; explicit dependencies detect replay drift          |
| `ctx.map(id, items, { concurrency, key?, onError?, cancelSiblings? }, mapper)` | Bounded fan-out; each item prefixes explicit leaf IDs with its map ID and key |
| `ctx.ask(id, { prompt, schema, ... })`                                         | Durable external answer; suspends after active work drains                    |
| `ctx.approve(id, options)`                                                     | Durable `{ approved, comment? }` decision for a specific subject              |
| `ctx.now(id)`                                                                  | Record a stable clock anchor for replay                                       |
| `ctx.wait(id, sources)`                                                        | Resolve a signal, read-only poll, or deadline in one record                   |
| `ctx.sleepUntil(id, epochMs)`                                                  | Wait until a fixed deadline; long waits suspend                               |
| `ctx.poll(id, options)`                                                        | Poll an observer or a command, with a schema, spacing, and finite deadline    |
| `ctx.sleep(id, milliseconds)`                                                  | Persist a wake time and wait only the remaining time after resume             |

Long waits suspend at quiescence without cancelling siblings; waits due within 1000 ms stay live.
Use `workflow tick --run RUN --watch --timeout 540s --json` or periodic cron to resume due work.
`--wait-mode block` keeps execute/resume in-process. Use one `ctx.wait` for competing sources; never
`Promise.race` durable operations. See [durable waits and notifications](docs/waits.md).

`value()` writes the same durable records and identities as `object()`/`text()`, returning only the
output. With `onError: 'return'`, it returns `Settled<T>` or `Settled<string>`. Successful new agent
`step.completed` events include `usage` and `sessionId`; replay/reuse events do not report usage
again. Observers receive a detached copy.

Set agent `worktree: true` for a fresh checkout on every attempt, or pass a shared
`ctx.worktree(id)` handle as `worktree` for write → test → fix effects. Isolated result methods
include a pinned `worktree` change; `ctx.merge(id, changes)` integrates in input order to a
run-owned ref by default. The source checkout changes only with explicit `target: 'checkout'`. Use
sharding for structurally disjoint files; isolate overlapping writers or commands that observe
concurrent edits. See [worktree isolation, policies, and cleanup](docs/worktrees.md).
`workflow clean RUN [--refs]` removes owned caches and optionally pins without importing source.
`workflow rm RUN [--force] [--refs] [--dry-run]` removes a whole saved run with its caches (pins
only with `--refs`); it never overrides a held lock, and refuses a running, suspended or waiting run
without `--force` (see [removing runs](docs/storage.md#removing-runs)).
`workflow prune [--older-than 7d] [--status S] [--missing-cwd] [--all] [--refs] [--dry-run]` needs
at least one filter and removes finished runs in bulk through the same guarded rm, skipping any run
that is active, waiting, holds a queued answer or is locked. `workflow list` shows each run's
on-disk size. `workflow unlock RUN [--force-remote] [--json]` clears an abandoned run lock without
importing source; it refuses while an owner, recoverer or recorded child is alive or unverifiable
(see [process ownership](docs/process-lifecycle.md)). `workflow unlock --worktree-admin PATH` clears
a repository's abandoned worktree administration lock the same way.
`workflow cancel RUN [--force] [--timeout 30s]` ends a live local run as `cancelled`, which tick
never resumes: it signals only a live owner on this host whose recorded OS start time still matches,
and refuses with exit 3 otherwise (a plain signal saves a resumable suspension instead; see
[ADR 0039](docs/decisions/0039-cancel-a-live-run-through-a-token-bound-request.md)).
`workflow start FILE [execute flags] [--json]` runs `workflow execute` as a detached background
runner and returns the run ID once the run's record exists, so an immediate `workflow inspect` reads
it; a failure before the record exists (such as a type error) is reported with the runner's error
and no run ID. The runner's result document and log are kept owner-only under
`<state>/<run>/launch/`, and `--start-timeout` (default 60s) bounds the wait (see
[workflow start](docs/cli-contract.md#workflow-start)). `workflow events RUN --follow` prints the
run's compact event lines from its record, without importing the workflow, and exits with the watch
codes when the run ends (see [event follower](docs/cli-contract.md#event-follower)).

`object()` and `text()` results contain `output`, native `sessionId`, and reported token/cost
`usage`. Native session IDs are for correlation only: `CliHarness` uses Claude
`--no-session-persistence` and Codex `--ephemeral`, so these calls have no persisted local session
transcript. Each effect starts fresh. `object` and schema-bearing `value` send JSON Schema to the
harness and validate the returned JSON locally. Codex defaults to `structuredOutput: 'compat'`:
optional properties become nullable on the wire, non-object roots are wrapped, records use key/value
entries (enum-keyed records require all keys), discriminated unions use `anyOf`, and loose objects
are closed. The adapter reverses these encodings before the original Zod validation; nullable
optionals retain null, while other optional nulls become absent properties. Unknown keys are not
requested for loose objects. Tuples, `z.unknown()`/`z.any()` values (properties, array items and
record values), and unions mixing a string-keyed record with an array, are rejected locally; use
named object properties or discriminated objects, give the value a concrete type, or request a
`z.string()` and parse it locally.

Choose `structuredOutput: 'strict'` to send a native Codex schema: use an object root, make every
property required (use `.nullable()` for missing values), and avoid records, loose objects,
discriminated unions, tuples, and untyped values (`z.unknown()`/`z.any()`).
`checkCodexSchema(schema)` returns JSON paths and fixes before a workflow runs. `workflow validate`
cannot inspect call-site schemas without running the body. Refinements are enforced locally, so
repeat them in the prompt. Schema transforms and class-valued schemas cannot be converted to JSON
Schema. `z.date()`, `z.void()`, `z.undefined()`, and `z.bigint()` also fail conversion when their
operation runs; `validate` checks only workflow input/output. Use `z.null()` and return `null` for
side-effect-only steps. Claude receives the original schema and also requires an object root; other
Codex restrictions and wire transforms do not apply to it.

Use `z.object` by default: local parsing strips unknown keys, and generated schemas close the object
with `additionalProperties: false`. Use `z.looseObject` only when code must retain unknown keys;
Codex compat closes these objects on the wire, and strict mode rejects them. Never add
`.catchall(z.json())` to imitate permissive JSON schemas.

Checkpoint normalization drops `undefined` object members recursively at workflow input, local step
dependencies, agent requests, step outputs, and final output. Fresh bodies receive the saved input
copy; fresh/replayed results omit the same members. `JsonInput` permits omitted dependency members;
saved `JsonValue` remains strict JSON. Undefined array elements and holes are errors with an exact
path; use `null` with `.nullable()`, or filter them out. Root undefined, bigint, functions, symbols,
special numbers (including negative zero), cycles, getters, and class instances still fail.

Without a project tsconfig, CLI typechecking uses strict Node/ES2023 defaults with
`noUncheckedIndexedAccess`; it does not enable `exactOptionalPropertyTypes`. `workflow typecheck`
prints effective compiler flags and includes `compilerOptions` in JSON (under `error.details` on
failure). An unchanged in-flight run can now fail the pre-execution typecheck on resume; fix the
code and use the explicit code-change recovery path described below.

A local effect might use `ctx.step('read', { input: { path }, schema: z.string(), run: ... })`.
Callbacks receive `{ cwd, signal, attempt, idempotencyKey }`. Opt into retries only for repeatable
effects, with `retry: { maxAttempts: 3, delayMs: 100 }`; delays double up to 30 seconds. Agent
effects also accept explicit retry policies; the default is one attempt. A later explicit resume
retries unfinished effects, including failed agent calls. `ctx.runId` and `ctx.signal` expose run
identity and cancellation. Local callbacks and `HarnessRequest.call` receive a stable
`idempotencyKey`; native CLIs do not deduplicate edits with it, so agent work can repeat. Step
dependencies, prompts, and identity options are stored as component hashes, alongside the full
validated result. Resolved policy, requested model/effort, and provenance are recorded per attempt.

For embedding, call `runWorkflow(definition, { runId, input, harness: new CliHarness() })`. Its
output is typed from the workflow schema. Supply `signal`, `stateDir`, `cwd`, `onEvent`, and a code
`fingerprint` as needed. The core depends on a `Harness` interface, so tests and alternative
integrations can replace subprocesses without changing workflows. Read the saved record with
`readRun({ runId, cwd, stateDir })`; explicit state paths resolve against `cwd`, followed by the
`QUIET_CHOIR_STATE_DIR` environment, legacy run discovery, and project-specific XDG state.
`resolveStateDir({ cwd, stateDir, runId })` returns that absolute path. `workflow list --all` finds
registered projects. See [storage layout, migration, and durability](docs/storage.md). An `onEvent`
observer may return `void` or `Promise<void>`; it is not awaited, and both synchronous throws and
rejected promises are ignored.

Explicit agent options are validated before recording the step, using the exported
`claudeOptionsSchema` and `codexOptionsSchema` also used by `CliHarness`. Top-level undefined option
values and nested undefined object members are omitted. Other invalid JSON names the boundary, step
(when applicable), and offending JSON path. Embedded callers can correct an invalid option and
resume when no step was recorded; CLI source edits still change the workflow fingerprint. Call-site
validation runs during execution, not during `workflow validate`.

To recover a timeout without editing CLI workflow source, resume with a sticky policy override:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --resume \
  --policy '{"match":"review","timeoutMs":600000}'
```

Use the original launch directory, state path, and absolute `QC_CHECKOUT`. Completed steps replay;
only unfinished calls use the new deadline. Repeat `--policy` for ordered rules; later matching
fields win over call-site options and adapter defaults. `--policy-reset` clears saved rules. A bare
resume retains them. `model` and `effort` overrides require `--allow-model-override` when added
(`effort` rules apply to Codex steps only); completed calls never rerun because of policy. Embedded
callers use `RunOptions.policy`, `policyReset`, and `allowModelOverride`, or edit call-site limits
without changing their source fingerprint. Globs use `*` within segments and `**` across `/`.

The implicit `text` profile supplies a five-minute deadline, 10 Claude turns and a $0.50 per-call
budget. `readonly` and `edit` supply larger limits. Custom harnesses receive those resolved options,
must enforce them, and can report adapter-specific defaults through `policyDefaults(harness)`. See
[agent profiles and launch grants](docs/agent-profiles.md) for declarations, `--profile` recovery,
and strict capability checks. `inspect --json` exposes saved rules and each step's `attemptHistory`,
including resolved policy and its sources. New runs use storage format 7 with replay contract 6.
Flat format-6 runs migrate on resume and can seed forks. Format 1 resumes (migrating) but must be
resumed before it can seed a fork. Formats 2-5 remain inspectable but cannot resume or supply fork
reuse with this runtime; retain the original runtime or choose a new run ID. See
[the policy decision](docs/decisions/0005-step-identity-and-policy.md) and
[legacy records](docs/storage.md#legacy-records).

To recover after editing workflow code, choose an explicit reuse path:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow check-resume review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --json
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-2 --state-dir "$qc_state_dir" --fork-from review-1
# Or accept a tail-only fix on the original run (preview first with --dry-run):
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --resume --accept-code-change
```

Forks preserve the source checkpoint and default to causal prefix reuse: an unchanged step is copied
only when the source steps that settled before it launched were copied too. A miss makes the steps
launched after it settled run live, while same-tick siblings and the sibling items of a named map
stay reusable. `--reuse matching` explicitly reuses all matching terminal IDs, which requires
accounting for undeclared workspace dependencies. Repeat `--invalidate 'path/**'` to force effects
live. Forks inherit source input when omitted, accept new explicit input/version, and require the
same workflow name. Inspect `forkedFrom` and each copied step's `reusedFrom` for provenance. Resume
the target normally after interruption; source changes close further reuse.

`--accept-code-change` waives only source/run-schema gates, keeping name/version, engine, cwd,
validated input, terminal-step identity, and replay checks. Each use that actually changes code,
schemas, or files is recorded in `codeChanges`. A tail/output fix can finish with zero repeated
effects. An edit that changes a completed step, or skips a completed step, settled map or child
frame, cannot be accepted: the command replays the body on a disposable copy first and refuses with
`run.incompatible`, leaving the run unchanged, and `error.details.next` gives the
`--fork-from RUN --reuse matching --invalidate STEP` command to use instead. Local step identity now
hashes callback source and optional `version` as well as input/schema/cwd. The CLI loader removes
callback comments and formatting; captured values, helper implementations, native/bound functions,
and environment remain invisible. Declare dependencies in input, bump the step version, or
invalidate in a fork. See [the recovery decision](docs/decisions/0006-code-change-recovery.md).

## Scoped IDs and reusable helpers

Use `await ctx.scope('round-1', async () => { ... })` to prefix every effect launched inside the
callback. Nested scopes compose, including calls made through ordinary async helpers. Keep explicit
leaf names such as `read`, `verdict`, or `summarize`; names are fixed at invocation and do not
depend on completion order. Never allocate leaf IDs with a counter shared across concurrent
branches.

`const panel = ctx.within('panel')` binds a context to the current prefix plus `panel/`. It can be
passed to helpers without a prefix argument. Calls inside that view's own scopes or maps retain
those descendant prefixes; calls from unrelated scopes use its lexical prefix. Its `signal` still
reads the current cancellation scope. All six effect methods, events, policies, checkpoint keys, and
local idempotency keys use the full ID.

```ts
const review = ctx.within('round-1');
const results = await review.map(
  'files',
  files,
  { concurrency: 3, key: (file) => ctx.id(file) },
  (file) => review.claude.text('verdict', { prompt: `Review ${file}` }),
);
// round-1/files/<stable-file-segment>/verdict
```

Named maps validate every key and the combined prefix before any mapper starts. Keys must be valid
IDs and unique within the call. Omitting `key` uses the input index; use meaningful keys when
collections can reorder or filter. Checkpoint directory listings or other external inputs even when
using keys. A key stabilizes naming; it does not make unrecorded input durable.

`ctx.id(...parts)` and exported `stepId(...parts)` are pure helpers. Clean parts of at most 64
characters pass through (`ctx.id('a', 3)` gives `a/3`). Other parts, including paths, spaces, `@`,
`+`, `~`, non-ASCII, and leading punctuation, become a slug plus eight hex characters of SHA-256 of
the raw part. Each part remains one segment. Hash suffixes reduce collisions; uniqueness checks
still apply. Full IDs retain the 200-character limit; shorten nesting/labels if that limit is hit.
Errors show bounded full ID, scope, leaf, offending character/index, and the allowed pattern.

The positional `ctx.map(items, concurrency, mapper, options?)` form has been removed; calling it
fails with a message showing the named form. Storage format 7 preserves replay contract 6; flat
format-6 runs migrate automatically, and format-5 records remain inspectable. Moving a workflow from
positional maps to named maps or scopes changes its IDs: use a new run, optionally a deliberate
fork; code acceptance does not rename saved steps.

## Failure handling

Use `onError: 'return'` when a local, agent, command or file failure selects a fallback. It returns
`{ ok: true, value }` or `{ ok: false, error: { message, kind, attempts } }` and saves final
failures as `settled-failed`. Those outcomes replay without another call. Throwing remains the
default; a caught throwing call may heal and change the replay path. Cancellation still rejects.

Use one ID with `retry: { maxAttempts: 3, delayMs: 100, on: ['transient'] }` for transient retries
(`rate-limit`, `overloaded`, `timeout`). Retry policy can change on resume; `onError` is step
identity. Do not race durable operations with `Promise.race`/`Promise.any`: replay may choose a
different winner. Agent `timeoutMs` plus `onError: 'return'` journals a timeout decision.
Signal/poll/deadline races use one `ctx.wait`; arbitrary effect races remain unsupported. See
[failure handling](plugins/agents/quiet-choir/skills/quiet-choir/references/workflow-authoring.md#failure-handling)
for safe fallbacks, best-effort maps, classification limits, and deliberate retry via fork
invalidation.

## Agent concurrency

Each run caps live harness invocations across nested maps, parallel calls and helpers sharing the
context. The default is `min(8, max(1, availableParallelism() - 2))`. `ctx.map` concurrency still
limits mapper bodies locally; nesting can multiply mappers while agents wait for a shared slot.

Use `workflow execute --max-agents 5 --harness-limit codex=1`, or pass
`agentLimit: { total: 5, perProvider: { codex: 1 } }` to `runWorkflow`. To cap several runs
together, pass the same `createAgentLimiter(...)` object to each. Separate CLI processes remain
independent. Only `harness.invoke` holds a slot: local work, replay, sleeps, retries between
attempts and checkpoints do not. Queue time does not consume call `timeoutMs`. Limits can change on
resume; they are not sticky or part of identity. Debug logs expose `agent.queued`/`agent.admitted`
with wait time and live counts. See [agent concurrency](docs/agent-concurrency.md) for cancellation,
eligible FIFO ordering and shared limits.

## Fan-out failure policies

`ctx.map('items', items, { concurrency }, mapper)` drains by default: the first mapper failure stops
scheduling new items, lets started mappers finish and checkpoint without an abort signal, then
rejects with `FanOutError` (`policy: 'drain'`). Its `failures` identify input indexes and
originating step IDs; `unscheduled` lists items never started. Drain can wait for the slowest active
call. A body rejection (for example from `Promise.all`) closes the workflow: effects already started
finish and checkpoint before the run lock is released, but any new launch fails with "Workflow is
closed", including an active mapper's next step and a map started by a still-running branch. To let
sibling branches finish, catch inside each branch or use `Promise.allSettled`.

Pass `cancelSiblings: true` to cancel just that map's subtree after a failure (`policy: 'abort'`).
Catching a failed map allows later workflow steps, and a caught inner-map failure leaves other outer
branches running. `ctx.signal` and each effect's signal refer to the current scope. Run interruption
still cancels all scopes. Interrupted effects have status `cancelled` and `cancelledBy`; the
initiating effect stays `failed`. Inspect `rootCause: { stepId, error, errorKind }` for the run's
cause; handled failures leave `rootCause` null in a completed run. Ctrl-C (or SIGTERM/SIGHUP) is not
a failure: it drains, saves a resumable `suspended` run with `interruptedBy: { reason, at }` and no
root cause, and exits 130; the next `workflow tick` or `resume` continues it. An explicit or
workflow-scoped cancellation saves `cancelled`.

Pass `onError: 'return'` to retain every item's outcome, including mapper-body errors:

```ts
const reviews = await ctx.map('reviews', topics, { concurrency: 3, onError: 'return' }, (topic) =>
  ctx.claude.text('review', { prompt: topic }),
);
const accepted = reviews.flatMap((review) => (review.ok ? [review.value.output] : []));
```

This returns ordered `Settled<U, MapStepError>[]`: failures have
`{ message, kind, attempts, stepId }`. By default it runs every item without cancelling siblings.
With `cancelSiblings: true` as well, the first failure cancels only this map's subtree: started
siblings that resolve anyway keep their value, cancelled ones return `kind: 'cancelled'` with their
cancelled step's ID, and unstarted ones return `kind: 'cancelled'` with `attempts: 0` and a null
`stepId`. Run cancellation, checkpoint failures, and authoring errors still reject. `onError` and
`cancelSiblings` are scheduling policy, outside the map's identity. The full map ID names the
journal and its items prefix leaf IDs. Item inputs, resolved keys, original mapper source, optional
`version`, and cwd define its identity; concurrency can change on resume. Inputs and results must be
lossless JSON. The map snapshots `items` when called; settled mappers receive JSON copies of that
snapshot. Put captured dependencies in items or bump `version`. Resume skips each committed mapper
and its owned effects and returns the saved outcome, so an ordinary mapper-body failure cannot heal
and change a downstream fingerprint. Incomplete items execute again. A change after an item
committed is refused with the changed component named; `--accept-code-change` accepts a mapper-only
change, keeping committed outcomes and running unfinished items with the new mapper. Forks start
fresh map journals and use the normal per-step reuse rules.

## Durable commands and files

Use `ctx.exec` for direct argv commands and `ctx.exec.json` for schema-validated stdout. Commands
have operator privileges. Branch on a failed test with `onError: 'return'`, which saves the failed
exit, signal or timeout, with its exit code and output tails, as a `Settled` result that replays on
resume. A caught throwing command reruns on resume instead. The CLI supplies the process runner,
while embedders inject `new NodeProcessRunner()`. `ctx.readFile` saves a bounded snapshot,
`ctx.writeFile` publishes exact text with a hash-only receipt, and `guardFile` preserves a Git blob
around one journaled mutation body. See [contracts and limits](docs/command-effects.md) and
[verified recipes](plugins/agents/quiet-choir/skills/quiet-choir/references/patterns.md#commands-and-test-verdicts).

## Durable questions

Use `ctx.ask` or `ctx.approve` to keep human decisions attached to the plan and run that requested
them. Active siblings finish before suspension; the CLI saves `suspended`, releases ownership, and
exits 75. `workflow pending --json` and `workflow answer RUN STEP --json VALUE` need no workflow
import. `workflow resume RUN` uses its stored entrypoint. Embedded callers narrow
`WorkflowResult<T>` by `status`, or use `assertCompleted` where suspension is unexpected. See
[question contracts, inbox protocol, and operating examples](docs/questions.md).

## Durability contract

- The workflow body replays from the beginning. Keep orchestration deterministic; put file reads,
  randomness, clocks, network calls, and other effects inside steps. Await every workflow operation.
  The runner drains launched operations and their immediate continuations before releasing the lock.
  Ignored operation failures fail the run even if they settled before the body returned. Awaited and
  caught failures may be handled by the workflow; arbitrary detached async tasks remain the caller's
  responsibility.
- Step IDs are unique within a run, including loop iterations and helper functions. Do not nest
  steps inside a step callback. Compose them with ordinary TypeScript functions at the workflow
  level.
- Terminal outcomes are reused by ID and semantic component hashes (kind, input/prompt, schema,
  onError, model/effort, capabilities, resolved cwd, and local callback source/version). Errors name
  changed components. Timeout, turn, budget, and retry policy do not affect identity. Unfinished
  identities may change with history retained, except question identities are always pinned;
  unvisited unfinished records become `superseded`. Every terminal step must still be visited. An
  early `replay.divergence` event warns before live work when earlier terminal steps or committed
  settled maps remain unvisited; `--strict-replay` aborts there. The final skipped-step and
  skipped-map checks still apply.
- The CLI hashes raw bytes of local compiler-discovered dependencies and the nearest tsconfig under
  real, project-relative paths. Engine `src/`/`dist/` files are excluded (except an explicit
  entrypoint); package/format versions are recorded separately. Inputs, workflow name/version,
  schema fingerprint, and working directory must match on resume. **Bump the workflow version when
  dependency packages, environment/configuration, or other semantics change.** Dynamic imports
  assembled at runtime, external files, and node_modules are not fully fingerprinted.
- Results must be lossless JSON. Undefined, NaN, infinities, negative zero, functions, cycles,
  sparse arrays, getters, and class instances are rejected. Checkpoints contain data, never
  callbacks.
- Runs use an atomic snapshot and an append-only journal with shared durable commits. An exclusive
  local writer owns both; readers apply entries newer than the snapshot sequence. Dead local owners
  can be recovered; live or foreign-host owners are refused. Locks are published and removed by
  rename, and a crashed recoverer's claim is reclaimed automatically. A lock with incomplete
  metadata, a damaged recovery marker or a foreign host that is gone is cleared with
  `workflow unlock RUN` (`--force-remote` for the host), which refuses live owners and children;
  never delete lock directories by hand. Acquiring the lock removes only that run's recognized UUID
  snapshot temporary files. Use a local POSIX filesystem.
- Transient checkpoint writes retry briefly. Persistent storage errors stop new effects and never
  retry a successful action in-process. `CheckpointError` identifies save/release failures; combined
  errors preserve the workflow's original cause. A successfully saved failure is thrown as
  `WorkflowRunError`, with the saved `run`, root `stepId`, and the previous rejection in `cause`. A
  failed save can leave `running` with `error: null`. After a saved completion, a lock directory
  that is already gone, or removal that fails with `EACCES`/`ENOENT` after ownership was verified,
  becomes a returned warning (CLI stderr). Changed ownership and missing or unreadable ownership
  metadata remain fatal. Cleanup warnings are not checkpointed.
- Effects are **at least once**. An external action can succeed without being saved after a crash or
  hard kill. A resolved, validated effect is saved as `completed` even if its signal has just been
  aborted; resume replays it. A rejected effect in an aborted scope is `cancelled` and can repeat on
  resume. Agent calls stopped by cancellation or deadlines may already have edited files. Only
  `ctx.step` callbacks get `idempotencyKey` for deduplication with compatible external systems.
  Native harness conversation state and workspace mutations are not transactional.
- Map and body failures drain started work without signalling cancellation by default. Explicit map
  `abort` affects only that subtree; `ctx.signal` reads the current scope. Run cancellation
  cooperatively aborts every scope and drains before releasing ownership. Local callbacks must
  eventually settle; a callback that ignores cancellation can delay graceful exit indefinitely.
  SIGINT, SIGTERM and SIGHUP request cancellation, drain, and exit 130. A second signal sends
  SIGKILL to every tracked group before exiting 130; it can leave an older checkpoint and lock.
  After SIGKILL or a crash, inspect owner/child liveness. Resume refuses recorded live or unverified
  children (exit 3); `--resume --kill-orphans` stops identity-confirmed groups before replacement
  work. Unknown identities remain for inspection. See
  [process lifecycle](docs/process-lifecycle.md).

This spike has no background scheduler, distributed workers, execution migration, durable event
delivery, or global spending ledger. Worktree isolation is opt-in. Long sleeps suspend by default.
Checkpoints contain plaintext workflow input/output, every completed step's full validated result
(including agent responses and files a step read), and errors. Files are created 0600 and state/lock
directories 0700; existing directory permissions are not repaired. `.quiet-choir/` is gitignored
only in this repository; exclude chosen storage in other projects too.

## Harness defaults and limits

The core resolves named [agent profiles](docs/agent-profiles.md) before invoking a harness. The
implicit `text` profile is tool-less for Claude, read-only for Codex, and limited to five minutes,
10 Claude turns and $0.50 per Claude call. `readonly` grants file-reading tools; `edit` adds writing
and requires an operator grant. Declare roles on `defineWorkflow`, select with `profile`, and use
`--grant role` at launch. Raw call-site tools/sandbox are rejected under default `strictProfiles`.
`tools` implies `allowedTools` unless explicitly narrowed. Claude defaults to `dontAsk`; allowed
rules add to applicable native permissions. Codex uses approval policy `never`. Restricted Claude
calls suppress inherited hooks/MCP; explicit opt-ins and managed policy still apply. Retained
protocol data is capped at 8 MiB; Codex has no per-call USD cap here. Model selection is explicit or
uses the selected configuration mode’s native defaults. Both providers accept
`effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'`; Codex `effort` additionally accepts `none`
and `minimal`. Omission uses the selected mode’s native defaults.
[Harness controls](docs/harness-controls.md) describes role prompts, agents, MCP, native
profiles/config, directories, image attachments and the fingerprinted `extraArgs`/`env` escape
hatch. `configuration doctor --json` verifies installed CLI contracts with zero-inference rejection
probes and reports inherited Codex defaults. Run metadata captures native CLI versions on first live
use, plus the instruction files Codex loads in every mode (paths and digests); a resume version
change warns without invalidating completed work. Native output is parsed incrementally:
`--progress` prints bounded activity to stderr and early session IDs are saved while the child runs.
Independent CLI-settable caps bound retained protocol data, raw streams (1 GiB), and private
per-attempt transcripts (64 MiB). Use `--transcripts on-failure` or `off` to change retention.
Failed attempts preserve available response/usage/schema evidence. See
[agent streaming](docs/agent-streaming.md) for flags, transcript decoding, and upgrade
compatibility. A stopped call may already have edited files.

Prompts go over stdin without a shell after durable process registration. Every exit reaps the owned
process group on macOS/Linux; Windows cleanup reaches the immediate child only. Output drains for at
most two seconds after leader exit, independently of inherited pipes. Cleanup uses a three-second
TERM grace (`--kill-grace-ms`) before KILL and a 500ms settlement backstop. These flags do not
sandbox the workflow's own TypeScript. Configuration mode defaults to `restricted` and enters
identity before invocation. An explicit `inherit` role can load project settings/hooks selected by
`cwd`; headless Claude skips the trust dialog, so never use inherited calls on untrusted checkouts.
Host-session variables are scrubbed in both modes; `env.set`/`env.unset` apply afterward. Saved
environment diagnostics contain names and digests, never values. See the
[provider boundaries and verified risks](docs/harness-isolation.md).

Saved harness errors include reasons recovered from stdout on both zero and nonzero normal exits,
with bounded stderr and exit metadata. A bare exit error means no usable protocol reason was found;
check `claude auth status` / `codex login status`, schemas, and the invocation flags. Failed
protocol attempts can retain usage/session metadata; this is still an incomplete spending ledger.
Claude token totals now come from `modelUsage`, including uncached input, cache reads and writes;
Codex retains its total input and all cache/reasoning fields. Missing categories and Codex cost stay
null. `summarizeUsage(run)` and inspection include every recorded attempt, unknown counts, and
harness/model breakdowns. `workflow inspect ID --json` adds `usageSummary`. Use `--max-run-cost-usd`
and `--max-run-agent-attempts` to gate new calls across resumes. These sticky caps drain admitted
work and fail the run when tripped; raise them on resume or use `off` to clear one. In-flight calls
can overshoot reported cost. `--max-window-utilization <0..1>` is a third sticky cap on the Claude
subscription windows: it refuses new calls while the latest reported window is at or above the cap
and suspends the run (exit 75) until the window resets, so `workflow tick` resumes it then. See
[usage and budgets](docs/usage-and-budgets.md).

## Additional harnesses and service helpers

A package exports `defineHarness({ name, revision, options, capabilities, createAdapter })`. Declare
it in `defineWorkflow({ harnesses: [third], ... })`, then use `ctx.agent('third')` with inferred
options. Text-only registrations have no structured method. `ctx.claude` and `ctx.codex` remain
available. Operator adapters override the compatibility catch-all, which overrides factories;
completed replay constructs no adapter. Package revisions make changed option semantics explicit.

The CLI accepts `--harness-config '{"harnesses":{"third":{"binary":"third-cli"}}}'` (or `@file` /
`QUIET_CHOIR_HARNESS_CONFIG`) and repeated `--harness third=fixture:FILE` overrides. Relative
`harnesses.claude.binary` and `harnesses.codex.binary` paths resolve against the command cwd.
`configuration doctor --workflow FILE` lists trusted registrations and runs optional zero-inference
probes. `quiet-choir/harness-kit` supplies process ownership, fake binaries, the adapter conformance
suite, and the JSONL framing, environment scrub, session/output/progress plumbing, output-limit
error and prompted structured output the built-in adapters use
([ADR 0043](docs/decisions/0043-checked-harness-kit-declarations-and-adapter-helpers.md)).
Additional service operations use one ordinary effect per helper call; the transport-injected
`quiet-choir/decision` reference preserves answers and probability distributions. See
[the integration decision](docs/decisions/0027-typed-harness-registry-and-integration-helpers.md).
`quiet-choir/github` reads repositories, pull requests, review threads, issues and code-scanning
alerts through the installed `gh`, one `ctx.exec.json` per read, and throws instead of returning a
truncated list. Its head-pinned waits for CI, reviewers (Codex, CodeQL or your own) and merges are
one `ctx.poll` each. Its writes (comments, thread replies, issue create, close and reopen, alert
dismissals, pull request create and edit, a merge pinned to a head SHA, failed-run reruns) are one
`ctx.step` each and reconcile with a marker or a preceding read, so a rerun after a crash does not
write twice (failed-run reruns hold this only for runs at the attempt baseline). Its epic snapshot
reads an epic's sub-issues (or its checklist) in one command, and the pure `nextTicket` picks the
next ticket and says why every other open one was skipped; see
[GitHub reads, waits and writes](docs/github.md).

## Progress and monitoring

Use `ctx.phase('verify', { total: 27 })` and `ctx.log('Checked inputs', { count: 12 })` for
persisted observations. `await ctx.phase('verify', async () => { /* work */ }, { total: 27 })`
isolates a concurrent phase. These calls have no effect IDs or fingerprints; repeated entries echo
with `(replay)` on resume. Steps retain phase, timing, resolved request summaries, stacks, and
per-attempt usage. Records also retain body executions and the most recent 500 lifecycle/phase/log
entries.

`workflow inspect ID` shows progress, first-use-ordered active/failed steps, root cause, usage, and
owner liveness. Add `--json --summary` for the same compact data, `-v` for saved stacks, or
`--watch --interval 2s` to wait for completion. Watch emits JSONL per change in JSON mode and exits
0/1/75/130/3 for completed/failed/suspended/cancelled/stale. `--timeout 9m` bounds a watch (exit 79,
`watch.timeout`; the run keeps running), `--wait-created 30s` waits for a record that is about to
appear (exit 66, `watch.record_not_created`, when it never does), and `--final` prints only the last
line. `workflow list --status stale --json` finds abandoned runs without importing their source.
Read [run observability](docs/observability.md) for replay, retention, partial usage, prompt-preview
privacy, and watch semantics.

## CLI and development

```sh
npm run cli -- workflow typecheck examples/local.workflow.ts
npm run --silent cli -- workflow validate examples/local.workflow.ts --json
npm run --silent cli -- workflow inspect recovery --state-dir "$qc_recovery_state_dir" --json
npm run check
```

The inspection command reuses the earlier recovery example's state directory. `npm run cli` runs
`dist/`; rebuild after changing `src/`. `cli:dev` also discovers `dist/commands`, because the
current tsconfig lacks a `rootDir`/`outDir` mapping for oclif. The nearest tsconfig in or above a
workflow applies and is fingerprinted; under this checkout, unused variables can block execution.

`execute` typechecks before importing the workflow. `validate` typechecks and verifies its export
contract without calling `run`; importing either command's workflow **executes module top-level
code**. `typecheck` performs no imports or effects. `inspect` reads a saved run without importing
workflow code. A missing run reports the absolute storage directory and available run IDs. Use
`--state-dir PATH` for alternate storage. With `--json`, validate, execute, inspect, typecheck, and
check-resume emit exactly one JSON document on stdout, including argument and execution errors.
`inspect --watch --json` is the JSONL exception; `--summary` selects its compact dashboard data.
Success has one shape per command: a compact result for execute, resume and `answer --resume`
(`{kind:"workflow.run.result", ok, exitCode, runId, stateDir, status, output, usage, counts, rootCause, warnings}`;
pass `--full` for the whole run record plus `stateDir`), a run record plus current `ownership` for
inspect, metadata for validate, a compiler result for typecheck, and `{kind, ok, check}` for a
compatible check-resume. Workflow `console.log` and `process.stdout.write` output during import and
execution is redirected to stderr; execution logs and `Run ID:` remain there. Use
`npm run --silent cli -- … --json` to suppress npm's own banner.

Failures include
`{kind:"workflow.error", ok:false, exitCode, error:{code,message,stepId,details}, runId,stateDir,status,failedSteps,diagnostics,summary}`.
For execute, resume and answer, `summary` is the compact result of the saved run or null, and `run`
(the actual saved record or null) replaces it under `--full` and in every other command's failure;
generated IDs are included. `error.stepId` identifies the root failing effect, not a cancelled
sibling; body errors and interrupts use null. Run IDs are validated before typechecking or importing
workflow code. `--input` accepts inline JSON, `@path/to/input.json`, or `-` for stdin; parse errors
name their source and zero-based character position. See [CLI contract](docs/cli-contract.md).

Validate reports the same full source/schema/engine fingerprint that a new run stores.
`workflow check-resume FILE --run-id ID --json` reports run compatibility and changed components
without acquiring a writer lock or executing the workflow body. It still imports trusted top-level
code and does not predict dynamic step compatibility. Incompatibility returns exit 3 and the
comparison in `error.details`; loading failures return exit 4.

Inherited `--log-level trace|debug|info|warn|error|fatal|silent` and `-v, --verbose` go after the
command name and are mutually exclusive. `configuration doctor` is the only configuration command;
layered project/user settings are deferred.

| Exit | Meaning                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Success. Inspect accepts any readable status; check `.status`. After a first signal, only a saved execute/resume completion or a delivered `workflow answer` exits 0.                                                                                                                      |
| 1    | `workflow.failed`: execution failed and the failure checkpoint was saved. Fix and resume. A saved `failed` run reports this even when a signal arrived.                                                                                                                                    |
| 2    | `answer.invalid` for invalid answers, or `usage.*`: invalid flags, misplaced flags, omitted/nonexistent/unsupported FILE, invalid run ID, invalid input JSON/file/schema, or resume without an ID. No execution checkpoint is written.                                                     |
| 3    | `answer.conflict` for duplicate/closed questions, or `run.*`: existing/missing/locked/unreadable run, incompatible resume, changed input, surviving/unverified child processes (`run.orphans`), or a `workflow cancel` that found no live owner (`run.unowned`). No workflow body runs.    |
| 4    | `load.*`: typecheck, import, or workflow-definition failure. No execution checkpoint is written.                                                                                                                                                                                           |
| 74   | `workflow.storage`: saving, process registration, or releasing ownership failed. Inspect the reported saved state; it can still be `running`, `completed`, or absent.                                                                                                                      |
| 75   | Saved suspension: `workflow.run.suspended` with pending waits and answer/resume commands. A saved suspension stands even when a signal arrived.                                                                                                                                            |
| 130  | `workflow.interrupted`: SIGINT/SIGTERM/SIGHUP. A first signal saves a resumable `suspended` run (`interruptedBy`) when possible. A second kills tracked groups at once and reports the last readable checkpoint, maybe `running`. An owner stopped by `workflow cancel` saves `cancelled`. |

`npm run check` includes formatting, lint, strict typechecking, tests with coverage gates, build,
compiled CLI smoke tests, TypeDoc validation, and package checks. No automated test calls a paid
harness. Structured-output success paths for both adapters completed live with claude 2.1.283 and
codex-cli 0.157.1; this is evidence for those versions, not a guarantee.

Read [Architecture](docs/architecture.md), the
[durability decision](docs/decisions/0002-durable-external-workflows.md), and
[Claude API research](docs/research.md) for the reasoning and evidence behind the spike. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for repository conventions.

## Workflow comparison lab

The [Workflow Lab](comparisons/README.md) contains versioned, side-by-side comparisons of 26
original Claude Code workflows and their direct Quiet Choir ports. It includes per-workflow notes,
inert equivalence fixtures, and the source for the privately published comparison site.

## License

[MIT](LICENSE)
