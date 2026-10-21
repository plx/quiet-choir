import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  assertCompleted,
  defineRoster,
  defineTeam,
  defineWorkflow,
  runWorkflow,
  z,
  type Harness,
  type HarnessRequest,
  type HarnessResponse,
} from '../src/index.js';
import { ReviewTeam } from '../examples/patterns/review-team.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'choir-team-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

class Fake implements Harness {
  public readonly kind = 'team-fixture';
  public readonly calls: HarnessRequest[] = [];
  public invoke(request: HarnessRequest): Promise<HarnessResponse> {
    this.calls.push(request);
    return Promise.resolve({
      text: 'ok',
      sessionId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
    });
  }
}
const options = (harness: Harness) => ({
  runId: 'team',
  cwd: root,
  stateDir: join(root, 'state'),
  fingerprint: 'team-v1',
  agentLimit: 2,
  harness,
});

it('reads slot descriptions as plain data without running a body', () => {
  expect(ReviewTeam.slots).toEqual({
    actor: 'Produces and revises the draft.',
    critic: 'Judges the draft and returns feedback.',
  });
  expect(JSON.parse(JSON.stringify(ReviewTeam.slots))).toEqual(ReviewTeam.slots);
});

it('stores slots as a frozen, null-prototype copy', () => {
  const source = { actor: 'Does.', critic: 'Judges.' };
  const team = defineTeam(source);
  source.actor = 'Changed.';
  expect(team.slots.actor).toBe('Does.');
  expect(Object.isFrozen(team.slots)).toBe(true);
  expect(Object.getPrototypeOf(team.slots)).toBeNull();
  expect(Object.isFrozen(team)).toBe(true);
  expect(Object.keys(team.slots)).toEqual(['actor', 'critic']);
});

it('rejects malformed slot declarations', () => {
  const define = defineTeam as (slots: unknown) => unknown;
  expect(() => define(null)).toThrow(TypeError);
  expect(() => define('actor')).toThrow(TypeError);
  expect(() => define(['actor'])).toThrow(TypeError);
  expect(() => define(new Map())).toThrow(TypeError);
  expect(() => define({})).toThrow('defineTeam needs at least one slot.');
  expect(() => define({ actor: 1 })).toThrow('Team slot actor needs a string description.');
  expect(() => define({ actor: 'ok', critic: undefined })).toThrow(TypeError);
  expect(() => define(Object.create(null) as object)).toThrow(TypeError);
  expect(() => define(Object.assign(Object.create(null) as object, { a: 'x' }))).not.toThrow();
});

const roster = defineRoster({
  Writer: { harness: 'claude', tools: [] },
  Reviewer: { harness: 'codex', sandbox: 'read-only' },
  Skeptic: { harness: 'codex', sandbox: 'read-only', model: 'gpt-5-codex' },
});
const Pair = defineTeam({ actor: 'Does.', critic: 'Judges.' });

it('from keeps only the slot keys, freezes the team and preserves agent identity', async () => {
  let observed: unknown;
  const workflow = defineWorkflow({
    name: 'team-from',
    version: '1',
    roster,
    input: z.null(),
    output: z.null(),
    run(ctx) {
      const agents = ctx.roster;
      const team = Pair.from({
        actor: agents.Writer,
        critic: agents.Reviewer,
        extra: agents.Skeptic,
      });
      observed = { team, agents };
      return Promise.resolve(null);
    },
  });
  const result = await runWorkflow(workflow, { ...options(new Fake()), input: null });
  assertCompleted(result);
  const { team, agents } = observed as {
    team: { actor: unknown; critic: unknown };
    agents: { Writer: unknown; Reviewer: unknown };
  };
  expect(Object.keys(team)).toEqual(['actor', 'critic']);
  expect(Object.isFrozen(team)).toBe(true);
  expect(team.actor).toBe(agents.Writer);
  expect(team.critic).toBe(agents.Reviewer);
});

