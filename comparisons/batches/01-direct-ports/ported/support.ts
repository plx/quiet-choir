import { AsyncLocalStorage } from 'node:async_hooks';
import { z, type WorkflowContext, type ClaudeOptions } from 'quiet-choir';

// Explicit execution controls; source workflows inherited the interactive session.
// Legacy strictProfiles:false ports expose $claude.tools; tools imply allowedTools unless narrowed.
// Elevated raw tools still require write/exec/all grants at launch.
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

// Zod optional fields may be explicitly undefined. Omit them at the native options boundary
// so every legacy call shares one exact-optional construction rule instead of local assertions.
export function callOptions(
  value: z.output<(typeof executionInput)['$claude']>,
): Pick<
  ClaudeOptions,
  'model' | 'tools' | 'allowedTools' | 'maxTurns' | 'maxBudgetUsd' | 'timeoutMs'
> {
  return {
    maxTurns: value.maxTurns,
    maxBudgetUsd: value.maxBudgetUsd,
    timeoutMs: value.timeoutMs,
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.tools === undefined ? {} : { tools: value.tools }),
    ...(value.allowedTools === undefined ? {} : { allowedTools: value.allowedTools }),
  };
}

// The source harness serializes JavaScript results. Match that boundary by omitting
// undefined object members (and converting undefined array members to null).
export function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function scopedContext(ctx: WorkflowContext, prefix: string): WorkflowContext {
  function prefixed<T extends (id: string, ...args: never[]) => unknown>(method: T): T {
    // Forward every overload unchanged, adding only the legacy explicit prefix.
    return ((id: string, ...args: never[]) => method(`${prefix}/${id}`, ...args)) as T;
  }
  return {
    ...ctx,
    claude: {
      value: prefixed(ctx.claude.value),
      text: prefixed(ctx.claude.text),
      object: prefixed(ctx.claude.object),
    },
    codex: {
      value: prefixed(ctx.codex.value),
      text: prefixed(ctx.codex.text),
      object: prefixed(ctx.codex.object),
    },
    exec: Object.assign(prefixed(ctx.exec), { json: prefixed(ctx.exec.json) }),
    readFile: prefixed(ctx.readFile),
    writeFile: prefixed(ctx.writeFile),
    worktree: prefixed(ctx.worktree),
    merge: prefixed(ctx.merge),
    now: prefixed(ctx.now),
    wait: prefixed(ctx.wait),
    poll: prefixed(ctx.poll),
    sleepUntil: prefixed(ctx.sleepUntil),
    ask: prefixed(ctx.ask),
    approve: prefixed(ctx.approve),
    step: prefixed(ctx.step),
    sleep: (id, ms) => ctx.sleep(`${prefix}/${id}`, ms),
  };
}

type Scope = { path: string; counts: Map<string, number> };
type Stage<T, U, V> = (previous: T, original: U, index: number) => V;

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
    // quiet-choir-ignore QC006 direct port keeps legacy positional map IDs and journals that verification.json records
    const results = await ctx.map(tasks, 8, (task, index) =>
      within(`${path}/${index}`, async () => task()),
    );
    return results as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
  }
  function pipeline<A, B, C>(
    site: string,
    items: readonly A[],
    first: Stage<A, A, B>,
    second: Stage<Awaited<B>, A, C>,
  ): Promise<Awaited<C>[]>;
  function pipeline<A, B, C, D>(
    site: string,
    items: readonly A[],
    first: Stage<A, A, B>,
    second: Stage<Awaited<B>, A, C>,
    third: Stage<Awaited<C>, A, D>,
  ): Promise<Awaited<D>[]>;
  async function pipeline(
    site: string,
    items: readonly unknown[],
    ...stages: Stage<unknown, unknown, unknown>[]
  ): Promise<unknown[]> {
    const path = id(site);
    // quiet-choir-ignore QC006 direct port keeps legacy positional map IDs and journals that verification.json records
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
    phase: (title: string) => ctx.phase(title),
    log: (message: string) => ctx.log(message),
  };
}
