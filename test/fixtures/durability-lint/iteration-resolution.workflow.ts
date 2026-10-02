import { defineWorkflow, z } from '../../../src/index.js';

const text = { input: {}, schema: z.string(), run: () => 'value' };

// A user-defined map() calls its callback once, so a literal ID in it is not a loop.
class Single<T> {
  constructor(private readonly value: T) {}
  map<U>(fn: (value: T) => U): U {
    return fn(this.value);
  }
}

// QC005 only where the call resolves to a standard-library iteration API.
export default defineWorkflow({
  name: 'durability-iteration-resolution',
  version: '1',
  input: z.object({ items: z.array(z.string()) }),
  output: z.string(),
  async run(ctx, input) {
    const single = new Single('only');
    const custom = { map: (fn: () => Promise<string>) => fn() };
    const structural: { map(fn: () => Promise<string>): Promise<string> } = {
      map: async (fn) => fn(),
    };
    const pending: Promise<string>[] = [];
    await single.map(async () => ctx.step('custom-class', text));
    await custom.map(async () => ctx.step('custom-object', text));
    await structural.map(async () => ctx.step('structural', text));
    await Promise.all(input.items.map(async () => ctx.step('array-map', text)));
    input.items.forEach(() => pending.push(ctx.step('array-for-each', text)));
    new Set(input.items).forEach(() => pending.push(ctx.step('set-for-each', text)));
    await Promise.all(Array.from(input.items, async () => ctx.step('array-from', text)));
    // Only the per-item callback repeats: reduce's initial value and forEach's thisArg do not.
    input.items.reduce(
      (total) => total,
      () => ctx.step('reduce-initial', text),
    );
    input.items.forEach(
      () => undefined,
      () => ctx.step('for-each-this-arg', text),
    );
    await Promise.all(pending);
    return 'done';
  },
});
