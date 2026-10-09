/* eslint-disable @typescript-eslint/require-await -- Compile the original inference regressions without changing callback shapes. */
// Compiled by both the repository's TypeScript 7 and the CLI's packaged TypeScript 6.
import {
  defineWorkflow,
  z,
  type DeadlineOutcome,
  type ErrorMode,
  type PollContext,
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
  // A callback that is not async may wrap its result in Promise.resolve, with or without a
  // parameter, and a callback with a parameter may build its value with a nested generic call such
  // as map: each keeps the schema's contextual literal types, as with the explicit overloads.
  const resolved: Color = await ctx.poll('resolved', {
    ...poll,
    observe: () => Promise.resolve(ready ? { done: true, value: 'green' } : { done: false }),
  });
  const contextResolved: Color = await ctx.poll('context-resolved', {
    ...poll,
    observe: (context) =>
      Promise.resolve(
        context.previous.checks > 0 ? { done: true, value: 'green' } : { done: false },
      ),
  });
  const outputResolved: Color = await ctx.poll('output-resolved', {
    ...poll,
    ...command,
    done: (output) => Promise.resolve(output.ok ? { done: true, value: 'green' } : { done: false }),
  });
  const states = { ...poll, schema: z.array(z.object({ state: color })) };
  const contextMapped = await ctx.poll('context-mapped', {
    ...states,
    observe: async (context) => ({
      done: true,
      value: [context.previous.checks].map(() => ({ state: 'green' })),
    }),
  });
  const outputMapped = await ctx.poll('output-mapped', {
    ...states,
    ...command,
    done: (output) => ({ done: true, value: [output.ok].map(() => ({ state: 'red' })) }),
  });
  const mapped: { state: 'green' | 'red' }[][] = [contextMapped, outputMapped].flatMap((outcome) =>
    outcome.by === 'poll' ? [outcome.value] : [],
  );
  // A rest parameter gets the explicit overloads' parameter types, also beside another callback
  // without annotations. An annotated observer gets no contextual return type, so its
  // Promise.reject result stays Promise<never>, as before the inferred overload existed; these calls
  // are not assigned, because an annotated result type would supply `T` to Promise.reject.
  const restObserved: Color = await ctx.poll('rest-observed', {
    ...poll,
    observe: async (...args) =>
      args[0].previous.checks > 2 ? { done: true, value: 'green' } : { done: false },
  });
  const restDone: Color = await ctx.poll('rest-done', {
    ...poll,
    ...command,
    done: (...[output, previous]) =>
      output.ok && previous.checks > 0 ? { done: true, value: 'green' } : { done: false },
  });
  const restClassified: Color = await ctx.poll('rest-classified', {
    ...poll,
    ...command,
    onError: {
      tolerate: 1,
      classify: (error) => (error instanceof TypeError ? 'fatal' : 'transient'),
    },
    done: async (...args) => (args[0].ok ? { done: true, value: 'red' } : { done: false }),
  });
  await ctx.poll('rejected', {
    ...poll,
    observe: (context: PollContext) => Promise.reject(new Error(String(context.previous.checks))),
  });
  await ctx.poll('async-rejected', {
    ...poll,
    observe: async (context: PollContext) =>
      Promise.reject(new Error(String(context.previous.checks))),
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
  // An all-optional (weak) object schema or noteSchema still rejects a primitive, which matches no
  // property: TypeScript skips its weak-type check where the callback meets the schema's type.
  const weak = { ...poll, schema: z.object({ n: z.number().optional() }) };
  const weakNoted = { ...poll, noteSchema: z.object({ seen: z.boolean().optional() }) };
  // @ts-expect-error A string is not a value of an all-optional object schema.
  await ctx.poll('weak', { ...weak, observe: async () => ({ done: true, value: 'x' }) });
  // @ts-expect-error A string is not a value of an all-optional object schema.
  await ctx.poll('weak-done', { ...weak, ...command, done: () => ({ done: true, value: 'x' }) });
  // @ts-expect-error A number is not a note of an all-optional object noteSchema.
  await ctx.poll('weak-note', { ...weakNoted, observe: async () => ({ done: false, note: 1 }) });
  // @ts-expect-error A string is not a note of an all-optional object noteSchema.
  await ctx.poll('wn-done', { ...weakNoted, ...command, done: () => ({ done: false, note: 'x' }) });
  const weakValues: (PollOutcome<{ n?: number | undefined }> | DeadlineOutcome)[] = [
    await ctx.poll('weak-full', {
      ...weak,
      observe: async () => ({ done: true, value: { n: 1 } }),
    }),
    await ctx.poll('weak-empty', { ...weak, observe: async () => ({ done: true, value: {} }) }),
    await ctx.poll('weak-full-done', {
      ...weak,
      ...command,
      done: () => (ready ? { done: true, value: { n: 1 } } : { done: true, value: {} }),
    }),
  ];
  await ctx.poll('weak-noted', {
    ...weakNoted,
    observe: async () =>
      ready ? { done: false, note: { seen: true } } : { done: false, note: {} },
  });
  await ctx.poll('weak-noted-done', {
    ...weakNoted,
    ...command,
    done: () => ({ done: false, note: { seen: false } }),
  });
  // A parameter annotation cannot supply the note type, which comes only from noteSchema. Both
  // compilers report these at the callback.
  type Seen = PollContext<{ seen: boolean }>;
  await ctx.poll('seen', {
    ...poll,
    // @ts-expect-error Without noteSchema the context's note is any JSON value.
    observe: async (context: Seen) => ({ done: false, note: context.previous.note }),
  });
  await ctx.poll('seen-done', {
    ...poll,
    ...command,
    // @ts-expect-error Without noteSchema the previous note is any JSON value.
    done: (_output, previous: Seen['previous']) => ({ done: false, note: previous.note }),
  });
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
    resolved,
    contextResolved,
    outputResolved,
    mapped,
    restObserved,
    restDone,
    restClassified,
    weakValues,
    waitedColor,
    waitedDoneColor,
  );
}

type Numbers = PollOutcome<number[]> | DeadlineOutcome;

/**
 * Compile-only poll assertions for array and tuple results: the inferred overload captures a
 * callback's result as a `const` type parameter, which makes an array literal a readonly tuple, and
 * still accepts it against array and tuple schemas and an array `noteSchema`, in both forms. A
 * wrong element type is still rejected. Never execute this function.
 */
export async function pollArrays(ctx: WorkflowContext, ready: boolean): Promise<void> {
  const poll = { input: null, every: 1_000, timeoutMs: 60_000 };
  const argv: [string, ...string[]] = ['gh', 'pr', 'checks'];
  const command = { command: argv, output: z.object({ ok: z.boolean() }) };
  const numbers = { ...poll, schema: z.array(z.number()) };
  const nested = { ...poll, schema: z.object({ ids: z.array(z.string()) }) };
  const pair = { ...poll, schema: z.tuple([z.string(), z.number()]) };
  const listed = { ...poll, schema: z.number(), noteSchema: z.array(z.string()) };
  const observedArray: Numbers = await ctx.poll('observed-array', {
    ...numbers,
    observe: async () => (ready ? { done: true, value: [1, 2] } : { done: false }),
  });
  const doneArray: Numbers = await ctx.poll('done-array', {
    ...numbers,
    ...command,
    done: () => (ready ? { done: true, value: [1, 2] } : { done: false }),
  });
  const contextArray: Numbers = await ctx.poll('context-array', {
    ...numbers,
    observe: async (context) => ({ done: true, value: [context.previous.checks] }),
  });
  const observedNested = await ctx.poll('observed-nested', {
    ...nested,
    observe: async () => {
      if (ready) return { done: true, value: { ids: ['a', 'b'] } };
      return { done: false };
    },
  });
  const doneNested = await ctx.poll('done-nested', {
    ...nested,
    ...command,
    done: (output) => (output.ok ? { done: true, value: { ids: ['a'] } } : { done: false }),
  });
  const observedPair = await ctx.poll('observed-pair', {
    ...pair,
    observe: async () => ({ done: true, value: ['a', 1] }),
  });
  const donePair = await ctx.poll('done-pair', {
    ...pair,
    ...command,
    done: () => ({ done: true, value: ['a', 1] }),
  });
  await ctx.poll('observed-note', {
    ...listed,
    observe: async () => (ready ? { done: true, value: 1 } : { done: false, note: ['a', 'b'] }),
  });
  await ctx.poll('done-note', {
    ...listed,
    ...command,
    done: () => (ready ? { done: true, value: 1 } : { done: false, note: ['a', 'b'] }),
  });
  // Without noteSchema a note is any JSON value, readonly literals included.
  await ctx.poll('json-note', {
    ...numbers,
    observe: async () => ({ done: false, note: [1, { ids: ['a'] }] }),
  });
  // The outcome keeps the schema's own (mutable) types: the runtime parses the value with schema.
  const ids: { ids: string[] } | undefined =
    observedNested.by === 'poll' ? observedNested.value : undefined;
  const pairs: [string, number] | undefined = donePair.by === 'poll' ? donePair.value : undefined;
  // Each rejected call fits on one line, as in polls().
  // @ts-expect-error A string element does not match a number array schema.
  await ctx.poll('strings', { ...numbers, observe: async () => ({ done: true, value: ['x'] }) });
  // @ts-expect-error A string element does not match a number array schema.
  await ctx.poll('str', { ...numbers, ...command, done: () => ({ done: true, value: ['x'] }) });
  // @ts-expect-error A nested element must match its array schema.
  await ctx.poll('nest', { ...nested, observe: async () => ({ done: true, value: { ids: [1] } }) });
  // @ts-expect-error A tuple's elements must match in order.
  await ctx.poll('pair-wrong', { ...pair, observe: async () => ({ done: true, value: [1, 'a'] }) });
  // @ts-expect-error A tuple's length must match.
  await ctx.poll('pair', { ...pair, observe: async () => ({ done: true, value: ['a', 1, 2] }) });
  // @ts-expect-error The note's elements must match noteSchema.
  await ctx.poll('note-wrong', { ...listed, observe: async () => ({ done: false, note: [1] }) });
  // @ts-expect-error The note's elements must match noteSchema.
  await ctx.poll('note', { ...listed, ...command, done: () => ({ done: false, note: [1] }) });
  keep(observedArray, doneArray, contextArray, doneNested, observedPair, ids, pairs);
}
