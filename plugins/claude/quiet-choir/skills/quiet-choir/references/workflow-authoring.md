# Workflow authoring

## Define a workflow

Default-export `defineWorkflow({ name, version, input, output, run })`. Schemas infer TypeScript
types and validate data at runtime. This example can be saved under `examples/` in a checkout:

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
| `ctx.step(id, { input, schema, run, retry? })`                     | Validated local result; records explicit dependencies and result                         |
| `ctx.claude.text(id, options)` / `ctx.codex.text(id, options)`     | `{ output: string, sessionId, usage }`                                                   |
| `ctx.claude.object(id, { schema, ...options })` / Codex equivalent | Same wrapper with schema-inferred `output`                                               |
| `ctx.map(items, concurrency, mapper)`                              | Ordered result array with at most `concurrency` active mappers; no checkpoint of its own |
| `ctx.sleep(id, milliseconds)`                                      | `null`; persists the wake deadline, then waits in this process                           |

Agent operations are already durable: call them directly from the workflow, not from inside
`ctx.step`. Local `run` receives `{ signal, attempt, idempotencyKey }`. `attempt` is the total
persisted count across retries and resumes; `idempotencyKey` is the stable `runId/stepId` string.
Pass the signal to cancellable I/O and the key to external systems that support deduplication.

For example, inside a workflow that imports `readFile` from `node:fs/promises`:

```ts
const contents = await ctx.step('read-source', {
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

Local steps run once per execution unless given `retry: { maxAttempts: 3, delayMs: 100 }`.
`maxAttempts` counts attempts in the current execution; delay doubles up to 30 seconds. Only opt
repeatable effects into retries. Agent calls have no retry option; explicit resume retries
unfinished calls. Retry policy changes also affect step compatibility.

## Data constraints

Use schemas that convert to JSON Schema draft-7. Required object properties are the most portable
structured-response shape across harnesses. Avoid Zod transforms and class-valued schemas. The
engine validates structured output locally even after the harness accepts the schema.

Persisted values must round-trip losslessly as JSON: no `undefined`, bigint, functions, symbols,
NaN/infinity, negative zero, sparse arrays, cycles, accessors, or class instances. Use plain
objects, arrays, strings, finite numbers, booleans, and null; encode dates as strings. This applies
to workflow input/output and local-step dependencies/results, not just agent responses.
