import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defineWorkflow, runWorkflow, z } from '../src/index.ts';

const [stateDir, mode] = process.argv.slice(2);
const definition = defineWorkflow({
  name: 'journal-crash',
  version: '1',
  input: z.null(),
  output: z.number(),
  run: async (ctx) => {
    const values = await ctx.map(
      'fan',
      Array.from({ length: 80 }, (_, n) => n),
      { concurrency: 8 },
      async (n) => {
        const result = await ctx.step('effect', {
          input: n,
          schema: z.number(),
          run: async () => {
            appendFileSync(join(stateDir, 'actions.jsonl'), `${n}\n`);
            await delay((n * 17) % 7);
            return n;
          },
        });
        appendFileSync(join(stateDir, 'resolved.jsonl'), `${n}\n`);
        process.send?.({ resolved: n });
        return result;
      },
    );
    return values.length;
  },
});
try {
  const result = await runWorkflow(definition, {
    stateDir,
    runId: 'crash',
    input: null,
    resume: mode === 'resume',
  });
  process.send?.({ done: result.output });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}
