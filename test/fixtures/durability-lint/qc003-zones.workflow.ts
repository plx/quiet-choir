import { defineWorkflow, z } from '../../../src/index.js';

// QC003 in every callback zone; the callback's own context.exec is clean.
export default defineWorkflow({
  name: 'durability-qc003-zones',
  version: '1',
  input: z.object({}),
  output: z.number(),
  async run(ctx) {
    const observed = await ctx.poll('observed', {
      input: {},
      schema: z.number(),
      timeoutMs: 1_000,
      every: 100,
      onError: {
        tolerate: 1,
        classify: () => 'transient',
        retryAfterMs: () => {
          void ctx.now('retry');
          return null;
        },
      },
      async observe(context) {
        await context.exec(['true']);
        return { done: true, value: await ctx.now('observe') };
      },
    });
    const command = await ctx.poll('command', {
      input: {},
      schema: z.number(),
      timeoutMs: 1_000,
      every: 100,
      command: ['true'],
      output: z.unknown(),
      done: async () => ({ done: true, value: await ctx.now('done') }),
    });
    const outcome = observed.by === 'deadline' ? 0 : observed.value;
    return outcome + (command.by === 'deadline' ? 0 : command.value);
  },
});
