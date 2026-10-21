// Type-level contracts for bound agents (ADR 0063 sections 1-2, #578). The workflows are
// constructed but never run: typecheck (`npm run typecheck`) is the assertion, with one
// `@ts-expect-error` per rejected key and `expectTypeOf` for inferred results.
import { expect, expectTypeOf, it } from 'vitest';
import {
  defineHarness,
  defineWorkflow,
  z,
  type Agent,
  type AgentClient,
  type AgentResult,
  type BindOptions,
  type BoundCallOptions,
  type BoundOptionsOf,
  type CodexOptions,
} from '../src/index.js';

const base = { version: '1', input: z.null(), output: z.null() } as const;
const prompt = 'x';
const Review = z.object({ verdict: z.string() });
const third = defineHarness({
  name: 'third',
  revision: 1,
  options: z.object({
    prompt: z.string(),
    thinking: z.string().optional(),
    timeoutMs: z.number().optional(),
  }),
  capabilities: { structuredOutput: 'native' },
  access: () => 'none',
});
const plain = defineHarness({
  ...third,
  name: 'plain',
  capabilities: { structuredOutput: 'none' },
});

/** A helper that takes any structured agent, as a team slot or roster entry will. */
async function reviewWith(agent: Agent): Promise<{ verdict: string }> {
  return agent.value('review', { prompt, schema: Review });
}
/** A helper that takes any agent, text-only included. */
async function summarize(agent: Agent<{ structuredOutput: 'none' }>): Promise<string> {
  return agent.value('summary', { prompt });
}

