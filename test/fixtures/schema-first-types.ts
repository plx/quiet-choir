/* eslint-disable @typescript-eslint/require-await -- Compile the original inference regressions without changing callback shapes. */
// Compiled by both the repository's TypeScript 7 and the CLI's packaged TypeScript 6.
import {
  defineWorkflow,
  z,
  type DeadlineOutcome,
  type ErrorMode,
  type PollOutcome,
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

type Color = PollOutcome<'green' | 'red'> | DeadlineOutcome;

/**
 * Compile-only poll assertions (#320): observer and command callbacks, with and without
 * parameters, keep literal terminal values from conditional and statement returns without
 * `as const`, while `T` still comes only from `schema`. Never execute this function.
 */
export async function polls(ctx: WorkflowContext, ready: boolean): Promise<void> {
  const color = z.enum(['green', 'red']);
  const poll = { input: null, schema: color, every: 1_000, timeoutMs: 60_000 };
  const argv: [string, ...string[]] = ['gh', 'pr', 'checks'];
  const command = { command: argv, output: z.object({ ok: z.boolean() }) };
  const observedConditional: Color = await ctx.poll('observed-conditional', {
    ...poll,
    observe: async () => (ready ? { done: true, value: 'green' } : { done: false }),
  });
  const observedStatements: Color = await ctx.poll('observed-statements', {
    ...poll,
    observe: async () => {
      if (ready) return { done: true, value: 'green' };
      return { done: false };
    },
  });
  const contextConditional: Color = await ctx.poll('context-conditional', {
    ...poll,
    observe: async (context) =>
      context.previous.checks > 2 ? { done: true, value: 'red' } : { done: false },
  });
  const contextStatements: Color = await ctx.poll('context-statements', {
    ...poll,
    observe: async (context) => {
      if (context.previous.checks > 2) return { done: true, value: 'red' };
      return { done: false, note: context.previous.checks };
    },
  });
  const doneConditional: Color = await ctx.poll('done-conditional', {
    ...poll,
    ...command,
    done: () => (ready ? { done: true, value: 'green' } : { done: false }),
  });
  const doneStatements: Color = await ctx.poll('done-statements', {
    ...poll,
    ...command,
    done: () => {
      if (ready) return { done: true, value: 'green' };
      return { done: false };
    },
  });
  const outputConditional: Color = await ctx.poll('output-conditional', {
    ...poll,
    ...command,
    done: (output) => (output.ok ? { done: true, value: 'green' } : { done: false }),
  });
  const outputStatements: Color = await ctx.poll('output-statements', {
    ...poll,
    ...command,
    done: (output) => {
      if (output.ok) return { done: true, value: 'green' };
      return { done: false };
    },
  });
  const asyncDone: Color = await ctx.poll('async-done', {
    ...poll,
    ...command,
    done: async (output) => (output.ok ? { done: true, value: 'green' } : { done: false }),
  });
  // Each rejected call fits on one line: TypeScript 6 reports it at the call, TypeScript 7 at the
  // callback.
  const numeric = { ...poll, schema: z.number() };
  const noted = { ...poll, noteSchema: z.object({ seen: z.boolean() }) };
  // @ts-expect-error 'blue' is not in the enum schema.
  await ctx.poll('blue', { ...poll, observe: async () => ({ done: true, value: 'blue' }) });
  // @ts-expect-error 'blue' is not in the enum schema.
  await ctx.poll('blue-done', { ...poll, ...command, done: () => ({ done: true, value: 'blue' }) });
  // @ts-expect-error A string value does not match a number schema.
  await ctx.poll('numeric', { ...numeric, observe: async () => ({ done: true, value: 'one' }) });
  // @ts-expect-error The note must match noteSchema.
  await ctx.poll('noted', { ...noted, observe: async () => ({ done: false, note: { seen: 1 } }) });
  // ctx.wait poll sources with zero-parameter conditional callbacks, written inline: under
  // TypeScript 7 a spread command source loses its contextual type in ctx.wait.
  const waited = await ctx.wait('waited', {
    timeoutMs: 60_000,
    poll: {
      input: null,
      schema: color,
      every: 1_000,
      observe: async () => (ready ? { done: true, value: 'green' } : { done: false }),
    },
  });
  const waitedDone = await ctx.wait('waited-done', {
    timeoutMs: 60_000,
    poll: {
      input: null,
      schema: color,
      every: 1_000,
      command: argv,
      output: z.object({ ok: z.boolean() }),
      done: () => (ready ? { done: true, value: 'red' } : { done: false }),
    },
  });
  const waitedColor: Color = waited;
  const waitedDoneColor: Color = waitedDone;
  keep(
    observedConditional,
    observedStatements,
    contextConditional,
    contextStatements,
    doneConditional,
    doneStatements,
    outputConditional,
    outputStatements,
    asyncDone,
    waitedColor,
    waitedDoneColor,
  );
}
