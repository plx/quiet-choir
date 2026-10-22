// Type-level contracts for rosters (ADR 0063 sections 3-4, #579). The workflows are constructed
// but never run: typecheck (`npm run typecheck`) is the assertion, with one `@ts-expect-error` per
// rejected entry or name and `expectTypeOf` for inferred results.
import { expect, expectTypeOf, it } from 'vitest';
import {
  defineHarness,
  defineRoster,
  defineTeam,
  defineWorkflow,
  z,
  type Agent,
  type AgentResult,
  type DeepReadonlyOption,
  type RegisteredAgentClient,
  type RosterAgentOf,
  type RosterAgents,
  type RosterDecider,
  type RosterDeciderEntry,
  type RosterEntry,
  type Settled,
  type WorkflowContext,
  type WorkflowDefinition,
} from '../src/index.js';
import { choice, defineDecisionProvider, noul, score } from '../src/integrations/decision.js';

const base = { version: '1', input: z.null(), output: z.null() } as const;
const prompt = 'x';
const Review = z.object({ verdict: z.string() });
const fake = defineHarness({
  name: 'fake',
  revision: 1,
  options: z.object({
    prompt: z.string(),
    thinking: z.enum(['shallow', 'deep']).optional(),
    addDirs: z.array(z.string()).optional(),
  }),
  capabilities: { structuredOutput: 'native' },
  access: () => 'read',
});
const plain = defineHarness({
  ...fake,
  name: 'plain',
  capabilities: { structuredOutput: 'none' },
});

const roster = defineRoster(
  {
    Reviewer: {
      harness: 'claude',
      model: 'opus',
      effort: 'high',
      tools: ['Read', 'Grep'],
      maxTurns: 40,
      appendSystemPrompt: 'Review carefully.',
      description: 'Reviews.',
      expectsToolUse: true,
    },
    Mechanic: {
      harness: 'codex',
      model: 'gpt-5-codex',
      effort: 'high',
      sandbox: 'workspace-write',
      timeoutMs: 1_800_000,
    },
    Scout: { harness: 'fake', thinking: 'deep', addDirs: ['notes'] },
    Summarizer: { harness: 'plain' },
  },
  { harnesses: [fake, plain] },
);

/** A helper that takes any structured agent, as a team slot will. */
async function reviewWith(agent: Agent): Promise<{ verdict: string }> {
  return agent.value('review', { prompt, schema: Review });
}
/** A helper that takes any agent, text-only included. */
async function summarize(agent: Agent<{ structuredOutput: 'none' }>): Promise<string> {
  return agent.value('summary', { prompt });
}
/** A bare context helper, as shared workflow libraries write them. */
async function helper(ctx: WorkflowContext): Promise<string> {
  return (await ctx.claude.text('helper', { prompt })).output;
}
/** A helper that takes any definition. */
function described(definition: WorkflowDefinition<null, null>): string {
  return definition.name;
}

