import { type WorkflowContext, z } from '../../../../src/index.js';

// Callbacks and helpers in another module: the lint never follows them (#326).
export const importedRun = (): number => Date.now();

export async function importedHelper(ctx: WorkflowContext): Promise<number> {
  return ctx.step('imported', { input: {}, schema: z.number(), run: () => 1 });
}

export const callbacks = { run: (): number => Date.now() };

export function makeRun(): () => number {
  return () => Date.now();
}
