import { defineWorkflow, type WorkflowContext, z } from '../../../src/index.js';
import { callbacks, importedHelper, importedRun, makeRun } from './support/zone-callbacks.js';

// What the lint cannot resolve to a same-file const or function keeps its findings (#326).
async function withRun(ctx: WorkflowContext, run: () => number): Promise<number> {
  return ctx.step('parameter', { input: {}, schema: z.number(), run });
}

// WorkflowDefinition.run is not a callback zone: the bound workflow function is still checked.
async function run(ctx: WorkflowContext): Promise<number> {
  return Date.now() + (await ctx.now('shorthand-now'));
}

export const shorthand = defineWorkflow({
  name: 'durability-zone-shorthand',
  version: '1',
  input: z.object({}),
  output: z.number(),
  run,
});

export default defineWorkflow({
  name: 'durability-zone-unresolved',
  version: '1',
  input: z.object({ random: z.boolean() }),
  output: z.number(),
  async run(ctx, input) {
    const a = await ctx.step('imported', { input: {}, schema: z.number(), run: importedRun });
    const b = await ctx.step('helper', {
      input: {},
      schema: z.number(),
      run: () => importedHelper(ctx),
    });
    let late = () => Date.now();
    if (input.random) late = () => Math.random();
    const c = await ctx.step('let', { input: {}, schema: z.number(), run: late });
    const d = await withRun(ctx, () => 1);
    const e = await ctx.step('property', { input: {}, schema: z.number(), run: callbacks.run });
    const f = await ctx.step('call', { input: {}, schema: z.number(), run: makeRun() });
    const { run: destructured } = { run: () => performance.now() };
    const g = await ctx.step('destructured', { input: {}, schema: z.number(), run: destructured });
    return a + b + c + d + e + f + g;
  },
});
