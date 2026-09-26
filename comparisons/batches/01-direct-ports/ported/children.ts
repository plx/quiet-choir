import { type WorkflowContext, type WorkflowDefinition } from 'quiet-choir';
import { normalize, scopedContext } from './support.js';

// Composition shares the parent's durable run with a disjoint namespace.
// Do not wrap a child in ctx.step: its own agent steps must remain top-level effects.
export async function runChild<I, O>(
  ctx: WorkflowContext,
  id: string,
  definition: WorkflowDefinition<I, O>,
  input: unknown,
): Promise<O> {
  const parsed = definition.input.parse(normalize(input));
  return definition.output.parse(await definition.run(scopedContext(ctx, id), parsed));
}
