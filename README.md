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

The CLI prints the run ID before executing. Without `--run-id`, it generates one. Reusing an
existing ID requires `--resume`; a completed run returns its saved output without calling any
harness. Keep the absolute state directory for inspection and resume.

The CLI launch directory becomes the recorded run `cwd`, the base for relative FILE and
`--state-dir` paths, the default `.quiet-choir/runs`, and agent calls' relative `cwd`. Resume must
use that same directory; there is no `--cwd` flag. `npm run cli --` launches from this checkout even
when run in a subdirectory. For work in another project, change to that project and invoke
`node /absolute/path/to/quiet-choir/bin/run.js workflow …`, or use `npx --no-install quiet-choir`
where the package is already installed. An agent option's absolute `cwd` is accepted without
confinement and must name an existing directory.

## Author a workflow

Workflows default-export `defineWorkflow(...)`. Input, final output, and structured agent responses
use [Zod](https://zod.dev/) schemas for TypeScript inference and runtime validation. Callback return
types also affect inference: a wider `T | undefined` can typecheck, then fail final validation after
paid calls. An explicit `Promise<z.infer<typeof Output>>` return annotation or `ctx.step<string>(…)`
can catch that mistake earlier.

```ts
import { defineWorkflow, z } from 'quiet-choir';

export default defineWorkflow({
  name: 'review-label',
  version: '1',
  input: z.object({ topic: z.string() }),
  output: z.object({ label: z.string(), accepted: z.boolean() }),
  async run(ctx, input) {
    const proposal = await ctx.claude.object('propose', {
      prompt: `Suggest a short label for: ${input.topic}`,
      model: 'haiku',
      schema: z.object({ label: z.string() }),
    });
    const review = await ctx.codex.object('review', {
      prompt: `Is this label clear? ${proposal.output.label}`,
      schema: z.object({ accepted: z.boolean() }),
    });
    return { label: proposal.output.label, accepted: review.output.accepted };
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
inherit their authentication and configuration; no separate provider API key is required. The source
examples import `../src/index.js` so they work directly in this private repository. An installed
consumer imports `quiet-choir` as above.

## Operations

| API                                                           | Behavior                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ctx.claude.text(id, options)`                                | Durable Claude text result                                                    |
| `ctx.claude.object(id, { schema, ...options })`               | Durable, validated Claude structured result                                   |
| `ctx.codex.text` / `ctx.codex.object`                         | Equivalent Codex APIs with Codex-specific options                             |
| `ctx.step(id, { input, schema, run, retry? })`                | Checkpoint a local effect; explicit dependencies detect replay drift          |
| `ctx.map(id, items, { concurrency, key?, onError? }, mapper)` | Bounded fan-out; each item prefixes explicit leaf IDs with its map ID and key |
| `ctx.sleep(id, milliseconds)`                                 | Persist a wake time and wait only the remaining time after resume             |

Agent results contain `output`, native `sessionId`, and reported token/cost `usage`. Native session
IDs are for correlation only: `CliHarness` uses Claude `--no-session-persistence` and Codex
`--ephemeral`, so these calls have no persisted local session transcript. Each effect starts fresh.
`object` sends JSON Schema to the harness and validates the returned JSON locally. Codex defaults to
`structuredOutput: 'compat'`: optional properties become nullable on the wire, non-object roots are
wrapped, records use key/value entries (enum-keyed records require all keys), discriminated unions
use `anyOf`, and loose objects are closed. The adapter reverses these encodings before the original
Zod validation; nullable optionals retain null, while other optional nulls become absent properties.
Unknown keys are not requested for loose objects. Tuples, and unions mixing a string-keyed record
with an array, are rejected locally; use named object properties or discriminated objects.

Choose `structuredOutput: 'strict'` to send a native Codex schema: use an object root, make every
property required (use `.nullable()` for missing values), and avoid records, loose objects,
discriminated unions, and tuples. `checkCodexSchema(schema)` returns JSON paths and fixes before a
workflow runs. `workflow validate` cannot inspect call-site schemas without running the body.
Refinements are enforced locally, so repeat them in the prompt. Schema transforms and class-valued
schemas cannot be converted to JSON Schema. `z.date()`, `z.void()`, `z.undefined()`, and
`z.bigint()` also fail conversion when their operation runs; `validate` checks only workflow
input/output. Use `z.null()` and return `null` for side-effect-only steps. Claude receives the
original schema and also requires an object root; other Codex restrictions and wire transforms do
not apply to it.

A local effect might use `ctx.step('read', { input: { path }, schema: z.string(), run: ... })`.
Callbacks receive `{ signal, attempt, idempotencyKey }`. Opt into retries only for repeatable
effects, with `retry: { maxAttempts: 3, delayMs: 100 }`; delays double up to 30 seconds. Agent
effects also accept explicit retry policies; the default is one attempt. A later explicit resume
retries unfinished effects, including failed agent calls. `ctx.runId` and `ctx.signal` expose run
identity and cancellation. Only local callbacks receive `idempotencyKey`; agent calls have none and
can repeat edits. Step dependencies, prompts, and identity options are stored as component hashes,
alongside the full validated result. Resolved policy, requested model/effort, and provenance are
recorded per attempt.

For embedding, call `runWorkflow(definition, { runId, input, harness: new CliHarness() })`. Its
output is typed from the workflow schema. Supply `signal`, `stateDir`, `cwd`, `onEvent`, and a code
`fingerprint` as needed. The core depends on a `Harness` interface, so tests and alternative
integrations can replace subprocesses without changing workflows. Read the saved record with
`readRun({ runId, cwd, stateDir })`; both APIs default to `<cwd>/.quiet-choir/runs` and resolve a
relative `stateDir` against `cwd`. `resolveStateDir({ cwd, stateDir })` returns that absolute path.
An `onEvent` observer may return `void` or `Promise<void>`; it is not awaited, and both synchronous
throws and rejected promises are ignored.

Explicit agent options are validated before recording the step, using the exported
`claudeOptionsSchema` and `codexOptionsSchema` also used by `CliHarness`. Top-level undefined option
values are omitted. Other invalid JSON names the step and offending JSON path. Embedded callers can
correct an invalid option and resume when no step was recorded; CLI source edits still change the
workflow fingerprint. Call-site validation runs during execution, not during `workflow validate`.

To recover a timeout without editing CLI workflow source, resume with a sticky policy override:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --resume \
  --policy '{"match":"review","timeoutMs":600000}'
```

Use the original launch directory, state path, and absolute `QC_CHECKOUT`. Completed steps replay;
only unfinished calls use the new deadline. Repeat `--policy` for ordered rules; later matching
fields win over call-site options and adapter defaults. `--policy-reset` clears saved rules. A bare
resume retains them. `model` and `reasoningEffort` overrides require `--allow-model-override` when
added; completed calls never rerun because of policy. Embedded callers use `RunOptions.policy`,
`policyReset`, and `allowModelOverride`, or edit call-site limits without changing their source
fingerprint. Globs use `*` within segments and `**` across `/`.

The implicit `text` profile supplies a five-minute deadline, 10 Claude turns and a $0.50 per-call
budget. `readonly` and `edit` supply larger limits. Custom harnesses receive those resolved options,
must enforce them, and can report adapter-specific defaults through `policyDefaults(provider)`. See
[agent profiles and launch grants](docs/agent-profiles.md) for declarations, `--profile` recovery,
and strict capability checks. `inspect --json` exposes saved rules and each step's `attemptHistory`,
including resolved policy and its sources. New checkpoints use version 5. Versions 1, 2, 3, and 4
remain inspectable but cannot resume or supply fork reuse with this runtime; retain the original
runtime or choose a new run ID. See
[the policy decision](docs/decisions/0005-step-identity-and-policy.md).

To recover after editing workflow code, choose an explicit reuse path:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow check-resume review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --json
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-2 --state-dir "$qc_state_dir" --fork-from review-1
# Or accept a tail-only fix on the original run:
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --resume --accept-code-change
```

Forks preserve the source checkpoint and default to reusing the unchanged launch prefix. The first
miss ends reuse; later effects run live. `--reuse matching` explicitly reuses all matching terminal
IDs, which requires accounting for undeclared workspace dependencies. Repeat
`--invalidate 'path/**'` to force effects live. Forks inherit source input when omitted, accept new
explicit input/version, and require the same workflow name. Inspect `forkedFrom` and each copied
step's `reusedFrom` for provenance. Resume the target normally after interruption; source changes
close further reuse.

`--accept-code-change` waives only source/run-schema gates, keeping name/version, engine, cwd,
validated input, terminal-step identity, and replay checks. Each use that actually changes code,
schemas, or files is recorded in `codeChanges`. A tail/output fix can finish with zero repeated
effects. Local step identity now hashes callback source and optional `version` as well as
input/schema/cwd. The CLI loader removes callback comments and formatting; captured values, helper
implementations, native/bound functions, and environment remain invisible. Declare dependencies in
input, bump the step version, or invalidate in a fork. See
[the recovery decision](docs/decisions/0006-code-change-recovery.md).

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

The deprecated `ctx.map(items, concurrency, mapper, options?)` form adds no item prefix. Existing
unscoped IDs and format-5 checkpoints remain compatible. Its settled form still requires an explicit
`options.id` for the journal. Adopting named maps or scopes changes IDs: use a new run, optionally a
deliberate fork; code acceptance does not rename saved steps.

## Failure handling

Use `onError: 'return'` when a local or agent failure selects a fallback. It returns
`{ ok: true, value }` or `{ ok: false, error: { message, kind, attempts } }` and saves final
failures as `settled-failed`. Those outcomes replay without another call. Throwing remains the
default; a caught throwing call may heal and change the replay path. Cancellation still rejects.

Use one ID with `retry: { maxAttempts: 3, delayMs: 100, on: ['rate-limit', 'timeout'] }` for
transient retries. Retry policy can change on resume; `onError` is step identity. Do not race
durable operations with `Promise.race`/`Promise.any`: replay may choose a different winner. Agent
`timeoutMs` plus `onError: 'return'` journals a timeout decision. Durable races are deferred to #57.
See
[failure handling](plugins/agents/quiet-choir/skills/quiet-choir/references/workflow-authoring.md#failure-handling)
for safe fallbacks, best-effort maps, classification limits, and deliberate retry via fork
invalidation.

## Agent concurrency

Each run caps live harness invocations across nested maps, parallel calls and helpers sharing the
context. The default is `min(8, max(1, availableParallelism() - 2))`. `ctx.map` concurrency still
limits mapper bodies locally; nesting can multiply mappers while agents wait for a shared slot.

Use `workflow execute --max-agents 5 --provider-limit codex=1`, or pass
`agentLimit: { total: 5, perProvider: { codex: 1 } }` to `runWorkflow`. To cap several runs
together, pass the same `createAgentLimiter(...)` object to each. Separate CLI processes remain
independent. Only `harness.invoke` holds a slot: local work, replay, sleeps, retries between
attempts and checkpoints do not. Queue time does not consume call `timeoutMs`. Limits can change on
resume; they are not sticky or part of identity. Debug logs expose `agent.queued`/`agent.admitted`
with wait time and live counts. See [agent concurrency](docs/agent-concurrency.md) for cancellation,
eligible FIFO ordering and shared limits.

## Fan-out failure policies

`ctx.map('items', items, { concurrency }, mapper)` defaults to `onError: 'drain'`: the first mapper
failure stops scheduling new items, lets started mappers finish and checkpoint without an abort
signal, then rejects with `FanOutError`. Its `failures` identify input indexes and originating step
IDs; `unscheduled` lists items never started. Drain can wait for the slowest active call. A body
rejection (for example from `Promise.all`) closes the workflow: effects already started finish and
checkpoint before the run lock is released, but any new launch fails with "Workflow is closed",
including an active mapper's next step and a map started by a still-running branch. To let sibling
branches finish, catch inside each branch or use `Promise.allSettled`.

Pass `{ onError: 'abort' }` to cancel just that map's subtree after a failure. Catching a failed map
allows later workflow steps, and a caught inner-map failure leaves other outer branches running.
`ctx.signal` and each effect's signal refer to the current scope. Run interruption still cancels all
scopes. Interrupted effects have status `cancelled` and `cancelledBy`; the initiating effect stays
`failed`. Inspect `rootCause: { stepId, error }` for the run's cause. Ctrl-C records a null step ID
and `Workflow interrupted.`; handled failures leave `rootCause` null in a completed run.

Use an explicitly named settled map to retain every item's outcome, including mapper-body errors:

```ts
const reviews = await ctx.map('reviews', topics, { concurrency: 3, onError: 'settle' }, (topic) =>
  ctx.claude.text('review', { prompt: topic }),
);
const accepted = reviews.flatMap((review) => (review.ok ? [review.value.output] : []));
```

This returns ordered `Settled<U, MapStepError>[]`: failures have
`{ message, kind, attempts, stepId }`. It runs every item without cancelling siblings; cancellation,
checkpoint failures, and authoring errors still reject. The full map ID names the journal and its
items prefix leaf IDs. Item inputs, resolved keys, original mapper source, optional `version`, and
cwd define its identity; concurrency can change on resume. Inputs and results must be lossless JSON.
The map snapshots `items` when called; settled mappers receive JSON copies of that snapshot. Put
captured dependencies in items or bump `version`. Resume skips each committed mapper and its owned
effects and returns the saved outcome, so an ordinary mapper-body failure cannot heal and change a
downstream fingerprint. Incomplete items execute again. Forks start fresh map journals and use the
normal per-step reuse rules.

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
  identities may change with history retained; unvisited unfinished records become `superseded`.
  Every terminal step must still be visited. An early `replay.divergence` event warns before live
  work when earlier terminal steps or committed settled maps remain unvisited; `--strict-replay`
  aborts there. The final skipped-step and skipped-map checks still apply.
- The CLI hashes raw bytes of local compiler-discovered dependencies and the nearest tsconfig under
  real, project-relative paths. Engine `src/`/`dist/` files are excluded (except an explicit
  entrypoint); package/format versions are recorded separately. Inputs, workflow name/version,
  schema fingerprint, and working directory must match on resume. **Bump the workflow version when
  dependency packages, environment/configuration, or other semantics change.** Dynamic imports
  assembled at runtime, external files, and node_modules are not fully fingerprinted.
- Results must be lossless JSON. Undefined, NaN, infinities, negative zero, functions, cycles,
  sparse arrays, getters, and class instances are rejected. Checkpoints contain data, never
  callbacks.
- Checkpoints use flushed temporary files, atomic rename, and an exclusive local writer lock. Dead
  local owners can be recovered; live or foreign-host owners are refused. Incomplete lock metadata
  or an abandoned recovery requires inspection and manual cleanup. Acquiring the lock removes only
  that run's abandoned `<runId>.json.<uuid>.tmp` files. Use a local POSIX filesystem.
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

This spike has no background scheduler, distributed workers, execution migration, human-approval
inbox, durable event delivery, global spending ledger, or automatic worktree isolation. Sleep waits
in the current process. Checkpoints contain plaintext workflow input/output, every completed step's
full validated result (including agent responses and files a step read), and errors. Files are
created 0600 and state/lock directories 0700; existing directory permissions are not repaired.
`.quiet-choir/` is gitignored only in this repository; exclude chosen storage in other projects too.

## Harness defaults and limits

The core resolves named [agent profiles](docs/agent-profiles.md) before invoking a harness. The
implicit `text` profile is tool-less for Claude, read-only for Codex, and limited to five minutes,
10 Claude turns and $0.50 per Claude call. `readonly` grants file-reading tools; `edit` adds writing
and requires an operator grant. Declare roles on `defineWorkflow`, select with `profile`, and use
`--grant role` at launch. Raw call-site tools/sandbox are rejected under default `strictProfiles`.
`tools` implies `allowedTools` unless explicitly narrowed. Claude defaults to `dontAsk`; allowed
rules add to inherited settings permissions. Codex uses approval policy `never`. MCP tools and hooks
can still load from configuration. The combined output cap is 8 MiB; Codex has no per-call USD cap
here. Model selection is explicit or inherited from the installed harness. Both providers accept
`effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'`; Codex `reasoningEffort` additionally accepts
`none` and `minimal`. Set one effort field, never both. Omission inherits native configuration.
[Harness controls](docs/harness-controls.md) describes role prompts, agents, MCP, native
profiles/config, directories, image attachments and the fingerprinted `extraArgs`/`env` escape
hatch. `configuration doctor --json` verifies installed CLI contracts with zero-inference rejection
probes and reports inherited Codex defaults. Run metadata captures native CLI versions on first live
use; a resume version change warns without invalidating completed work. The byte cap counts the
whole stdout/stderr stream, including command output; CLI runs cannot raise it, while embedders can
set `CliHarnessOptions.maxOutputBytes`. A call may hit the cap after editing files.

Prompts go over stdin without a shell after durable process registration. Every exit reaps the owned
process group on macOS/Linux; Windows cleanup reaches the immediate child only. Output drains for at
most two seconds after leader exit, independently of inherited pipes. Cleanup uses a three-second
TERM grace (`--kill-grace-ms`) before KILL and a 500ms settlement backstop. These flags do not
sandbox the workflow's own TypeScript or isolate inherited hooks, MCP servers, and harness
configuration. Use trusted workflow files and a working directory/configuration suitable for the
task. Claude's `cwd` selects project `.claude/` settings and hooks; `claude -p` skips the trust
dialog, so hooks can run in never-trusted directories.

Saved harness errors include reasons recovered from stdout on both zero and nonzero normal exits,
with bounded stderr and exit metadata. A bare exit error means no usable protocol reason was found;
check `claude auth status` / `codex login status`, schemas, and the invocation flags. Failed
protocol attempts can retain usage/session metadata; this is still an incomplete spending ledger.
Claude's input count is the top-level field, excluding cache reads/writes and not summing
`modelUsage`; Codex's cache-inclusive interpretation is inferred, not verified by a live cache
comparison. Do not compare those input counts directly. Codex cost is null; Claude cost uses
`total_cost_usd`.

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
Success keeps the existing result shape: a run record for execute/inspect (plus current `ownership`
for inspect), metadata for validate, a compiler result for typecheck, and `{kind, ok, check}` for a
compatible check-resume. Workflow `console.log` and `process.stdout.write` output during import and
execution is redirected to stderr; execution logs and `Run ID:` remain there. Use
`npm run --silent cli -- … --json` to suppress npm's own banner.

Failures include
`{kind:"workflow.error", ok:false, exitCode, error:{code,message,stepId,details}, runId,stateDir,status,failedSteps,diagnostics,run}`.
The run is the actual saved record or null; generated IDs are included. `error.stepId` identifies
the root failing effect, not a cancelled sibling; body errors and interrupts use null. Run IDs are
validated before typechecking or importing workflow code. `--input` accepts inline JSON,
`@path/to/input.json`, or `-` for stdin; parse errors name their source and zero-based character
position. See [CLI contract](docs/cli-contract.md).

Validate reports the same full source/schema/engine fingerprint that a new run stores.
`workflow check-resume FILE --run-id ID --json` reports run compatibility and changed components
without acquiring a writer lock or executing the workflow body. It still imports trusted top-level
code and does not predict dynamic step compatibility. Incompatibility returns exit 3 and the
comparison in `error.details`; loading failures return exit 4.

Inherited `--log-level trace|debug|info|warn|error|fatal|silent` and `-v, --verbose` go after the
command name and are mutually exclusive. Configuration commands remain explicit stubs (exit 2);
layered project/user settings are deferred.

| Exit | Meaning                                                                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Success. Inspect accepts any readable status; check `.status`. After a first signal, only a saved execute completion exits 0.                                                                                                  |
| 1    | `workflow.failed`: execution failed and the failure checkpoint was saved. Fix and resume. A saved `failed` run reports this even when a signal arrived.                                                                        |
| 2    | `usage.*`: invalid flags, misplaced flags, omitted/nonexistent/unsupported FILE, invalid run ID, invalid input JSON/file/schema, or resume without an ID. No execution checkpoint is written.                                  |
| 3    | `run.*`: existing/missing/locked/unreadable run, incompatible resume, changed input, or surviving/unverified child processes (`run.orphans`). No workflow body runs.                                                           |
| 4    | `load.*`: typecheck, import, or workflow-definition failure. No execution checkpoint is written.                                                                                                                               |
| 74   | `workflow.storage`: saving, process registration, or releasing ownership failed. Inspect the reported saved state; it can still be `running`, `completed`, or absent.                                                          |
| 75   | Reserved for suspended execution; not emitted yet.                                                                                                                                                                             |
| 130  | `workflow.interrupted`: SIGINT/SIGTERM/SIGHUP. Graceful cancellation saves `cancelled` when possible. A second signal kills tracked groups immediately and reports the last readable checkpoint, which may still be `running`. |

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
