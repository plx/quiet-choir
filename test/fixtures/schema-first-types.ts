/* eslint-disable @typescript-eslint/require-await -- Compile the original inference regressions without changing callback shapes. */
// Compiled by both the repository's TypeScript 7 and the CLI's packaged TypeScript 6.
import {
  defineWorkflow,
  z,
  type ErrorMode,
  type Settled,
  type WorkflowContext,
} from '../../src/index.js';

/** Marks compile-only bindings as used without the `void` operator. */
function keep(...values: unknown[]): unknown[] {
  return values;
}

export const literal = defineWorkflow({
  name: 'literal',
  version: '1',
  input: z.object({}),
  output: z.object({ verdict: z.enum(['pass', 'fail']) }),
  async run(ctx, input) {
    keep(ctx, input);
    return { verdict: 'pass' };
  },
});

export const widened = defineWorkflow({
  name: 'widened',
  version: '1',
  input: z.object({ n: z.number().optional() }),
  output: z.object({ n: z.number() }),
  // @ts-expect-error A callback cannot widen the output schema to include undefined.
  async run(_ctx, input) {
    return { n: input.n };
  },
});

/** Compile-only assertions; never execute this function. */
export async function types(ctx: WorkflowContext, mode: ErrorMode): Promise<void> {
  await ctx.step('wrong', {
    input: null,
    schema: z.number(),
    // @ts-expect-error A callback cannot widen the step schema to include undefined.
    run: () => (Math.random() > 0.5 ? 1 : undefined),
  });
  await ctx.step('async-literal', {
    input: null,
    schema: z.enum(['a', 'b']),
    // @ts-expect-error Zero-argument async callbacks widen a bare literal; use as const.
    run: async () => 'a',
  });
  const ambiguous = { prompt: 'p', schema: Math.random() > 0.5 ? z.number() : undefined };
  // @ts-expect-error An optional schema must not silently infer a text response.
  await ctx.claude.value('ambiguous', ambiguous);
  const step: 'a' | 'b' = await ctx.step('literal', {
    input: { omitted: undefined },
    schema: z.enum(['a', 'b']),
    run: async () => 'a' as const,
  });
  const object: { n: number } = await ctx.claude.value('object', {
    prompt: 'p',
    schema: z.object({ n: z.number() }),
  });
  const text: string = await ctx.codex.value('text', { prompt: 'p' });
  const settled: Settled<{ n: number }> = await ctx.codex.value('settled', {
    prompt: 'p',
    schema: z.object({ n: z.number() }),
    onError: 'return',
  });
  const dynamic: { n: number } | Settled<{ n: number }> = await ctx.claude.value('dynamic', {
    prompt: 'p',
    schema: z.object({ n: z.number() }),
    onError: mode,
  });
  const settledText: Settled<string> = await ctx.claude.value('settled-text', {
    prompt: 'p',
    onError: 'return',
  });
  const dynamicText: string | Settled<string> = await ctx.codex.value('dynamic-text', {
    prompt: 'p',
    onError: mode,
  });
  keep(step, object, text, settled, dynamic, settledText, dynamicText);
}