export const typed = defineWorkflow({
  ...base,
  name: 'roster-types',
  harnesses: [fake, plain],
  roster,
  async run(ctx) {
    expectTypeOf(await ctx.roster.Reviewer.value('r', { prompt, schema: Review })).toEqualTypeOf<{
      verdict: string;
    }>();
    expectTypeOf(await ctx.roster.Reviewer.text('t', { prompt })).toEqualTypeOf<
      AgentResult<string>
    >();
    expectTypeOf(await ctx.roster.Mechanic.object('o', { prompt, schema: Review })).toEqualTypeOf<
      AgentResult<{ verdict: string }>
    >();
    expectTypeOf(await ctx.roster.Scout.value('s', { prompt, schema: Review })).toEqualTypeOf<{
      verdict: string;
    }>();

    expectTypeOf(ctx.roster).not.toHaveProperty('Reviwer');
    // @ts-expect-error -- a misspelled entry name fails typecheck.
    expectTypeOf(ctx.roster.Reviwer).toBeUnknown();
    // The prefix-bound context keeps the typed roster.
    expectTypeOf(
      await ctx.within('p').roster.Reviewer.value('r', { prompt, schema: Review }),
    ).toEqualTypeOf<{ verdict: string }>();

    // @ts-expect-error -- and still rejects a misspelling.
    expectTypeOf(ctx.within('p').roster.Reviwer).toBeUnknown();

    // Calls take only the per-call keys; everything else is fixed by the entry.
    await ctx.roster.Reviewer.text('placed', {
      prompt,
      cwd: 'pkg',
      worktree: true,
      addDirs: ['docs'],
      onError: 'throw',
      retry: { maxAttempts: 2 },
      timeoutMs: 1,
      idleTimeoutMs: 1,
    });
    // @ts-expect-error -- model is fixed by the entry.
    await ctx.roster.Reviewer.text('t', { prompt, model: 'haiku' });
    // @ts-expect-error -- the role is fixed by the entry.
    await ctx.roster.Reviewer.text('t', { prompt, profile: 'Mechanic' });
    // Codex-backed agents take per-call images.
    await ctx.roster.Mechanic.text('i', { prompt, images: ['shot.png'] });
    // @ts-expect-error -- Claude-backed agents do not.
    await ctx.roster.Reviewer.text('i', { prompt, images: ['shot.png'] });

    // A text-only registration gives a text-only agent.
    expectTypeOf(await ctx.roster.Summarizer.value('t', { prompt })).toEqualTypeOf<string>();

    // @ts-expect-error -- no structured calls on a text-only agent.
    expectTypeOf(ctx.roster.Summarizer.object).toBeUnknown();
    // @ts-expect-error -- and no schema-bearing value.
    await ctx.roster.Summarizer.value('v', { prompt, schema: Review });
    await summarize(ctx.roster.Summarizer);
    // @ts-expect-error -- a text-only agent cannot fill a structured slot.
    await reviewWith(ctx.roster.Summarizer);

    // Built-in and structured registered agents fill an Agent slot.
    await reviewWith(ctx.roster.Reviewer);
    await reviewWith(ctx.roster.Mechanic);
    await reviewWith(ctx.roster.Scout);
    // A typed context still reaches a bare-context helper.
    await helper(ctx);
    await helper(ctx.within('p'));
    return null;
  },
});

it('keeps typed definitions assignable to unparameterized definition parameters', () => {
  expect(described(typed)).toBe('roster-types');
  expectTypeOf(typed).toExtend<WorkflowDefinition<null, null>>();
});

it('types ctx.roster from the entry names and harnesses', () => {
  type Agents = RosterAgents<typeof roster>;
  expectTypeOf<keyof Agents>().toEqualTypeOf<'Reviewer' | 'Mechanic' | 'Scout' | 'Summarizer'>();
  expectTypeOf<Agents['Reviewer']>().toEqualTypeOf<Agent>();
  // A registered entry gives what bind gives: the harness's own bound call options.
  type Summarizer = RegisteredAgentClient<
    { readonly prompt: string; addDirs?: string[] | undefined },
    { readonly structuredOutput: 'none' }
  >;
  expectTypeOf<Agents['Summarizer']>().toExtend<Summarizer>();
  expectTypeOf<Summarizer>().toExtend<Agents['Summarizer']>();
  expectTypeOf<Agents['Summarizer']>().not.toHaveProperty('object');
  type Scout = RegisteredAgentClient<
    { readonly prompt: string; addDirs?: string[] | undefined },
    { readonly structuredOutput: 'native' }
  >;
  type ScoutAgent = RosterAgentOf<(typeof roster)['Scout'], readonly [typeof fake]>;
  expectTypeOf<ScoutAgent>().toExtend<Scout>();
  expectTypeOf<Scout>().toExtend<ScoutAgent>();
  expectTypeOf<ScoutAgent>().toHaveProperty('object');
  // A bare context reads any name, as a possibly text-only agent.
  expectTypeOf<WorkflowContext['roster']>().toEqualTypeOf<
    RosterAgents<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  >();
});

