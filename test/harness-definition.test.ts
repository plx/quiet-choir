import { expect, expectTypeOf, it } from 'vitest';
import {
  defineHarness,
  defineWorkflow,
  z,
  type CapabilityKeysOf,
  type HarnessDeclaration,
} from '../src/index.js';
import { checkedDefinition } from '../src/workflow/runtime/definition.js';

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

it('keeps a literal capabilityKeys tuple and widens the list when it is omitted', () => {
  const keyedOptions = z.object({ prompt: z.string(), tools: z.array(z.string()).optional() });
  const keyed = defineHarness({
    name: 'keyed',
    revision: 1,
    options: keyedOptions,
    capabilities: { structuredOutput: 'native' },
    capabilityKeys: ['tools'],
  });
  expectTypeOf(keyed.capabilityKeys).toEqualTypeOf<readonly ['tools'] | undefined>();
  expectTypeOf<CapabilityKeysOf<typeof keyed>>().toEqualTypeOf<'tools'>();
  // An omitted list defaults to the widened key list, which forbids nothing at type level.
  expectTypeOf(review.capabilityKeys).toEqualTypeOf<
    readonly ('prompt' | 'thinking')[] | undefined
  >();
  expectTypeOf<CapabilityKeysOf<typeof review>>().toBeNever();
  // Explicit <N, O, C> type arguments take the same widened default, so capabilityKeys still
  // compiles; call sites stay permissive at type level and the runtime check applies.
  type KeyedOptions = z.infer<typeof keyedOptions>;
  interface KeyedCapabilities {
    readonly structuredOutput: 'native';
  }
  const explicit = defineHarness<'explicit', KeyedOptions, KeyedCapabilities>({
    name: 'explicit',
    revision: 1,
    options: keyedOptions,
    capabilities: { structuredOutput: 'native' },
    capabilityKeys: ['tools'],
  });
  expectTypeOf<CapabilityKeysOf<typeof explicit>>().toBeNever();
  expect(explicit.capabilityKeys).toEqual(['tools']);
  expect(keyed.capabilityKeys).toEqual(['tools']);
  expect(review.capabilityKeys).toBeUndefined();
});

// Sensitive option keys for public capability manifests (#247).
const vaultOptions = z.object({
  prompt: z.string(),
  token: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  maxTurns: z.number().optional(),
  maxBudgetUsd: z.number().optional(),
});
const vaultBase = {
  name: 'vault',
  revision: 1,
  options: vaultOptions,
  capabilities: { structuredOutput: 'none' },
} as const;
const reserved: readonly (readonly [string, string])[] = [
  ['prompt', 'profiles cannot set it'],
  ['profile', 'profiles cannot set it'],
  ['cwd', 'profiles cannot set it'],
  ['onError', 'profiles cannot set it'],
  ['retry', 'profiles cannot set it'],
  ['worktree', 'profiles cannot set it'],
  ['timeoutMs', 'profiles cannot set it'],
  ['idleTimeoutMs', 'profiles cannot set it'],
  ['maxTurns', 'profiles cannot set it'],
  ['maxBudgetUsd', 'profiles cannot set it'],
  ['model', 'the model stays reviewable'],
  ['env', 'environment values never appear in capability manifests'],
];
/** Each invalid list with the error it must raise. */
const invalidSensitive: readonly (readonly [unknown, string | RegExp])[] = [
  [['secret'], 'Harness vault refers to unknown option secret.'],
  ...reserved.map(
    ([key, reason]) =>
      [[key], `Harness vault sensitiveOptions cannot include ${key}: ${reason}`] as const,
  ),
  [['token', 'headers', 'token'], 'Harness vault sensitiveOptions lists token twice.'],
  [[''], /too_small|>=1 characters/u],
  [[42], /expected string/u],
  ['token', /expected array/u],
];

it('accepts sensitiveOptions, passes them through and rejects keys outside the options', () => {
  const vault = defineHarness({ ...vaultBase, sensitiveOptions: ['token', 'headers'] });
  expect(vault.sensitiveOptions).toEqual(['token', 'headers']);
  expectTypeOf(vault.sensitiveOptions).toEqualTypeOf<
    | readonly (
        | 'prompt'
        | 'token'
        | 'headers'
        | 'env'
        | 'maxTurns'
        | 'maxBudgetUsd'
        | 'profile'
        | 'cwd'
        | 'onError'
        | 'retry'
        | 'timeoutMs'
        | 'idleTimeoutMs'
        | 'worktree'
        | 'model'
      )[]
    | undefined
  >();
  expect(defineHarness({ ...vaultBase }).sensitiveOptions).toBeUndefined();
  expect(defineHarness({ ...vaultBase, sensitiveOptions: [] }).sensitiveOptions).toEqual([]);
  // @ts-expect-error sensitiveOptions names keys of the option schema.
  expect(() => defineHarness({ ...vaultBase, sensitiveOptions: ['secret'] })).toThrow(
    'Harness vault refers to unknown option secret.',
  );
  for (const [list, message] of invalidSensitive)
    expect(
      () => defineHarness({ ...vaultBase, sensitiveOptions: list as never }),
      JSON.stringify(list),
    ).toThrow(message);
});

it('rejects the same sensitiveOptions when a workflow registers a raw declaration', () => {
  const workflow = (sensitiveOptions: unknown) =>
    defineWorkflow({
      name: 'vaulted',
      version: '1',
      input: z.null(),
      output: z.null(),
      harnesses: [{ ...vaultBase, sensitiveOptions } as unknown as HarnessDeclaration],
      run: () => Promise.resolve(null),
    });
  expect(checkedDefinition(workflow(['token'])).harnesses?.[0]?.sensitiveOptions).toEqual([
    'token',
  ]);
  for (const [list, message] of invalidSensitive)
    expect(() => checkedDefinition(workflow(list)), JSON.stringify(list)).toThrow(message);
});
