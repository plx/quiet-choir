// Shared by test/step-exec-lifecycle.test.ts and its forked child: one local step whose callback
// runs an inner command through context.exec, and one command poll. Until the `resumed` file exists
// each command writes its PID to `ready` and hangs, so a SIGKILLed runner leaves it behind as an
// orphan.
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

// A waiting poll's done source text is its identity, hashed as the loader prints it, and tsx (the
// forked runner) and vitest (the resume) print a callback differently, which would refuse this
// deliberately cross-loader resume. Build it from fixed text that both see the same way; see
// "Callback source and loaders" in docs/waits.md and ADR 0059.
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- fixed source, see above
const done = new Function('output', 'return { done: true, value: output };') as (
  output: string,
) => { done: true; value: string };

/** The command poll's command decides by itself, so it stays the same on resume (it is identity). */
export const pollLifecycle = defineWorkflow({
  name: 'step-exec-poll-lifecycle',
  version: '1',
  input: z.object({ ready: z.string(), resumed: z.string() }),
  output: z.string(),
  run: async (ctx, input) => {
    const outcome = await ctx.poll('ci', {
      input,
      schema: z.string(),
      every: 1,
      timeoutMs: 600_000,
      command: [
        process.execPath,
        '-e',
        `const fs = require('node:fs');
if (fs.existsSync(${JSON.stringify(input.resumed)})) process.stdout.write('"done"');
else { fs.writeFileSync(${JSON.stringify(input.ready)}, String(process.pid)); setInterval(() => {}, 1000); }`,
      ],
      output: z.string(),
      done,
    });
    return outcome.by === 'poll' ? outcome.value : 'deadline';
  },
});