it('keeps a call option the registered schema requires unless the entry binds it', () => {
  const rooted = defineHarness({
    name: 'rooted',
    revision: 1,
    options: z.object({ prompt: z.string(), addDirs: z.array(z.string()) }),
    capabilities: { structuredOutput: 'native' },
    access: () => 'read',
  });
  const quiet = defineHarness({
    ...rooted,
    name: 'quiet',
    capabilities: { structuredOutput: 'none' },
  });
  const definition = defineWorkflow({
    ...base,
    name: 'roster-required',
    harnesses: [rooted, quiet],
    roster: defineRoster(
      {
        Open: { harness: 'rooted' },
        Bound: { harness: 'rooted', addDirs: ['docs'] },
        Quiet: { harness: 'quiet', addDirs: ['docs'] },
      },
      { harnesses: [rooted, quiet] },
    ),
    async run(ctx) {
      // @ts-expect-error -- the schema requires addDirs and the entry leaves it to each call.
      await ctx.roster.Open.text('t', { prompt });
      await ctx.roster.Open.text('t', { prompt, addDirs: ['src'] });
      // The entry binds addDirs, so a call may omit it, or append to it.
      await ctx.roster.Bound.text('t', { prompt });
      await ctx.roster.Bound.text('t', { prompt, addDirs: ['src'] });
      // As with bind.
      const bound = ctx.agent('rooted').bind({ addDirs: ['docs'] });
      expectTypeOf(ctx.roster.Bound).toExtend<typeof bound>();
      expectTypeOf(bound).toExtend<typeof ctx.roster.Bound>();
      // A text-only registration still gives a text-only agent.
      expectTypeOf(await ctx.roster.Quiet.value('t', { prompt })).toEqualTypeOf<string>();
      expectTypeOf(ctx.roster.Quiet).not.toHaveProperty('object');
      return null;
    },
  });
  expect(definition.name).toBe('roster-required');
});

it('leaves a workflow without a roster with no entries', () => {
  const none = defineWorkflow({
    ...base,
    name: 'no-roster',
    run(ctx) {
      expectTypeOf(ctx.roster).toEqualTypeOf<{}>(); // eslint-disable-line @typescript-eslint/no-empty-object-type
      // @ts-expect-error -- no roster, no entries.
      expectTypeOf(ctx.roster.Reviewer).toBeUnknown();
      return Promise.resolve(null);
    },
  });
  expectTypeOf(none.run).parameter(0).toHaveProperty('roster');
  expect(none.name).toBe('no-roster');
});

it('types each entry from its own harness options', () => {
  const claude = defineRoster({
    Reviewer: {
      harness: 'claude',
      tools: ['Read'],
      maxTurns: 10,
      maxBudgetUsd: 1,
      appendSystemPrompt: 'x',
      addDirs: ['docs'],
      isolation: 'restricted',
    },
  });
  const codex = defineRoster({
    Mechanic: { harness: 'codex', sandbox: 'workspace-write', effort: 'high', networkAccess: true },
  });
  const registered = defineRoster(
    { Scout: { harness: 'fake', thinking: 'shallow' } },
    { harnesses: [fake] },
  );
  // Never called: each of these would also throw or fail validation at runtime.
  const rejected = () => {
    defineRoster({
      // @ts-expect-error -- sandbox is a Codex option.
      Reviewer: { harness: 'claude', sandbox: 'workspace-write' },
    });
    defineRoster({
      // @ts-expect-error -- no cross-harness block.
      Reviewer: { harness: 'claude', codex: {} },
    });
    defineRoster({
      // @ts-expect-error -- the prompt is per call.
      Reviewer: { harness: 'claude', prompt: 'x' },
    });
    defineRoster({
      // @ts-expect-error -- cwd is per call.
      Reviewer: { harness: 'claude', cwd: 'pkg' },
    });
    defineRoster({
      // @ts-expect-error -- an entry is the role; it names no profile.
      Reviewer: { harness: 'claude', profile: 'text' },
    });
    defineRoster({
      // @ts-expect-error -- entries have no inheritance.
      Reviewer: { harness: 'claude', extends: 'readonly' },
    });
    defineRoster({
      // @ts-expect-error -- tools are a Claude option.
      Mechanic: { harness: 'codex', tools: ['Read'] },
    });
    defineRoster({
      // @ts-expect-error -- images are per call.
      Mechanic: { harness: 'codex', images: ['x.png'] },
    });
    defineRoster(
      {
        // @ts-expect-error -- tools are a Claude option, not the fake harness's.
        Scout: { harness: 'fake', tools: ['Read'] },
      },
      { harnesses: [fake] },
    );
    // @ts-expect-error -- the fake harness's own option values are checked.
    defineRoster({ Scout: { harness: 'fake', thinking: 'bogus' } }, { harnesses: [fake] });
    // @ts-expect-error -- an unregistered harness is not a harness.
    defineRoster({ Scout: { harness: 'fake', thinking: 'deep' } });
    // @ts-expect-error -- 'none' is a Codex effort level; Claude does not take it.
    defineRoster({ Reviewer: { harness: 'claude', effort: 'none' } });
  };
  defineRoster({ Mechanic: { harness: 'codex', effort: 'none' } });
  expect([claude, codex, registered, rejected]).toHaveLength(4);
});

