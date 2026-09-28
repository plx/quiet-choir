# Workflow authoring

## Define a workflow

Default-export `defineWorkflow({ name, version, input, output, run })`. Schemas alone infer
TypeScript input/output types and validate data at runtime. Callback return types cannot widen a
workflow or step's schema contract. Never cast the output schema: write the actual shape, or use
`z.json()` without a cast. Zero-parameter callbacks returning literals may need `as const`,
especially async local steps. This example can be saved under `examples/` in a checkout:

```ts
import { defineWorkflow, z } from '../src/index.js';

export default defineWorkflow({
  name: 'labels',
  version: '1',
  input: z.object({ topics: z.array(z.string()).max(10) }),
  output: z.object({ labels: z.array(z.string()) }),
  async run(ctx, input) {
    const labels = await ctx.map('labels', input.topics, { concurrency: 2 }, async (topic) => {
      const result = await ctx.claude.value('label', {
        prompt: `Suggest a short label for this topic: ${topic}`,
        schema: z.object({ label: z.string() }),
      });
      return result.label;
    });
    return { labels };
  },
});
```

In a consumer project, import from `quiet-choir` after installing the runtime. In source checkouts,
adjust the relative path to `src/index.js` for the workflow's actual location; keep the `.js`
suffix.

`name` and `version` must be nonempty. Version is an explicit compatibility string, not necessarily
semver. Change it when semantics change, including external dependencies/configuration; a changed
version requires a new run ID (a fork can reuse compatible steps). See [durability](durability.md).

## Durable operations

