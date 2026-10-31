// Type-level contracts for teams (ADR 0067, #583). The workflow is constructed but never run:
// typecheck (`npm run typecheck`) is the assertion, with one `@ts-expect-error` per rejected
// record and `expectTypeOf` for inferred results.
import { expect, expectTypeOf, it } from 'vitest';
import {
  defineHarness,
  defineRoster,
  defineTeam,
  defineWorkflow,
  z,
  type Agent,
  type MapStepError,
  type Team,
  type TeamOf,
} from '../src/index.js';
import * as std from '../src/std/index.js';

const plain = defineHarness({
  name: 'plain',
  revision: 1,
  options: z.object({ prompt: z.string() }),
  capabilities: { structuredOutput: 'none' },
  access: () => 'read',
});

const roster = defineRoster(
  {
    Writer: { harness: 'claude', tools: [] },
    Reviewer: { harness: 'codex', sandbox: 'read-only' },
    Skeptic: { harness: 'codex', sandbox: 'read-only', model: 'gpt-5-codex' },
    Summarizer: { harness: 'plain' },
  },
  { harnesses: [plain] },
);
const matching = defineRoster({
  actor: { harness: 'claude', tools: [] },
  critic: { harness: 'codex', sandbox: 'read-only' },
  Skeptic: { harness: 'codex', sandbox: 'read-only' },
});

const T = defineTeam({ actor: 'Produces.', critic: 'Judges.' });
type T = TeamOf<typeof T>;

export const typed = defineWorkflow({
  name: 'team-types',
  version: '1',
  input: z.null(),
  output: z.null(),
  harnesses: [plain],
  roster,
  run(ctx) {
    expectTypeOf(T.from({ actor: ctx.roster.Writer, critic: ctx.roster.Reviewer })).toEqualTypeOf<
      Team<'actor' | 'critic'>
    >();
    // Claude and Codex roster agents both fill a slot, in either position.
    T.from({ actor: ctx.roster.Reviewer, critic: ctx.roster.Writer });
    // A whole roster is accepted when it holds the slot names; extra entries are dropped at runtime.
    T.from({ actor: ctx.roster.Writer, critic: ctx.roster.Skeptic, Reviewer: ctx.roster.Reviewer });
    // Raw context clients are not bound agents; a bound one is.
    T.from({ actor: ctx.claude.bind({ tools: [] }), critic: ctx.codex.bind({}) });

    // @ts-expect-error -- a record missing a slot is rejected.
    T.from({ actor: ctx.roster.Writer });
    // @ts-expect-error -- a slot filled with a non-agent is rejected.
    T.from({ actor: ctx.roster.Writer, critic: 'Reviewer' });
    // @ts-expect-error -- a text-only agent cannot fill a structured slot.
    T.from({ actor: ctx.roster.Writer, critic: ctx.roster.Summarizer });
    // @ts-expect-error -- a roster without the slot names does not fill the team.
    T.from(ctx.roster);

    // A spread override fills the missing slot name from another entry.
    T.from({ ...ctx.roster, actor: ctx.roster.Writer, critic: ctx.roster.Skeptic });
    return Promise.resolve(null);
  },
});

export const named = defineWorkflow({
  name: 'team-named',
  version: '1',
  input: z.null(),
  output: z.null(),
  roster: matching,
  run(ctx) {
    // A roster whose names equal the slot names fills the team directly.
    expectTypeOf(T.from(ctx.roster)).toEqualTypeOf<Team<'actor' | 'critic'>>();
    T.from({ ...ctx.roster, critic: ctx.roster.Skeptic });
    return Promise.resolve(null);
  },
});

const Vote = z.object({ score: z.number() });

export const panel = defineWorkflow({
  name: 'team-panel',
  version: '1',
  input: z.null(),
  output: z.null(),
  async run(ctx) {
    const team = { panelist: ctx.claude.bind({}) };
    const scored = await std.patterns.tolerantPanel(ctx, {
      id: 'scored',
      team,
      items: [{ lens: 'security' }, { lens: 'perf' }],
      key: (item) => item.lens,
      prompt: (item) => item.lens,
      concurrency: 2,
      schema: Vote,
      retry: { maxAttempts: 2, on: ['schema'] },
    });
    expectTypeOf(scored).toEqualTypeOf<
      std.patterns.TolerantPanelResult<{ score: number }, { lens: string }>
    >();
    for (const outcome of scored.outcomes) {
      // Each outcome carries its item, typed as the panel's items.
      expectTypeOf(outcome.item).toEqualTypeOf<{ lens: string }>();
      expectTypeOf(outcome.index).toEqualTypeOf<number>();
      // The answer and the failure are reachable only after narrowing on `ok`.
      expectTypeOf(outcome).not.toHaveProperty('value');
      expectTypeOf(outcome).not.toHaveProperty('error');
      if (outcome.ok) expectTypeOf(outcome.value).toEqualTypeOf<{ score: number }>();
      else expectTypeOf(outcome.error).toEqualTypeOf<MapStepError>();
    }
    // A text panel still assigns to the bare result type, whose items are unknown.
    const text: std.patterns.TolerantPanelResult = await std.patterns.tolerantPanel(ctx, {
      id: 'text',
      team,
      items: ['a', 'b'],
      prompt: (item) => item,
      concurrency: 2,
    });
    expectTypeOf(text.outcomes).items.toHaveProperty('item').toEqualTypeOf<unknown>();
    return null;
  },
});

it('derives the team record from the definition', () => {
  expectTypeOf<T>().toEqualTypeOf<{ readonly actor: Agent; readonly critic: Agent }>();
  expectTypeOf<T>().toEqualTypeOf<Team<'actor' | 'critic'>>();
  expectTypeOf(T.slots).toEqualTypeOf<Readonly<Record<'actor' | 'critic', string>>>();
  expectTypeOf<keyof T>().toEqualTypeOf<'actor' | 'critic'>();
  expectTypeOf<TeamOf<{ other: true }>>().toBeNever();
  expect(Object.keys(T.slots)).toEqual(['actor', 'critic']);
});

it('keeps the typed definitions assignable to unparameterized definition parameters', () => {
  expect(typed.name).toBe('team-types');
  expect(named.name).toBe('team-named');
  expect(panel.name).toBe('team-panel');
});
