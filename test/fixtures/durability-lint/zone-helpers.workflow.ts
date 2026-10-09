import { defineWorkflow, type WorkflowContext, z } from '../../../src/index.js';

// Same-file helpers called directly from a callback are walked in its zone (#326).
async function record(ctx: WorkflowContext): Promise<number> {
  return ctx.step('record', { input: {}, schema: z.number(), run: () => 1 });
}

function inner(ctx: WorkflowContext): Promise<number> {
  return ctx.now('chain');
}

function outer(ctx: WorkflowContext): Promise<number> {
  return inner(ctx);
}

function countdown(n: number): number {
  return n > 0 ? countdown(n - 1) : 0;
}

function even(ctx: WorkflowContext, n: number): Promise<number> {
  return n === 0 ? ctx.now('even') : odd(ctx, n - 1);
}

function odd(ctx: WorkflowContext, n: number): Promise<number> {
  return n === 0 ? Promise.resolve(1) : even(ctx, n - 1);
}

export default defineWorkflow({
  name: 'durability-zone-helpers',
  version: '1',
  input: z.object({}),
  output: z.number(),
  async run(ctx) {
    const now = () => ctx.now('helper-now');
    // Judged where it is written: only ever called from a callback, but still reported.
    const stamp = () => Date.now();
    const a = await ctx.step('a', { input: {}, schema: z.number(), run: () => now() });
    const b = await ctx.poll('b', {
      input: {},
      schema: z.number(),
      timeoutMs: 1_000,
      every: 100,
      observe: async () => ({ done: true as const, value: await record(ctx) }),
    });
    const c = await ctx.step('c', { input: {}, schema: z.number(), run: () => outer(ctx) });
    const d = await ctx.step('d', {
      input: {},
      schema: z.number(),
      run: () => countdown(3) + stamp() + countdown(2),
    });
    const e = await ctx.step('e', { input: {}, schema: z.number(), run: () => even(ctx, 4) });
    const tick = (): number => (Math.random() > 0.5 ? 1 : tick());
    const f = await ctx.step('f', { input: {}, schema: z.number(), run: tick });
    const g = await ctx.step('g', { input: {}, schema: z.number(), run: () => even(ctx, 2) });
    // A helper written inside the callback is already in its zone: reported once, as written.
    const h = await ctx.step('h', {
      input: {},
      schema: z.number(),
      run: () => {
        const local = () => ctx.now('local');
        return local();
      },
    });
    return a + (b.by === 'deadline' ? 0 : b.value) + c + d + e + f + g + h;
  },
});
