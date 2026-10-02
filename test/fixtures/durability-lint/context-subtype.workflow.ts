import { defineWorkflow, z, type WorkflowContext } from '../../../src/index.js';

// The empty subtype is the case under test: it has its own symbol but adds nothing.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface Context extends WorkflowContext {}
type Extended = WorkflowContext & { readonly extra?: string };

async function viaInterface(c: Context, items: readonly string[]): Promise<number> {
  for (const item of items) {
    await c.step('again', { input: item, schema: z.string(), run: () => item });
  }
  return Math.random();
}

async function viaIntersection(c: Extended, items: readonly string[]): Promise<number> {
  for (const item of items) {
    await c.step('again', { input: item, schema: z.string(), run: () => item });
  }
  return Math.random();
}

// A subtype of the context, or an intersection with it, is still the context, so its hazards
// are found.
export default defineWorkflow({
  name: 'durability-context-subtype',
  version: '1',
  input: z.object({ items: z.array(z.string()) }),
  output: z.number(),
  async run(c, input) {
    return (await viaInterface(c, input.items)) + (await viaIntersection(c, input.items));
  },
});
