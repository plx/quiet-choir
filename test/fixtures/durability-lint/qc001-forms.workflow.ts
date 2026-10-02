import { defineWorkflow, z } from '../../../src/index.js';

const text = { input: {}, schema: z.string(), run: () => 'value' };

// QC001 forms: statement, void and then chains, scope and phase bodies; awaited forms are clean.
export default defineWorkflow({
  name: 'durability-qc001-forms',
  version: '1',
  input: z.object({}),
  output: z.string(),
  async run(ctx) {
    /* eslint-disable @typescript-eslint/no-floating-promises -- the hazards under test */
    ctx.step('statement', text);
    void ctx.step('chained', text).then((value) => value.trim());
    ctx.sleep('nap', 1).catch(() => undefined);
    ctx.scope('scoped', async () => ctx.step('inner', text));
    ctx.phase('Phase', async () => ctx.step('phased', text));
    /* eslint-enable @typescript-eslint/no-floating-promises */
    ctx.phase('Marker');
    const kept = ctx.step('kept', text);
    const awaited = await ctx.step('awaited', text);
    await Promise.all([ctx.step('all', text)]);
    return (await kept) + awaited;
  },
});
