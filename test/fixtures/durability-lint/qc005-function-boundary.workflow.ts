import { defineWorkflow, z } from '../../../src/index.js';

const text = { input: {}, schema: z.string(), run: () => 'value' };

// QC005 across function boundaries: a return inside a nested function only leaves that function.
export default defineWorkflow({
  name: 'durability-qc005-function-boundary',
  version: '1',
  input: z.object({ fast: z.boolean(), mode: z.string() }),
  output: z.string(),
  async run(ctx, input) {
    // (a) An early return inside an arrow closure does not make the later step exclusive.
    const f = async () => {
      if (input.fast) {
        await ctx.step('x', text);
        return;
      }
    };
    await f();
    await ctx.step('x', text);
    // (b) The same with a nested function declaration and the exec receiver.
    async function g() {
      if (input.fast) {
        await ctx.exec('probe', ['true']);
        return;
      }
    }
    await g();
    await ctx.exec('probe', ['true']);
    // (c) Sibling literal scopes whose first callback returns early still share the inner ID.
    await ctx.scope('s', async () => {
      if (input.fast) {
        await ctx.step('inner', text);
        return;
      }
    });
    await ctx.scope('s', async () => {
      await ctx.step('inner', text);
    });
    // (d) Clean: a closure inside an outer early-return branch is exclusive with the final step.
    if (input.mode === 'a') {
      const h = async () => ctx.step('y', text);
      await h();
      return 'a';
    }
    // (e) Clean: an if that throws in the same function is exclusive with the later use.
    if (input.mode === 'b') throw new Error(await ctx.step('z', text));
    await ctx.step('z', text);
    return ctx.step('y', text);
  },
});