| Operation                                                                          | Return and composition                                                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ctx.step(id, { input, schema, run, retry?, version?, onError? })`                 | Validated result; stores that result and hashes of input, schema, callback source, version, and cwd |
| `ctx.claude.value(id, { schema?, ...options })` / Codex equivalent                 | Schema-inferred output; plain string without a schema                                               |
| `ctx.claude.text(id, options)` / `ctx.codex.text(id, options)`                     | `{ output: string, sessionId, usage }`                                                              |
| `ctx.claude.object(id, { schema, ...options })` / Codex equivalent                 | Same wrapper with schema-inferred `output`                                                          |
| `ctx.map(id, items, { concurrency, key?, onError? }, mapper)`                      | Ordered fan-out with per-item prefixes and optional outcome journal                                 |
| `ctx.ask(id, { prompt, schema, details?, choices?, audience?, subject?, title? })` | Durable schema-validated external answer; a quiescent run suspends                                  |
| `ctx.approve(id, options)`                                                         | `{ approved: boolean, comment?: string }`; fixed-schema question                                    |
| `ctx.now(id)`                                                                      | Recorded clock anchor                                                                               |
| `ctx.wait(id, sources)`                                                            | One replayed signal/poll/deadline outcome                                                           |
| `ctx.sleepUntil(id, epochMs)`                                                      | Absolute deadline from input or recorded time                                                       |
| `ctx.poll(id, options)`                                                            | Read-only observations with a finite bound                                                          |
| `ctx.sleep(id, milliseconds)`                                                      | `null`; pins a relative deadline, with long waits suspending                                        |
| `ctx.runId`                                                                        | Stable run identifier                                                                               |
| `ctx.signal`                                                                       | Current scope signal; inherits run and parent-map cancellation                                      |

Call-site task prompts and identity options are stored as component hashes. Resolved execution
policy and requested model/effort are stored in plaintext per attempt. Profile declarations are
saved in the capability manifest, including role prompts and settings. Explicit environment values
are omitted; names and digests remain. Keep rotating secrets in the parent environment; inspection
cannot reconstruct hashed call-site prompts.

Agent operations are already durable: call them directly from the workflow, not from inside
`ctx.step`. Local `run` receives `{ signal, attempt, idempotencyKey }`. `attempt` is the total
persisted count across retries and resumes; `idempotencyKey` is the stable `runId/stepId` string.
Pass the signal to cancellable I/O and the key to external systems that support deduplication.

For example, inside a workflow that imports `readFile` from `node:fs/promises`:

<!-- skills-check: fragment; reason: Workflow-body pattern with ctx, schemas, and surrounding definition omitted. -->

```ts
const contents = await ctx.step('read-source', {
  input: { path: input.path },
  schema: z.string(),
  run: ({ signal }) => readFile(input.path, { encoding: 'utf8', signal }),
});
```

This records the file contents once. A resume reuses the contents even if the file has changed;
starting a new run is how to request a fresh read. Declare dependencies in `input`, not only in the
callback closure. Callback source is hashed, but captured values and external helper bodies are not
inspected. Use `version` for those dependencies or invalidate the step in a fork. A new run with
`forkFrom` may reuse matching work; see [recovery](durability.md#choose-a-recovery-path).

Questions use one-line prompts (1024 characters), optional short titles (12 characters), markdown
details (16 KiB UTF-8), and at most four schema-valid suggested choices. Presentation and subject
are fingerprinted. Read [question durability](durability.md#durable-questions) and the
[human-review recipe](patterns.md#human-review) before adding a human checkpoint.

## Composition and retry

Read the [verified cookbook](patterns.md) before choosing a control-flow pattern. Its
[traps table](patterns.md#traps) explains replay-sensitive catches, retry loops, races, deadlines,
and the current guards that supersede older workarounds.

Use ordinary `if`, loops, and async helper functions at the workflow level. Wrap a helper in
`ctx.scope('review', () => helper(ctx))`, or pass `ctx.within('review')` to bind a lexical context.
Every local/agent/sleep call receives that prefix; nested scopes compose. Keep leaf names explicit
(`verdict`, `read`, `summarize`). IDs are fixed at launch, so completion order cannot renumber them.
Never allocate leaf IDs with a counter shared across concurrent branches.

`ctx.map('files', files, { concurrency: 3, key: (file) => ctx.id(file) }, mapper)` runs each item in
`files/<key>/`. All keys and combined prefixes are validated before any mapper starts. Omission of
`key` uses the input index; explicit keys help names survive reordering/filtering. External input
such as directory listings still belongs in a durable step. A bound context used inside its own map
retains the map/item prefix. Invoked from an unrelated scope, it uses its creation-time prefix; its
`signal` remains the current cancellation signal.

`ctx.id(...parts)` is the pure exported `stepId(...parts)` helper. Clean parts up to 64 characters
pass through; each unsafe/long part becomes one bounded slug plus eight hex SHA-256 characters of
the raw text. It handles spaces, `@`, `+`, `~`, Unicode, slashes, and leading punctuation. For
example `ctx.id('a', 3)` is `a/3`; `ctx.id('src/My Component.tsx')` is
`src-My-Component.tsx-<hash8>`. Hash suffixes reduce collisions; uniqueness checks remain required.
Full IDs still allow 1–200 characters, starting with a letter/number and followed by letters,
numbers, `.`, `_`, `:`, `/`, or `-`. Shorten nesting or labels when the full ID exceeds 200.
Diagnostics name the bounded full ID, scope, leaf, bad character/index, and allowed pattern.

The deprecated positional `ctx.map(items, concurrency, mapper, options?)` adds no item prefix and
keeps existing IDs and semantic fingerprints unchanged. Format-5 records are inspectable but require
the original runtime for resumption. Current storage format 7 preserves replay contract 6; flat
format 6 migrates automatically and original format 1 uses a legacy identity bridge. Adopting
scopes/named maps changes IDs and requires a new run (or an explicit fork); accepting code changes
does not rename saved effects.

Await all workflow operations. The default map policy is `drain`: stop scheduling on first failure,
let started mappers finish without sending an abort signal, then reject with `FanOutError`. Its
`failures` preserve `{ index, stepId, error }` in observation order and `unscheduled` lists input
indexes never started. A workflow-body rejection closes the workflow: effects already started finish
and checkpoint, but any new launch fails with "Workflow is closed", including an active mapper's
next step and a map started by a still-running branch. To let sibling branches finish, catch inside
each branch or use `Promise.allSettled`. Draining can wait for the slowest active call; configure
timeouts on agent calls.

Pass `{ onError: 'abort' }` to cancel only that map's subtree. Catching a failed map permits more
work, and a caught inner-map failure does not cancel unrelated outer branches. `ctx.signal` is a
getter for the current scope; effects capture that signal at launch. Ctrl-C/SIGTERM cancels every
scope. Parallel mappers share the working directory unless a call selects `isolation: 'worktree'` or
a shared `ctx.worktree` handle. Use [runtime worktrees](worktrees.md) for overlapping edits or
concurrent commands, and structural file sharding for disjoint writers.

Local and agent steps run once per execution unless given `retry: { maxAttempts: 3, delayMs: 100 }`.
`maxAttempts` counts attempts in the current execution; delay doubles up to 30 seconds. Only opt
repeatable effects into retries. Explicit resume retries unfinished calls. Retry and execution
limits are policy, so changing them does not invalidate a saved step. Run-level `policy` rules
override call-site fields and persist across resumes; see [durability](durability.md). Completed
identity changes remain errors; unfinished identity changes are recorded as redefinitions.

## Agent concurrency

`ctx.map` concurrency bounds only that map's mapper bodies. Nested maps can multiply active mappers.
A separate shared limit caps live agent invocations across the whole run, including `Promise.all`
and child helper functions using the same context. Default: min(8, max(1, available CPUs - 2)). Use
`--max-agents 5 --provider-limit codex=1` on execute, or
`RunOptions.agentLimit: { total: 5, perProvider: { codex: 1 } }`. Limits are fresh invocation
policy, not sticky or part of identity, so they can change on resume. Provider limits do not block
other eligible providers; requests are FIFO among eligible waiters.

Only the live harness call holds a permit. Local steps, sleeps, mappers, replay, checkpoint writes
and retry backoff do not. Queue time does not consume the agent's timeoutMs. Queued calls cancel
with their map/run scope and never reach the harness; admitted calls hold capacity until settled.
Use one `createAgentLimiter(limits)` object as `agentLimit` for several runs to share a cap; passing
the same number/data creates independent pools. Separate CLI processes are not coordinated. This is
a concurrency ceiling, not a dollar budget.

## Failure handling

A caught throwing call remains retryable on resume. If it heals, a fallback can disappear or a later
completed step can receive different input. The runner cannot infer that a JavaScript catch made a
durable decision. Use `onError: 'return'` whenever failure selects later workflow work:

<!-- skills-check: fragment; reason: Workflow-body pattern with ctx, schemas, and surrounding definition omitted. -->

```ts
const primary = await ctx.claude.value('draft', {
  prompt: 'Write a draft.',
  onError: 'return',
  retry: { maxAttempts: 3, delayMs: 100, on: ['rate-limit', 'timeout'] },
});
const draft = primary.ok
  ? primary.value
  : await ctx.codex.value('fallback', { prompt: 'Write the fallback draft.' });
