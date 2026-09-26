import { AsyncLocalStorage } from 'node:async_hooks';
import { z, type WorkflowContext } from 'quiet-choir';

// Explicit execution controls; source workflows inherited the interactive session.
// Tools stay disabled unless the caller opts in with $claude.tools / allowedTools.
export const executionInput = {
  $claude: z
    .object({
      model: z.string().optional(),
      tools: z.array(z.string()).optional(),
      allowedTools: z.array(z.string()).optional(),
      maxTurns: z.number().int().positive().default(40),
      maxBudgetUsd: z.number().positive().default(5),
      timeoutMs: z.number().int().positive().default(600_000),
    })
    .default({ maxTurns: 40, maxBudgetUsd: 5, timeoutMs: 600_000 }),
};

// The source harness serializes JavaScript results. Match that boundary by omitting
// undefined object members (and converting undefined array members to null).
export function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function scopedContext(ctx: WorkflowContext, prefix: string): WorkflowContext {
  return {
    ...ctx,
    claude: {
      text: (id, options) => ctx.claude.text(`${prefix}/${id}`, options),
      object: (id, options) => ctx.claude.object(`${prefix}/${id}`, options),
    },
    codex: {
      text: (id, options) => ctx.codex.text(`${prefix}/${id}`, options),
      object: (id, options) => ctx.codex.object(`${prefix}/${id}`, options),
    },
    step: (id, definition) => ctx.step(`${prefix}/${id}`, definition),
    sleep: (id, ms) => ctx.sleep(`${prefix}/${id}`, ms),
  };
}

type Scope = { path: string; counts: Map<string, number> };
type Stage<T, U, V> = (previous: T, original: U, index: number) => V | Promise<V>;

// Local composition helpers, not additions to quiet-choir's public API.
// Each concurrent item owns its ID counter. Completion order cannot change IDs.
export function createPort(ctx: WorkflowContext) {
  const storage = new AsyncLocalStorage<Scope>();
  const root: Scope = { path: '', counts: new Map() };
  function id(site: string, label = site): string {
    const scope = storage.getStore() ?? root;
    const count = scope.counts.get(site) ?? 0;
    scope.counts.set(site, count + 1);
    return `${scope.path}${site}/${count}${label === site ? '' : ':' + label.replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 48)}`;
  }
  function within<T>(path: string, fn: () => T): T {
    return storage.run({ path: `${path}/`, counts: new Map() }, fn);
  }
  async function parallel<const T extends readonly (() => unknown)[]>(
    site: string,
    tasks: T,
  ): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
    const path = id(site);
    const results = await ctx.map(tasks, 8, (task, index) =>
      within(`${path}/${index}`, async () => task()),
    );
    return results as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
  }
  function pipeline<A, B, C>(
    site: string,
    items: readonly A[],
    first: Stage<A, A, B>,
    second: Stage<B, A, C>,
  ): Promise<C[]>;
  function pipeline<A, B, C, D>(
    site: string,
    items: readonly A[],
    first: Stage<A, A, B>,
    second: Stage<B, A, C>,
    third: Stage<C, A, D>,
  ): Promise<D[]>;
  async function pipeline(
    site: string,
    items: readonly unknown[],
    ...stages: Stage<unknown, unknown, unknown>[]
  ): Promise<unknown[]> {
    const path = id(site);
    return ctx.map(items, 8, (item, index) =>
      within(`${path}/${index}`, async () => {
        let value = item;
        for (let stage = 0; stage < stages.length; stage++) {
          value = await within(`${path}/${index}/stage-${stage}`, () =>
            stages[stage]!(value, item, index),
          );
        }
        return value;
      }),
    );
  }
  return {
    id,
    parallel,
    pipeline,
    // These are stderr messages only; there is no native phase/progress model.
    phase: (title: string) => console.error(`[phase] ${title}`),
    log: (message: string) => console.error(message),
  };
}
