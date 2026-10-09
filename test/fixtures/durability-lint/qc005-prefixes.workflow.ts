import { defineWorkflow, z } from '../../../src/index.js';

const text = { input: {}, schema: z.string(), run: () => 'value' };

// QC005 keyed by literal scope/within prefix path, and literal prefixes reused in loops.
export default defineWorkflow({
  name: 'durability-qc005-prefixes',
  version: '1',
  input: z.object({ items: z.array(z.string()), name: z.string() }),
  output: z.string(),
  async run(ctx, input) {
    // (a) A const within view and an inline within prefix, each reusing an ID.
    const a = ctx.within('a');
    await a.step('same', text);
    await a.step('same', text);
    await ctx.within('b').exec('x', ['true']);
    await ctx.within('b').exec('x', ['true']);
    // (b) Sibling literal scopes, and a scope and a within that share the path s/.
    await ctx.scope('s', async () => ctx.step('inner', text));
    await ctx.scope('s', async () => ctx.step('inner', text));
    await ctx.scope('t', async () => ctx.step('leaf', text));
    await ctx.within('t').step('leaf', text);
    // (c) A literal within created in a for-of body.
    for (const item of input.items) {
      const x = ctx.within('x');
      await x.step('per', { ...text, input: item });
    }
    // (d) A literal scope inside an array callback.
    await Promise.all(input.items.map(async () => ctx.scope('y', async () => ctx.step('z', text))));
    // (e) A view created before a loop, used inside it.
    const before = ctx.within('before');
    for (const item of input.items) {
      await before.step('each', { ...text, input: item });
    }
    // (f) A fixed-path view used in a root named-map item callback.
    const panel = ctx.within('panel');
    await ctx.map('people', input.items, { concurrency: 2, key: (item) => item }, async () =>
      panel.step('verdict', text),
    );

    // Clean: the same ID under different literal prefixes, and a nested scope versus its view.
    await ctx.within('c').step('x', text);
    await ctx.within('d').step('x', text);
    const v = ctx.within('v');
    await v.scope('c', async () => v.step('x', text));
    await v.step('x', text);
    // Clean: per-item, templated and variable prefixes in loops.
    for (const item of input.items) {
      await ctx.within(ctx.id('item', item)).step('fixed', text);
      await ctx.scope(`item-${item}`, async () => ctx.step('fixed', text));
      await ctx.within(input.name).step('fixed', text);
      await ctx.within(ctx.id('outer', item)).within('literal').step('fixed', text);
    }
    // Clean: a literal prefix in a loop whose effects all derive their IDs per item.
    for (const item of input.items) {
      await ctx.scope('per-item', async () => ctx.step(ctx.id('each', item), text));
    }
    // Clean: one ID in exclusive branches under one literal scope.
    await ctx.scope('branch', async () => {
      if (input.name === '') await ctx.step('pick', text);
      else await ctx.step('pick', text);
    });
    // Clean: a view's own calls inside its named-map callbacks use the item path.
    const votes = ctx.within('votes');
    await votes.map('people', input.items, { concurrency: 2, key: (item) => item }, async () =>
      votes.map('rounds', [0, 1], { concurrency: 2 }, async () => votes.step('verdict', text)),
    );
    // Clean: a view's calls inside another view's scope keep that view's fixed path.
    const outside = ctx.within('outside');
    await ctx.scope('unrelated', async () => outside.step('once', text));
    // Clean: root calls in a view's phase body use the view's path, also for a per-item view.
    const staged = ctx.within('staged');
    await staged.phase('stage', async () => ctx.step('once', text));
    await ctx.step('once', text);
    for (const item of input.items) {
      const each = ctx.within(ctx.id('each', item));
      await each.phase('stage', async () => ctx.step('fixed', text));
    }
    return 'done';
  },
});