export const bound = defineWorkflow({
  ...base,
  name: 'bound-types',
  harnesses: [third, plain],
  profiles: { scout: { claude: { tools: ['Read'] } } },
  async run(ctx) {
    const reviewer = ctx.claude.bind({ model: 'opus', effort: 'high', tools: ['Read', 'Grep'] });
    // For Claude the bound call options are exactly BoundCallOptions, in both directions.
    expectTypeOf(reviewer).toExtend<AgentClient<BoundCallOptions>>();
    expectTypeOf<AgentClient<BoundCallOptions>>().toExtend<typeof reviewer>();
    expectTypeOf(await reviewer.value('v', { prompt, schema: Review })).toEqualTypeOf<{
      verdict: string;
    }>();
    expectTypeOf(await reviewer.value('t', { prompt })).toEqualTypeOf<string>();
    expectTypeOf(await reviewer.object('o', { prompt, schema: Review })).toEqualTypeOf<
      AgentResult<{ verdict: string }>
    >();

    // Placement and policy stay per call; both-sides keys are accepted on both sides.
    await reviewer.text('placed', {
      prompt,
      cwd: 'pkg',
      worktree: true,
      addDirs: ['docs'],
      onError: 'throw',
      retry: { maxAttempts: 2 },
      timeoutMs: 1,
      idleTimeoutMs: 1,
    });
    ctx.claude.bind({ addDirs: ['a'], timeoutMs: 1, idleTimeoutMs: 1 });

    // @ts-expect-error -- model is fixed by bind.
    await reviewer.text('t', { prompt, model: 'haiku' });
    // @ts-expect-error -- tools are fixed by bind.
    await reviewer.text('t', { prompt, tools: ['Bash'] });
    // @ts-expect-error -- effort is fixed by bind.
    await reviewer.text('t', { prompt, effort: 'low' });
    // @ts-expect-error -- profile is fixed by bind.
    await reviewer.text('t', { prompt, profile: 'scout' });
    // @ts-expect-error -- object needs a schema.
    await reviewer.object('o', { prompt });

    // @ts-expect-error -- prompt is per call.
    ctx.claude.bind({ prompt });
    // @ts-expect-error -- cwd is per call.
    ctx.claude.bind({ cwd: 'pkg' });
    // @ts-expect-error -- worktree is per call.
    ctx.claude.bind({ worktree: true });
    // @ts-expect-error -- onError is per call.
    ctx.claude.bind({ onError: 'return' });
    // @ts-expect-error -- retry is per call.
    ctx.claude.bind({ retry: { maxAttempts: 2 } });
    // @ts-expect-error -- the schema is per call.
    ctx.claude.bind({ schema: Review });
    // @ts-expect-error -- a profile must be a declared role or preset.
    ctx.claude.bind({ profile: 'missing' });
    ctx.claude.bind({ profile: 'scout' });

    // Codex: images are a per-call attachment.
    const mechanic = ctx.codex.bind({ model: 'gpt-5-codex', sandbox: 'workspace-write' });
    await mechanic.text('look', { prompt, images: ['shot.png'] });
    // @ts-expect-error -- images cannot be bound.
    ctx.codex.bind({ images: ['shot.png'] });
    // @ts-expect-error -- the sandbox is fixed by bind.
    await mechanic.text('t', { prompt, sandbox: 'read-only' });

    // Built-in bound agents are assignable to the structured Agent.
    await reviewWith(reviewer);
    await reviewWith(mechanic);
    // The default capabilities are the built-ins' NativeHarnessCapabilities.
    const asAgent: Agent = mechanic;
    await reviewWith(asAgent);

    // A registered harness binds over its own schema.
    const deep = ctx.agent('third').bind({ thinking: 'deep' });
    expectTypeOf(await deep.value('v', { prompt, schema: Review })).toEqualTypeOf<{
      verdict: string;
    }>();
    await reviewWith(deep);
    // @ts-expect-error -- thinking is fixed by bind.
    await deep.text('t', { prompt, thinking: 'shallow' });
    // @ts-expect-error -- the registration declares no addDirs, so its bound agent has none.
    await deep.text('t', { prompt, addDirs: ['a'] });

    // A text-only registration binds to a text-only agent.
    const quiet = ctx.agent('plain').bind({ thinking: 'deep' });
    expectTypeOf(await quiet.value('t', { prompt })).toEqualTypeOf<string>();
    expectTypeOf(quiet).not.toHaveProperty('object');
    // @ts-expect-error -- a text-only agent has no schema-bearing value.
    await quiet.value('v', { prompt, schema: Review });
    await summarize(quiet);
    await summarize(reviewer);
    // @ts-expect-error -- a text-only agent is not a structured Agent.
    await reviewWith(quiet);
    await summarize(quiet.bind({ timeoutMs: 1 }));
    // @ts-expect-error -- a re-bound text-only agent stays text-only.
    await reviewWith(quiet.bind({ timeoutMs: 1 }));

    // An Agent binds again over the both-sides keys only.
    const layered = reviewer.bind({ addDirs: ['c'], timeoutMs: 2, idleTimeoutMs: 3 });
    await reviewWith(layered);
    // @ts-expect-error -- a re-bound agent still fixes the model.
    await layered.text('t', { prompt, model: 'haiku' });
    // @ts-expect-error -- the model was fixed by the first bind.
    reviewer.bind({ model: 'haiku' });
    // @ts-expect-error -- prompt stays per call on a re-bind.
    reviewer.bind({ prompt });
    // @ts-expect-error -- a fixed key is refused alongside a both-sides one.
    reviewer.bind({ model: 'haiku', timeoutMs: 1 });
    // A non-strict client is unchanged: one call shape, with addDirs.
    expectTypeOf(layered).toEqualTypeOf<typeof reviewer>();
    expectTypeOf(ctx.claude.bind({ profile: 'scout' })).toEqualTypeOf<typeof reviewer>();
    return null;
  },
});