it('from fills a team from a roster by slot name and from a spread override', async () => {
  const named = defineRoster({
    actor: { harness: 'claude', tools: [] },
    critic: { harness: 'codex', sandbox: 'read-only' },
    Skeptic: { harness: 'codex', sandbox: 'read-only', model: 'gpt-5-codex' },
  });
  const harness = new Fake();
  const workflow = defineWorkflow({
    name: 'team-roster',
    version: '1',
    roster: named,
    input: z.null(),
    output: z.object({ keys: z.array(z.string()), same: z.boolean(), overridden: z.boolean() }),
    async run(ctx) {
      const whole = Pair.from(ctx.roster);
      const swapped = Pair.from({ ...ctx.roster, critic: ctx.roster.Skeptic });
      // A call through a team slot is a call through the agent: same ID shape and options.
      await swapped.critic.text('through-team', { prompt: 'p' });
      await ctx.roster.Skeptic.text('direct', { prompt: 'p' });
      await whole.actor.text('actor', { prompt: 'p' });
      return {
        keys: Object.keys(swapped),
        same: Object.isFrozen(whole) && Object.keys(whole).join() === 'actor,critic',
        overridden: swapped.critic !== whole.critic,
      };
    },
  });
  const result = await runWorkflow(workflow, { ...options(harness), input: null });
  assertCompleted(result);
  expect(result.output).toEqual({ keys: ['actor', 'critic'], same: true, overridden: true });
  const [team, direct, actor] = harness.calls;
  expect(team?.call.stepId).toBe('through-team');
  expect(direct?.call.stepId).toBe('direct');
  expect(team?.harness).toBe('codex');
  expect(team?.options).toEqual({ ...direct?.options });
  expect(actor?.harness).toBe('claude');
});

it('from throws naming a slot an untyped caller left empty', () => {
  const from = (record: unknown): unknown => Pair.from(record as never);
  expect(() => from({ actor: {} })).toThrow('Team slot critic is not filled.');
  expect(() => from({ actor: {}, critic: undefined })).toThrow(TypeError);
  expect(() => from({ actor: null, critic: {} })).toThrow('Team slot actor is not filled.');
});

it('from keeps a __proto__ slot as an own property and returns the agent by identity', () => {
  const Odd = defineTeam({ ['__proto__']: 'Odd slot.', actor: 'Does.' });
  expect(Object.keys(Odd.slots)).toEqual(['__proto__', 'actor']);
  const protoAgent = { name: 'proto-agent' };
  const actorAgent = { name: 'actor-agent' };
  const record = {};
  Object.defineProperty(record, '__proto__', { value: protoAgent, enumerable: true });
  Object.defineProperty(record, 'actor', { value: actorAgent, enumerable: true });
  const team = Odd.from(record as never);
  expect(Object.keys(team)).toEqual(['__proto__', 'actor']);
  expect(Object.getPrototypeOf(team)).toBeNull();
  expect(Object.getOwnPropertyDescriptor(team, '__proto__')?.value).toBe(protoAgent);
  expect(team.actor).toBe(actorAgent);
  expect(Object.isFrozen(team)).toBe(true);
});

it('from treats inherited Object.prototype members as unfilled slots', () => {
  const Inherited = defineTeam({ toString: 'Inherited.', constructor: 'Inherited too.' });
  expect(() => Inherited.from({} as never)).toThrow('Team slot toString is not filled.');
  expect(() => Inherited.from({ toString: {} } as never)).toThrow(
    'Team slot constructor is not filled.',
  );
  const filled = Inherited.from({ toString: { name: 'a' }, constructor: { name: 'b' } } as never);
  expect(Object.keys(filled)).toEqual(['toString', 'constructor']);

  const Odd = defineTeam({ ['__proto__']: 'Odd slot.' });
  expect(() => Odd.from({} as never)).toThrow('Team slot __proto__ is not filled.');
  expect(() => Odd.from(Object.create({ actor: {} }) as never)).toThrow(TypeError);
});
