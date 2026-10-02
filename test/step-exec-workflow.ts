// Shared by test/step-exec-lifecycle.test.ts and its forked child: one local step whose callback
// runs an inner command through context.exec. Until the `resumed` file exists the command writes
// its PID to `ready` and hangs, so a SIGKILLed runner leaves it behind as an orphan.
import { existsSync } from 'node:fs';
import { defineWorkflow, z } from '../src/index.js';

export const fingerprint = 'step-exec-lifecycle';

export const lifecycle = defineWorkflow({
  name: 'step-exec-lifecycle',
  version: '1',
  input: z.object({ ready: z.string(), resumed: z.string() }),
  output: z.string(),
  run: (ctx, input) =>
    ctx.step('parent', {
      input,
      schema: z.string(),
      run: async (context) => {
        const script = existsSync(input.resumed)
          ? `process.stdout.write('done')`
          : `require('node:fs').writeFileSync(${JSON.stringify(input.ready)}, String(process.pid)); setInterval(() => {}, 1000)`;
        return (await context.exec([process.execPath, '-e', script])).stdout;
      },
    }),
});
