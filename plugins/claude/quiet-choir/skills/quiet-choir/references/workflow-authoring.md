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
version requires a new run ID. See [durability](durability.md).

## Durable operations

| Operation                                                          | Return and composition                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `ctx.step(id, { input, schema, run, retry? })`                     | Validated result; stores that result and component hashes of `input` and schema          |
| `ctx.claude.text(id, options)` / `ctx.codex.text(id, options)`     | `{ output: string, sessionId, usage }`                                                   |
| `ctx.claude.object(id, { schema, ...options })` / Codex equivalent | Same wrapper with schema-inferred `output`                                               |
| `ctx.map(items, concurrency, mapper)`                              | Ordered result array with at most `concurrency` active mappers; no checkpoint of its own |
| `ctx.sleep(id, milliseconds)`                                      | `null`; persists the wake deadline, then waits in this process                           |
| `ctx.runId`                                                        | Stable run identifier                                                                    |
| `ctx.signal`                                                       | AbortSignal for run cancellation                                                         |

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
callback closure. The engine cannot inspect captured values for you.

## Composition and retry

Use ordinary `if`, loops, and async helper functions at the workflow level. Give helpers an ID
prefix so every durable operation has a unique ID across the entire run. IDs allow 1–200 characters,
starting with a letter or number, followed by letters, numbers, `.`, `_`, `:`, `/`, or `-`. Keep
collection order deterministic when deriving IDs from indexes.

Await all workflow operations. A mapper failure aborts the run, stops new scheduling, and drains
active workers. Parallel mappers share the working directory; use separate directories/worktrees
when their edits could conflict. quiet-choir does not create these automatically.

Local and agent steps run once per execution unless given `retry: { maxAttempts: 3, delayMs: 100 }`.
`maxAttempts` counts attempts in the current execution; delay doubles up to 30 seconds. Only opt
repeatable effects into retries. Explicit resume retries unfinished calls. Retry and execution
limits are policy, so changing them does not invalidate a saved step. Run-level `policy` rules
override call-site fields and persist across resumes; see [durability](durability.md). Completed
identity changes remain errors; unfinished identity changes are recorded as redefinitions.

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
