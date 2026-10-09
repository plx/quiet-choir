import { defineWorkflow, z } from '../../../src/index.js';

// A callback bound to a zone by name gets that zone at its definition (#326); one that is also used
// elsewhere keeps its body-level findings and is checked in the zone as well.
export default defineWorkflow({
  name: 'durability-zone-identifier',
  version: '1',
  input: z.object({}),
  output: z.number(),
  async run(ctx) {
    const run = () => Date.now();
    const first = await ctx.step('shorthand', { input: {}, schema: z.number(), run });
    function readHome(): string {
      return process.env['HOME'] ?? '';
    }
    const home = await ctx.step('named', { input: {}, schema: z.string(), run: readHome });
    const stamp = () => Math.random();
    const wrapped = await ctx.step('wrapped', {
      input: {},
      schema: z.number(),
      run: stamp satisfies () => number,
    });
    const observe = () => Promise.resolve({ done: true as const, value: performance.now() });
    const classify = (): 'fatal' | 'transient' => (new Date().getDay() > 7 ? 'fatal' : 'transient');
    const polled = await ctx.poll('observed', {
      input: {},
      schema: z.number(),
      timeoutMs: 1_000,
      every: 100,
      onError: { tolerate: 1, classify },
      observe,
    });
    // Shared: also called in the body, so its Date.now() is still reported; its zone use nests a
    // durable call.
    const shared = async () => {
      await ctx.now('shared-now');
      return Date.now();
    };
    const direct = await shared();
    const bound = await ctx.step('shared', { input: {}, schema: z.number(), run: shared });
    // Also stored in an array: shared, so its Date.now() is still reported.
    const stored = () => Date.now();
    const callbacks = [stored];
    const kept = await ctx.step('stored', { input: {}, schema: z.number(), run: stored });
    const outcome = polled.by === 'deadline' ? 0 : polled.value;
    return first + home.length + wrapped + outcome + direct + bound + kept + callbacks.length;
  },
});