export const strict = defineWorkflow({
  ...base,
  name: 'bound-strict',
  strictProfiles: true,
  profiles: { scout: { claude: { tools: ['Read'] } } },
  async run(ctx) {
    // @ts-expect-error -- strict: tools belong to a named profile, bound or raw.
    ctx.claude.bind({ tools: ['Read'] });
    // @ts-expect-error -- strict: the Codex sandbox belongs to a named profile.
    ctx.codex.bind({ sandbox: 'workspace-write' });
    const scout = ctx.claude.bind({ profile: 'scout', model: 'opus' });
    await scout.text('t', { prompt });
    return null;
  },
});

// A strict bound agent keeps the profile and addDirs pairing of a raw call (#385, ADR 0062): only a
// profile that declares claude.addDirRoots leaves addDirs open to its calls.
export const strictRoots = defineWorkflow({
  ...base,
  name: 'bound-strict-roots',
  strictProfiles: true,
  profiles: {
    reader: { extends: 'readonly', claude: { addDirRoots: ['runs'] } },
    plain: { extends: 'readonly' },
  },
  async run(ctx) {
    const reader = ctx.claude.bind({ profile: 'reader', model: 'opus' });
    await reader.text('t', { prompt, addDirs: ['runs/a'] });
    await reader.value('v', { prompt, schema: Review, addDirs: ['runs/a'] });
    await reviewWith(reader);
    const plainAgent = ctx.claude.bind({ profile: 'plain' });
    await plainAgent.text('t', { prompt });
    // @ts-expect-error -- plain declares no claude.addDirRoots, so its agent takes no addDirs.
    await plainAgent.text('t', { prompt, addDirs: ['runs/a'] });
    // @ts-expect-error -- neither does the unrooted implicit default.
    await ctx.claude.bind({ model: 'opus' }).text('t', { prompt, addDirs: ['runs/a'] });
    // @ts-expect-error -- bind itself pairs addDirs with a rooted profile, as a call does.
    ctx.claude.bind({ profile: 'plain', addDirs: ['runs/a'] });
    ctx.claude.bind({ profile: 'reader', addDirs: ['runs/a'] });
    // A re-bind keeps the pairing. Binding addDirs keeps only the member that admits them, which
    // accepts exactly the calls the rooted agent does.
    const again = reader.bind({ addDirs: ['runs/b'], timeoutMs: 1 });
    expectTypeOf(again).toExtend<typeof reader>();
    expectTypeOf(reader).toExtend<typeof again>();
    expectTypeOf(reader.bind({ timeoutMs: 1 })).toEqualTypeOf<typeof reader>();
    await again.text('t', { prompt, addDirs: ['runs/c'] });
    expectTypeOf(plainAgent.bind({ timeoutMs: 1 })).toEqualTypeOf<typeof plainAgent>();
    // @ts-expect-error -- re-binding addDirs is closed when the first bind left it closed.
    plainAgent.bind({ addDirs: ['runs/a'] });
    // The same through ctx.agent('claude') and a ctx.within scope.
    await ctx
      .agent('claude')
      .bind({ profile: 'reader' })
      .text('t', { prompt, addDirs: ['a'] });
    await ctx
      .within('x')
      .claude.bind({ profile: 'plain' })
      // @ts-expect-error -- the within scope keeps the pairing.
      .text('t', { prompt, addDirs: ['a'] });
    return null;
  },
});

it('derives the bind and bound option types from the client options', () => {
  expectTypeOf<BoundOptionsOf<CodexOptions>>().toHaveProperty('images');
  expectTypeOf<BindOptions<CodexOptions>>().not.toHaveProperty('images');
  expectTypeOf<BindOptions<CodexOptions>>().toHaveProperty('sandbox');
  expectTypeOf<BindOptions<BoundCallOptions>>().toEqualTypeOf<
    Omit<BoundCallOptions, 'prompt' | 'cwd' | 'worktree' | 'onError' | 'retry'>
  >();
  expect(bound.name).toBe('bound-types');
  expect(strict.strictProfiles).toBe(true);
  expect(strictRoots.strictProfiles).toBe(true);
});