```

`value`, `text`, `object`, and `ctx.step` return `Settled<T>` in this mode: `{ ok: true, value }` or
`{ ok: false, error: { message, kind, attempts } }`. The success value retains its normal type;
`text`/`object` values include `output`, `sessionId`, and `usage`, while `value` returns only
output. The final failure, after applicable retries, is saved as `settled-failed`. Replay returns
that exact failure without another callback or harness call. `onError` is semantic identity:
changing it on a terminal step requires a new run/fork. Cancellation (including an explicit map
abort) always rejects and stays retryable; authoring errors, configuration errors (a missing
harness, or an adapter's pre-launch `ConfigurationError` such as a Claude schema without an object
root), and checkpoint failures also reject instead of becoming fallback data.

For best-effort fan-out, use a named map with `onError: 'settle'`:

<!-- skills-check: fragment; reason: Workflow-body pattern with ctx, schemas, and surrounding definition omitted. -->

```ts
const results = await ctx.map('reviewers', topics, { concurrency: 3, onError: 'settle' }, (topic) =>
  ctx.claude.value('review', { prompt: topic }),
);
const votes = results.flatMap((result) => (result.ok ? [result.value] : []));
```

A settled map runs all items and journals the ordered `Settled<U, MapStepError>[]`. Errors contain
`message`, `kind`, `attempts`, and `stepId` (null for a mapper-body failure). Cancellation,
checkpoint errors, configuration errors, and authoring guards still reject. The full map ID names
the journal; items prefix explicit leaves with the map ID and key/index. Resume skips committed
mappers and returns their exact saved outcomes, including ordinary thrown body errors and caught
fallback results. Incomplete items execute again. Do not use this to hide ignored operation
failures: every launched child must still be awaited.

Map inputs/results must be lossless JSON. Every map schedules the items present when it is called;
settled mappers receive JSON copies of that snapshot. Identity hashes item inputs, resolved keys,
original mapper source, optional `version`, and cwd; concurrency can change. Captured
helpers/environment are invisible, so put dependencies in items or bump `version`. Keep full IDs
unique across the run; leaves can repeat under distinct scopes. Forks start fresh map journals and
reuse eligible steps under the selected fork policy. A leaf-level `onError: 'return'` inside an
ordinary map is also useful when only the individual call's fallback must be durable.

For transient retries, use one step ID with `retry` rather than a loop of throwing `ask/0`, `ask/1`
calls. `retry.on` limits retries to listed error kinds; omit it to retry all effect failures except
cancellation, configuration, and checkpoint-write failures, or use `[]` to retry none. Harness
process failures (`process`, including any CLI launch failure such as a missing or non-executable
binary), `authentication`, and `permission` are ordinary effect failures: they are settled under
`onError: 'return'`, and `retry.on` should exclude them. It is execution policy and can be changed
on resume. Each attempt retains its error and category. Every agent retry starts a fresh session;
previous filesystem edits remain.

Kinds include `timeout`, `rate-limit`, `schema`, `authentication`, `permission`, `turn-limit`,
`budget-limit`, `output-limit`, `process`, `protocol`, `cancelled`, and `unknown`. Classification
uses structured protocol metadata, process codes, or error types. Plain messages are not guessed:
for example, a Codex failure that reports rate limiting only as prose remains `unknown`. Custom
adapters can set `HarnessErrorDetails.kind`. Broadly typed options with a dynamic `onError` produce
a union result; preserve the literal mode (or explicitly use `onError: 'throw'`) to narrow it.

Do not use `Promise.race` or `Promise.any` over durable operations. Replay timing can pick a
different winner, and the runner drains losing work instead of cancelling it. Use an agent's
`timeoutMs` with `onError: 'return'` for agent timeout decisions. Competing signal/poll/deadline
sources use one `ctx.wait`; see [durable waits](waits.md). There is no `ctx.race` over arbitrary
effects and no scoped loser-cancellation contract.

Automatic failure stickiness and `--retry-failed` are not implemented: inferring handling from error
identity/cause chains can freeze an ordinary retry loop permanently. A saved settled failure is a
terminal decision. To intentionally try it again, fork with `--invalidate 'STEP-ID'`; prefix mode
also reruns everything after that decision. `matching` can retain work based on the old failure, so
use it only with complete declared dependencies. See [durability](durability.md).

## Data constraints

Use schemas that convert to JSON Schema draft-7. Transforms, `z.date()`, `z.void()`,
`z.undefined()`, and `z.bigint()` throw when their operation runs; `validate` checks only the
workflow's input/output schemas. For side-effect-only steps, use `z.null()` and return `null`. The
engine validates structured output locally even after the harness accepts its schema.

For a native Codex object schema, use a `z.object` root with required properties and `.nullable()`
for missing values. The default compat mode can encode `.optional()` and other shapes as described
below. Claude requires an object root but does not share Codex's required-property restriction.
Undefined object members are omitted recursively at workflow input, step dependencies, agent
requests, step output, and final output. Fresh bodies receive the checkpointed input; results on
fresh execution and replay have the same omitted members. For example `{ note: input.note }` is safe
when `note` is optional. `JsonInput` permits these dependency objects; saved `JsonValue` remains
JSON. A project enabling `exactOptionalPropertyTypes` can still reject explicitly undefined agent
options; omit those fields when using that project policy.

Undefined array elements and holes remain errors, naming the boundary, step ID when applicable, and
JSON path (for example `Step "triage/3" output is not JSON at $.findings[2]`). Use `null` with
`.nullable()`, or filter the item out. Root undefined, bigint, functions, symbols, NaN/infinity,
negative zero, cycles, accessors, and class instances remain errors. Encode dates as strings.

Use `z.object` by default. It strips unknown keys during local parsing and emits
`additionalProperties: false`. Use `z.looseObject` only when code must retain unknown keys; Codex
compat closes those objects on the wire, and strict mode rejects them. Never use
`.catchall(z.json())` to imitate permissive JSON schemas. Never cast the output schema: declare the
shape, or use uncast `z.json()` if any JSON is the intended contract.

`value()` uses exactly the same step kind, fingerprint, and full stored result as `object()` or
`text()`. Newly committed agent `step.completed` events include `usage` and `sessionId`, so
accounting does not require a wrapped return value. Replay/reuse events omit them; observers receive
a detached copy and cannot mutate the checkpoint.

## Codex structured schema compatibility

Codex object calls default to `structuredOutput: 'compat'`. The adapter encodes optionals, records,
discriminated unions, loose objects, and non-object roots, then decodes before validating the
original Zod schema. Nullable optionals keep null; other optional nulls become absent properties.
Loose objects request only named keys. Tuples need a named-object or homogeneous-array replacement.

Use `structuredOutput: 'strict'` for native Codex schemas: an object root, every property required,
`.nullable()` for missing values, and no records, loose objects, discriminated unions, or tuples.
Run `checkCodexSchema(schema)` early to see paths and suggested fixes; `workflow validate` does not
run the body to discover call-site schemas. Refinements are local checks, so restate them in the
prompt. See [Codex](codex.md) for the full encoding rules. Claude also requires an object root and
receives the original schema.

Read [durable waits](waits.md) for source precedence, suspension, notifications, and ticking.
