import { readFileSync } from 'node:fs';

import { defineWorkflow, z } from '../../../src/index.js';

const ready = z.object({ ready: z.boolean() });
const tracker = {
  seen: [] as string[],
  step(name: string): string {
    this.seen.push(name);
    return name;
  },
};

// Clean: current APIs that look like hazards but are durable-safe.
export default defineWorkflow({
  name: 'durability-legitimate-apis',
  version: '1',
  input: z.object({ items: z.array(z.string()), file: z.string() }),
  output: z.string(),
  async run(ctx, input) {
    const started = await ctx.now('started');
    const local = await ctx.step('local', {
      input: { file: input.file },
      schema: z.string(),
      async run(context) {
        const status = await context.exec(['git', 'status', '--short']);
        const parsed = await context.exec.json(['node', '-e', 'console.log("{}")'], {
          schema: z.object({}),
        });
        const home = process.env['HOME'] ?? '';
        const contents = readFileSync(input.file, 'utf8');
        return `${status.stdout}${JSON.stringify(parsed)}${home}${contents}${String(Date.now())}`;
      },
    });
    const probe = await ctx.exec('probe', ['git', 'rev-parse', 'HEAD'], { onError: 'return' });
    const command = await ctx.poll('command', {
      input: {},
      schema: z.number(),
      timeoutMs: 1_000,
      every: 100,
      command: ['node', '-e', 'console.log(JSON.stringify({ ready: true }))'],
      output: ready,
      done: (output) => (output.ready ? { done: true, value: 1 } : { done: false }),
    });
    const observed = await ctx.poll('observed', {
      input: {},
      schema: z.number(),
      timeoutMs: 1_000,
      every: 100,
      onError: { tolerate: 2, classify: () => 'transient', retryAfterMs: () => Date.now() % 10 },
      async observe(context) {
        const result = await context.exec(['git', 'status']);
        const env = process.env['CI'] ?? '';
        return { done: true, value: result.stdout.length + env.length + Date.now() };
      },
    });
    const pair = await Promise.all([
      ctx.step('left', { input: {}, schema: z.string(), run: () => 'l' }),
      ctx.step('right', { input: {}, schema: z.string(), run: () => 'r' }),
    ]);
    for (const item of input.items) {
      await ctx.within(ctx.id('item', item)).step('work', {
        input: item,
        schema: z.string(),
        run: () => item,
      });
      await ctx.scope(ctx.id('scoped', item), async () =>
        ctx.step('inner', { input: item, schema: z.string(), run: () => item }),
      );
      await ctx.map(ctx.id('fan', item), input.items, { concurrency: 2 }, async (leaf) =>
        ctx.step('leaf', { input: leaf, schema: z.string(), run: () => leaf }),
      );
      tracker.step('tracked');
    }
    const status = probe.ok ? probe.value.stdout : probe.error.message;
    const outcome = observed.by === 'deadline' ? 0 : observed.value;
    const polled = command.by === 'deadline' ? 0 : command.value;
    return `${String(started)}${local}${status}${String(outcome + polled)}${pair.join('')}`;
  },
});
