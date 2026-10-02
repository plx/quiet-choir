import { defineWorkflow, z, type WorkflowContext } from '../../../src/index.js';

// The single-use type parameters are the case under test.
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */

async function constrained<C extends WorkflowContext>(
  c: C,
  items: readonly string[],
): Promise<number> {
  for (const item of items) {
    await c.step('again', { input: item, schema: z.string(), run: () => item });
  }
  return Date.now();
}

async function intersected<C extends WorkflowContext & { readonly extra?: string }>(
  c: C,
  items: readonly string[],
): Promise<number> {
  for (const item of items) {
    await c.step('again', { input: item, schema: z.string(), run: () => item });
  }
  return Date.now();
}

// An unconstrained or union-constrained type parameter is not a context, so nothing is reported.
function unconstrained<T>(value: T): number {
  return Date.now() + (value ? 1 : 0);
}

function unioned<C extends WorkflowContext | undefined>(c: C): number {
  return c === undefined ? Date.now() : 0;
}

// A type parameter constrained to the context is still the context, so its hazards are found.
export default defineWorkflow({
  name: 'durability-context-generic',
  version: '1',
  input: z.object({ items: z.array(z.string()) }),
  output: z.number(),
  async run(c, input) {
    return (
      (await constrained(c, input.items)) +
      (await intersected(c, input.items)) +
      unconstrained(1) +
      unioned(c)
    );
  },
});
