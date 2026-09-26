# Workflow authoring

## Define a workflow

Default-export `defineWorkflow({ name, version, input, output, run })`. Schemas infer TypeScript
types and validate data at runtime. Callback return types also participate in inference: a wider
return such as `T | undefined` can typecheck and then fail runtime validation, after all paid calls
for a workflow's final output. Use an explicit `Promise<z.infer<typeof Output>>` return annotation
and `ctx.step<string>(…)` when you need the compiler to reject wider returns. This example can be
saved under `examples/` in a checkout:

```ts
import { defineWorkflow, z } from '../src/index.js';

export default defineWorkflow({
  name: 'labels',
  version: '1',
  input: z.object({ topics: z.array(z.string()).max(10) }),
  output: z.object({ labels: z.array(z.string()) }),
  async run(ctx, input) {
    const labels = await ctx.map(input.topics, 2, async (topic, index) => {
      const result = await ctx.claude.object(`label/${String(index)}`, {
        prompt: `Suggest a short label for this topic: ${topic}`,
        schema: z.object({ label: z.string() }),
      });
      return result.output.label;
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

| Operation                                                          | Return and composition                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `ctx.step(id, { input, schema, run, retry?, version?, onError? })` | Validated result; stores that result and hashes of input, schema, callback source, version, and cwd |
| `ctx.claude.text(id, options)` / `ctx.codex.text(id, options)`     | `{ output: string, sessionId, usage }`                                                              |
| `ctx.claude.object(id, { schema, ...options })` / Codex equivalent | Same wrapper with schema-inferred `output`                                                          |
| `ctx.map(items, concurrency, mapper, options?)`                    | Ordered bounded fan-out; optional settled map journal                                               |
| `ctx.sleep(id, milliseconds)`                                      | `null`; persists the wake deadline, then waits in this process                                      |
| `ctx.runId`                                                        | Stable run identifier                                                                               |
| `ctx.signal`                                                       | Current scope signal; inherits run and parent-map cancellation                                      |

Prompts and identity options are stored as component hashes. Resolved execution policy and requested
model/effort are stored in plaintext per attempt; inspection cannot reconstruct prompts.

Agent operations are already durable: call them directly from the workflow, not from inside
`ctx.step`. Local `run` receives `{ signal, attempt, idempotencyKey }`. `attempt` is the total
persisted count across retries and resumes; `idempotencyKey` is the stable `runId/stepId` string.
Pass the signal to cancellable I/O and the key to external systems that support deduplication.

For example, inside a workflow that imports `readFile` from `node:fs/promises`:

```ts
const contents = await ctx.step<string>('read-source', {
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

## Composition and retry

Use ordinary `if`, loops, and async helper functions at the workflow level. Give helpers an ID
prefix so every durable operation has a unique ID across the entire run. IDs allow 1–200 characters,
starting with a letter or number, followed by letters, numbers, `.`, `_`, `:`, `/`, or `-`. Keep
collection order deterministic when deriving IDs from indexes.

Await all workflow operations. The default map policy is `drain`: stop scheduling on first failure,
let started mappers finish without sending an abort signal, then reject with `FanOutError`. Its
`failures` preserve `{ index, stepId, error }` in observation order and `unscheduled` lists input
indexes never started. A workflow-body rejection also drains pending work. Draining can wait for the
slowest active call; configure timeouts on agent calls.

Pass `{ onError: 'abort' }` to cancel only that map's subtree. Catching a failed map permits more
work, and a caught inner-map failure does not cancel unrelated outer branches. `ctx.signal` is a
getter for the current scope; effects capture that signal at launch. Ctrl-C/SIGTERM cancels every
scope. Parallel mappers share the working directory; use separate directories/worktrees when their
edits could conflict. quiet-choir does not create these automatically.

Local and agent steps run once per execution unless given `retry: { maxAttempts: 3, delayMs: 100 }`.
`maxAttempts` counts attempts in the current execution; delay doubles up to 30 seconds. Only opt
repeatable effects into retries. Explicit resume retries unfinished calls. Retry and execution
limits are policy, so changing them does not invalidate a saved step. Run-level `policy` rules
override call-site fields and persist across resumes; see [durability](durability.md). Completed
identity changes remain errors; unfinished identity changes are recorded as redefinitions.

## Failure handling

A caught throwing call remains retryable on resume. If it heals, a fallback can disappear or a later
completed step can receive different input. The runner cannot infer that a JavaScript catch made a
durable decision. Use `onError: 'return'` whenever failure selects later workflow work:

```ts
const primary = await ctx.claude.text('draft', {
  prompt: 'Write a draft.',
  onError: 'return',
  retry: { maxAttempts: 3, delayMs: 100, on: ['rate-limit', 'timeout'] },
});
const draft = primary.ok
  ? primary.value.output
  : (await ctx.codex.text('fallback', { prompt: 'Write the fallback draft.' })).output;
```

`text`, `object`, and `ctx.step` return `Settled<T>` in this mode: `{ ok: true, value }` or
`{ ok: false, error: { message, kind, attempts } }`. The success value retains its normal type;
agent values include `output`, `sessionId`, and `usage`. The final failure, after applicable
retries, is saved as `settled-failed`. Replay returns that exact failure without another callback or
harness call. `onError` is semantic identity: changing it on a terminal step requires a new
run/fork. Cancellation (including an explicit map abort) always rejects and stays retryable;
authoring errors, configuration errors (a missing harness, or an adapter's pre-launch
`ConfigurationError` such as a Claude schema without an object root), and checkpoint failures also
reject instead of becoming fallback data.

For best-effort fan-out, use `{ onError: 'settle', id: 'reviewers' }` as the fourth map argument:

```ts
const results = await ctx.map(
  topics,
  3,
  (topic, index) => ctx.claude.text(`review/${index}`, { prompt: topic }),
  { onError: 'settle', id: 'reviewers' },
);
const votes = results.flatMap((result) => (result.ok ? [result.value.output] : []));
```

A settled map runs all items and journals the ordered `Settled<U, MapStepError>[]`. Errors contain
`message`, `kind`, `attempts`, and `stepId` (null for a mapper-body failure). Cancellation,
checkpoint errors, configuration errors, and authoring guards still reject. The required run-unique
`id` names the journal; it does not prefix leaf IDs. Resume skips committed mappers and returns
their exact saved outcomes, including ordinary thrown body errors and caught fallback results.
Incomplete items execute again. Do not use this to hide ignored operation failures: every launched
child must still be awaited.

Map inputs/results must be lossless JSON. Identity hashes item inputs, mapper source, optional
`version`, and cwd; concurrency can change. Captured helpers/environment are invisible, so put
dependencies in items or bump `version`. Keep leaf IDs unique across the run. Forks start fresh map
journals and reuse eligible steps under the selected fork policy. A leaf-level `onError: 'return'`
inside an ordinary map is also useful when only the individual call's fallback must be durable.

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
`timeoutMs` with `onError: 'return'` for timeout decisions. There is no `ctx.race`; a durable winner
journal and scoped loser cancellation are deferred to
[#57](https://github.com/plx/quiet-choir/issues/57).

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
Top-level undefined agent options are omitted at runtime (for example `model: input.model`), though
`exactOptionalPropertyTypes` still rejects explicit undefined in TypeScript; omit the property in
strict code. Undefined values nested in options or in checkpoint data remain errors.

Persisted values must round-trip losslessly as JSON: no `undefined`, bigint, functions, symbols,
NaN/infinity, negative zero, sparse arrays, cycles, accessors, or class instances. Use plain
objects, arrays, strings, finite numbers, booleans, and null; encode dates as strings. This applies
to workflow input/output and local-step dependencies/results, not just agent responses.

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
