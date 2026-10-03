import { expect, expectTypeOf, it } from 'vitest';
import { defineHarness, defineWorkflow, z, type HarnessDeclaration } from '../src/index.js';

const review = defineHarness({
  name: 'review',
  revision: 1,
  options: z.object({ prompt: z.string(), thinking: z.enum(['low', 'high']).optional() }),
  capabilities: { structuredOutput: 'native' },
  access: () => 'none',
  createAdapter: () => ({
    invoke: (request) =>
      Promise.resolve({ text: request.options.thinking ?? 'low', sessionId: null }),
  }),
});
const plain = defineHarness({
  name: 'plain',
  revision: 1,
  options: z.object({ prompt: z.string() }),
  capabilities: { structuredOutput: 'none' },
  access: () => 'none',
});
const declarations: readonly HarnessDeclaration[] = [review, plain];
const definition = defineWorkflow({
  name: 'registry-types',
  version: '1',
  harnesses: [review, plain],
  input: z.object({ name: z.enum(['claude', 'codex', 'review']) }),
  output: z.null(),
  async run(ctx, input) {
    await ctx
      .agent('review')
      .object('review', { prompt: 'x', thinking: 'high', schema: z.object({ ok: z.boolean() }) });
    await ctx.agent(input.name).text('dynamic', { prompt: 'x' });
    await ctx.agent('plain').value('plain', { prompt: 'x' });
    await ctx.within('scope').agent('review').text('scoped', { prompt: 'x', thinking: 'low' });
    // @ts-expect-error Only declared harness names are callable.
    ctx.agent('undeclared');
    // @ts-expect-error An adapter's option schema owns its option names.
    await ctx.agent('review').text('unknown-option', { prompt: 'x', sandbox: 'read-only' });

    // @ts-expect-error Text-only harnesses have no structured client.
    await ctx.agent('plain').object('bad-object', { prompt: 'x', schema: z.null() }); // eslint-disable-line @typescript-eslint/no-unsafe-call -- Intentional negative type test.
    // @ts-expect-error Text-only value calls cannot sneak in a schema.
    await ctx.agent('plain').value('bad-value', { prompt: 'x', schema: z.null() });
    return null;
  },
});

it('retains literal registrations, typed adapter options and strict option validation', () => {
  expect(definition.harnesses?.map((entry) => entry.name)).toEqual(['review', 'plain']);
  expect(declarations).toHaveLength(2);
  expect(review.options.parse({ prompt: 'x', thinking: 'high' })).toEqual({
    prompt: 'x',
    thinking: 'high',
  });
  expect(() => review.options.parse({ prompt: 'x', extra: true })).toThrow();
});

it('rejects invalid registration identities and policy declarations', () => {
  expect(() => defineHarness({ ...review, name: 'Bad/name' })).toThrow();
  expect(() => defineHarness({ ...review, revision: 0 })).toThrow();
  expect(() => defineHarness({ ...review, policy: ['prompt'] })).toThrow('cannot exclude prompt');
  expect(() =>
    defineHarness({
      name: 'profiled',
      revision: 1,
      capabilities: review.capabilities,
      options: z.object({ prompt: z.string(), profile: z.string().optional() }),
      capabilityKeys: ['profile'],
    }),
  ).toThrow('capabilityKeys cannot include profile');
  expect(() =>
    defineHarness({
      name: 'invalid',
      revision: 1,
      capabilities: review.capabilities,
      options: z.custom<{ prompt: string }>(),
    }),
  ).toThrow('Zod object schema');
});

it('keeps a literal capabilityKeys tuple and infers an empty tuple when it is omitted', () => {
  const keyed = defineHarness({
    name: 'keyed',
    revision: 1,
    options: z.object({ prompt: z.string(), tools: z.array(z.string()).optional() }),
    capabilities: { structuredOutput: 'native' },
    capabilityKeys: ['tools'],
  });
  expectTypeOf(keyed.capabilityKeys).toEqualTypeOf<readonly ['tools'] | undefined>();
  expectTypeOf(review.capabilityKeys).toEqualTypeOf<readonly [] | undefined>();
  expect(keyed.capabilityKeys).toEqual(['tools']);
  expect(review.capabilityKeys).toBeUndefined();
});
