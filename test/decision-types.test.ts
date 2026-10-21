// Type-level contracts for ctx.decide (ADR 0066 section 1). The workflow is constructed but never
// run: typecheck (`npm run typecheck`) is the assertion, with `@ts-expect-error` on rejected uses
// and `expectTypeOf` for inferred answers.
import { expect, expectTypeOf, it } from 'vitest';
import { defineWorkflow, z, type Settled, type WorkflowContext } from '../src/index.js';
import {
  choice,
  jevCompatible,
  noul,
  score,
  type ChoiceAnswer,
  type DecisionAnswers,
  type NoulAnswer,
  type ScoreAnswer,
} from '../src/integrations/decision.js';

const questions = {
  team: choice({
    instructions: 'Which team owns this?',
    options: { billing: null, infra: null },
  }),
  urgency: score({ instructions: 'How urgent?', levels: ['none', 'this week', 'today', 'now'] }),
  refund: noul({ instructions: 'Does the customer ask for a refund?' }),
};

it('infers answers from the questions', () => {
  const jev = jevCompatible({ name: 'jev', defaultModel: 'jev-latest' });
  const definition = defineWorkflow({
    name: 'types',
    version: '1',
    input: z.null(),
    output: z.null(),
    decisions: [jev],
    run: async (ctx) => {
      const answers = await ctx.decide('triage', { state: { ticket: 'x' }, questions });
      expectTypeOf(answers.team.choice).toEqualTypeOf<'billing' | 'infra'>();
      expectTypeOf(answers.team.probabilities).toEqualTypeOf<
        Readonly<Record<'billing' | 'infra', number>>
      >();
      expectTypeOf(answers.team.confidence).toEqualTypeOf<number>();
      expectTypeOf(answers.urgency.score).toEqualTypeOf<number>();
      expectTypeOf(answers.urgency.legend).toEqualTypeOf<
        readonly ('none' | 'this week' | 'today' | 'now')[]
      >();
      expectTypeOf(answers.urgency.probabilities).toEqualTypeOf<readonly number[]>();
      expectTypeOf(answers.refund.noul).toEqualTypeOf<number>();
      expectTypeOf(answers.refund).toEqualTypeOf<NoulAnswer>();
      expectTypeOf(answers.refund).not.toHaveProperty('confidence');
      // @ts-expect-error noul answers have no confidence, as in the protocol.
      expectTypeOf(answers.refund.confidence).toBeNever();
      // @ts-expect-error only declared question names have answers.
      expectTypeOf(answers.missing).toBeNever();
      expectTypeOf(answers).toEqualTypeOf<DecisionAnswers<typeof questions>>();
      expectTypeOf(answers.team).toEqualTypeOf<ChoiceAnswer<'billing' | 'infra'>>();
      expectTypeOf(answers.urgency).toEqualTypeOf<
        ScoreAnswer<'none' | 'this week' | 'today' | 'now'>
      >();

      const inline = await ctx.decide('inline', {
        provider: 'jev',
        model: 'jev-1',
        state: null,
        questions: { pick: choice({ instructions: 'x', options: { a: 'A', b: null } }) },
        retry: { maxAttempts: 2, on: ['transient'] },
        timeoutMs: 5_000,
      });
      expectTypeOf(inline.pick.choice).toEqualTypeOf<'a' | 'b'>();

      const settled = await ctx.decide('settled', { state: null, questions, onError: 'return' });
      expectTypeOf(settled).toEqualTypeOf<Settled<DecisionAnswers<typeof questions>>>();
      if (settled.ok) expectTypeOf(settled.value.team.choice).toEqualTypeOf<'billing' | 'infra'>();

      // @ts-expect-error state must be JSON.
      await ctx.decide('bad-state', { state: () => null, questions });
      // @ts-expect-error questions are required.
      await ctx.decide('no-questions', { state: null });
      // @ts-expect-error provider is a name.
      await ctx.decide('bad-provider', { state: null, questions, provider: 1 });
      // @ts-expect-error a score needs level names.
      score({ instructions: 'x', levels: [1, 2] });
      // @ts-expect-error choice descriptions are strings or null.
      choice({ instructions: 'x', options: { a: 1 } });
      return null;
    },
  });
  expect(definition.decisions).toHaveLength(1);
});

it('keeps bare contexts assignable and exposes decide on them', () => {
  const helper = (ctx: WorkflowContext) =>
    ctx.decide('helper', { state: null, questions: { refund: noul({ instructions: 'x' }) } });
  expectTypeOf(helper).returns.resolves.toEqualTypeOf<{ readonly refund: NoulAnswer }>();
  expect(typeof helper).toBe('function');
});