it('makes registered harness options readonly at every depth, keeping tuples', () => {
  const shaped = defineHarness({
    name: 'shaped',
    revision: 1,
    options: z.object({
      prompt: z.string(),
      filters: z.object({ paths: z.array(z.string()), depth: z.number() }).optional(),
      pair: z.tuple([z.string(), z.number()]).optional(),
    }),
    capabilities: { structuredOutput: 'native' },
    access: () => 'read',
  });
  const nested = defineRoster(
    { Scout: { harness: 'shaped', filters: { paths: ['src', 'test'], depth: 2 }, pair: ['a', 1] } },
    { harnesses: [shaped] },
  );
  expectTypeOf<DeepReadonlyOption<[string, number]>>().toEqualTypeOf<readonly [string, number]>();
  expectTypeOf<DeepReadonlyOption<{ paths: string[] } | undefined>>().toEqualTypeOf<
    { readonly paths: readonly string[] } | undefined
  >();
  // Never called: each of these would also fail validation at runtime.
  const rejected = () => {
    // @ts-expect-error -- the tuple's positions are kept, so a reversed pair is refused.
    defineRoster({ Scout: { harness: 'shaped', pair: [1, 'a'] } }, { harnesses: [shaped] });
    defineRoster(
      // @ts-expect-error -- nested option values are still checked.
      { Scout: { harness: 'shaped', filters: { paths: [1], depth: 2 } } },
      { harnesses: [shaped] },
    );
  };
  expect([nested, rejected]).toHaveLength(2);
});

it('accepts only a defineRoster result as a workflow roster', () => {
  const inline = defineWorkflow({
    ...base,
    name: 'inline',
    // @ts-expect-error -- an inline literal bypasses the per-harness typing.
    roster: { Reviewer: { harness: 'claude' } },
    run: () => Promise.resolve(null),
  });
  expect(inline.name).toBe('inline');
});

