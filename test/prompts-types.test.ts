// Type-level contracts for prompt sets (ADR 0064 section 2, #581). The workflows are constructed
// but never run: typecheck (`npm run typecheck`) is the assertion, with one `@ts-expect-error` per
// rejected call and `expectTypeOf` for inferred results.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, expectTypeOf, it } from 'vitest';
import {
  defineHarness,
  definePrompts,
  defineRoster,
  defineWorkflow,
  z,
  type AgentRequest,
  type AnyPromptSet,
  type Prompt,
  type PromptSet,
  type WorkflowContext,
} from '../src/index.js';

const prompts = definePrompts(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/prompts'), {
  Review: {
    file: 'Review.md',
    params: z.object({
      issue: z.object({ number: z.number() }),
      diff: z.string(),
      limit: z.number().default(3),
    }),
    description: 'Review a diff.',
  },
  Standing: { file: 'Optional.md', params: z.object({ name: z.string(), greeting: z.string() }) },
});
const fake = defineHarness({
  name: 'fake',
  revision: 1,
  options: z.object({ prompt: z.string() }),
  capabilities: { structuredOutput: 'none' },
  access: () => 'none',
});

it('types each prompt function from z.input of its params', () => {
  type Review = typeof prompts.Review;
  expectTypeOf<Parameters<Review>[0]>().toEqualTypeOf<{
    issue: { number: number };
    diff: string;
    limit?: number | undefined;
  }>();
  expectTypeOf<ReturnType<Review>>().toEqualTypeOf<Prompt>();
  expectTypeOf(prompts).toExtend<AnyPromptSet>();
  expectTypeOf(prompts).toExtend<PromptSet>();
  const call = (): void => {
    prompts.Review({ issue: { number: 1 }, diff: '' });
    // @ts-expect-error -- a missing key fails typecheck.
    prompts.Review({ issue: { number: 1 } });
    // @ts-expect-error -- an extra key fails typecheck.
    prompts.Review({ issue: { number: 1 }, diff: '', extra: true });
  };
  expect(typeof call).toBe('function');
});

it('rejects unknown entry keys at typecheck', () => {
  const define = (): void => {
    definePrompts('/p', {
      // @ts-expect-error -- an unknown entry key fails typecheck.
      A: { file: 'A.md', params: z.object({}), descripton: 'misspelled' },
    });
  };
  expect(typeof define).toBe('function');
});

it('accepts a Prompt wherever a prompt or Claude system prompt is a string', () => {
  const definition = defineWorkflow({
    name: 'typed',
    version: '1',
    input: z.null(),
    output: z.null(),
    harnesses: [fake],
    prompts: [prompts],
    roster: defineRoster({
      Reviewer: {
        harness: 'claude',
        appendSystemPrompt: prompts.Standing({ name: 'r', greeting: 'g' }),
      },
    }),
    async run(ctx) {
      const prompt = prompts.Review({ issue: { number: 1 }, diff: '' });
      await ctx.claude.text('a', { prompt, systemPrompt: prompt, appendSystemPrompt: prompt });
      await ctx.codex.text('b', { prompt });
      await ctx.agent('fake').text('c', { prompt });
      await ctx.claude.bind({ systemPrompt: prompt }).text('d', { prompt });
      await ctx.roster.Reviewer.text('e', { prompt });
      return null;
    },
  });
  expect(definition.prompts).toEqual([prompts]);
  const helper = async (ctx: WorkflowContext) =>
    ctx.claude.value('f', { prompt: prompts.Standing({ name: 'r', greeting: 'g' }) });
  expect(typeof helper).toBe('function');
});

it('gives adapters string prompts', () => {
  expectTypeOf<AgentRequest['options']['prompt']>().toEqualTypeOf<string>();
});

it('accepts only definePrompts results as WorkflowDefinition.prompts', () => {
  const define = (): void => {
    defineWorkflow({
      name: 'untyped',
      version: '1',
      input: z.null(),
      output: z.null(),
      // @ts-expect-error -- a plain object of functions is not a prompt set.
      prompts: [{ Review: () => 'x' }],
      run: () => Promise.resolve(null),
    });
  };
  expect(typeof define).toBe('function');
});