it('types a decider entry as ctx.decide with the provider and model fixed', () => {
  const jev = defineDecisionProvider({
    name: 'jev',
    revision: 1,
    capabilities: {
      kinds: ['noul', 'choice', 'score'],
      maxOptions: 255,
      levels: [2, 10],
      idempotencyKey: false,
    },
    transport: () => () => Promise.resolve({ body: {} }),
  });
  const deciders = defineRoster({
    Triage: { decider: 'jev', model: 'jev-1', description: 'Routes tickets.' },
    Default: { decider: 'jev' },
    Writer: { harness: 'claude' },
  });
  const questions = {
    refund: noul({ instructions: 'Refund?' }),
    route: choice({ instructions: 'Which team?', options: { billing: null, support: null } }),
    urgency: score({ instructions: 'How urgent?', levels: ['low', 'high'] }),
  };
  const Pair = defineTeam({ actor: 'Acts.', critic: 'Judges.' });
  const definition = defineWorkflow({
    ...base,
    name: 'roster-deciders',
    decisions: [jev],
    roster: deciders,
    async run(ctx) {
      expectTypeOf(ctx.roster.Triage).toEqualTypeOf<RosterDecider>();
      const answers = await ctx.roster.Triage.decide('triage', { state: { n: 1 }, questions });
      expectTypeOf(answers.route.choice).toEqualTypeOf<'billing' | 'support'>();
      expectTypeOf(answers.urgency.score).toEqualTypeOf<number>();
      expectTypeOf(answers.refund).not.toHaveProperty('confidence');
      // The roster call and ctx.decide infer the same answers.
      const direct = await ctx.decide('direct', { provider: 'jev', state: null, questions });
      expectTypeOf(answers).toEqualTypeOf(direct);
      expectTypeOf(
        await ctx.roster.Default.decide('settled', { state: null, questions, onError: 'return' }),
      ).toEqualTypeOf<Settled<typeof answers>>();
      await ctx.within('p').roster.Triage.decide('scoped', {
        state: null,
        questions,
        retry: { maxAttempts: 2 },
        timeoutMs: 1,
      });

      // @ts-expect-error -- the entry fixes the provider.
      await ctx.roster.Triage.decide('t', { provider: 'jev', state: null, questions });
      // @ts-expect-error -- and the model.
      await ctx.roster.Triage.decide('t', { model: 'x', state: null, questions });
      // A decider is not an agent: no text, value, object or bind.
      expectTypeOf(ctx.roster.Triage).not.toHaveProperty('text');
      expectTypeOf(ctx.roster.Triage).not.toHaveProperty('value');
      expectTypeOf(ctx.roster.Triage).not.toHaveProperty('object');
      expectTypeOf(ctx.roster.Triage).not.toHaveProperty('bind');
      // @ts-expect-error -- so a helper taking an Agent rejects it.
      await reviewWith(ctx.roster.Triage);
      // @ts-expect-error -- so it cannot fill a team slot.
      Pair.from({ actor: ctx.roster.Writer, critic: ctx.roster.Triage });
      // A roster holding a decider still fills slots that name agent entries.
      Pair.from({ ...ctx.roster, actor: ctx.roster.Writer, critic: ctx.roster.Writer });
      return null;
    },
  });
  expect(definition.name).toBe('roster-deciders');
  type Entries = RosterAgents<typeof deciders>;
  expectTypeOf<Entries['Default']>().toEqualTypeOf<RosterDecider>();
  expectTypeOf<Entries['Writer']>().toEqualTypeOf<Agent>();
  expectTypeOf<RosterAgentOf<RosterDeciderEntry, readonly []>>().toEqualTypeOf<RosterDecider>();
  expectTypeOf<RosterDeciderEntry>().toExtend<RosterEntry>();
});

it('refuses decider entries that set harness or agent keys', () => {
  const refused = [
    // @ts-expect-error -- an entry is an agent or a decider, not both.
    () => defineRoster({ Both: { harness: 'claude', decider: 'jev' } }),
    // @ts-expect-error -- a decider takes no agent key.
    () => defineRoster({ Triage: { decider: 'jev', tools: [] } }),
    // @ts-expect-error -- nor expectsToolUse.
    () => defineRoster({ Triage: { decider: 'jev', expectsToolUse: true } }),
    // @ts-expect-error -- nor a limit.
    () => defineRoster({ Triage: { decider: 'jev', timeoutMs: 1 } }),
    // @ts-expect-error -- the model is a string.
    () => defineRoster({ Triage: { decider: 'jev', model: 1 } }),
  ];
  for (const define of refused) expect(define).toThrow(/Roster entry (Both|Triage)/u);
});
