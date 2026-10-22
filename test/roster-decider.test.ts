// Decider roster entries (ADR 0066 section 2, #654): `{ decider, model?, description? }` names a
// declared decision provider, and ctx.roster.Name.decide is ctx.decide with that provider and model
// preset, recording the same decision/2 identity plus a meta.roster label.
import { describe, expect, vi } from 'vitest';
import {
  defineRoster,
  defineWorkflow,
  readRun,
  z,
  type RunOptions,
  type StepRecord,
} from '../src/index.js';
import { compactWorkflowMetadata } from '../src/cli/workflow-metadata-view.js';
import {
  choice,
  defineDecisionProvider,
  noul,
  type DecisionCapabilities,
  type ProviderTransportRequest,
} from '../src/integrations/decision.js';
import { checkedDefinition, describeWorkflow } from '../src/workflow/runtime/definition.js';
import { digest } from '../src/workflow/runtime/json.js';
import { validateProfileOverrides } from '../src/workflow/runtime/profiles.js';
import { it } from './setup/state-dir.js';

const base = { version: '1', input: z.null(), output: z.unknown() } as const;
const capabilities: DecisionCapabilities = {
  kinds: ['noul', 'choice', 'score'],
  maxOptions: 255,
  levels: [2, 10],
  idempotencyKey: false,
};
const refund = noul({ instructions: 'Refund?' });
const route = choice({ instructions: 'Which team?', options: { billing: null, support: null } });
const questions = { refund, route } as const;
const state = { ticket: 42 };

/** A provider whose transport records each request and answers every question. */
function recording(name: string, defaultModel?: string) {
  const requests: ProviderTransportRequest[] = [];
  const factory = vi.fn(() => (request: ProviderTransportRequest) => {
    requests.push(request);
    return Promise.resolve({
      body: {
        model: 'served',
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => [
            key,
            question.type === 'choice'
              ? {
                  type: 'choice',
                  choice: Object.keys(question.options)[0],
                  probabilities: Object.fromEntries(
                    Object.keys(question.options).map((option, index) => [
                      option,
                      index === 0 ? 1 : 0,
                    ]),
                  ),
                  confidence: 0.9,
                }
              : { type: 'noul', noul: 0.5 },
          ]),
        ),
      },
    });
  });
  const provider = defineDecisionProvider({
    name,
    revision: 1,
    capabilities,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    transport: factory,
  });
  return { provider, factory, requests };
}

const options = (stateDir: string, runId: string, extra: Partial<RunOptions> = {}): RunOptions => ({
  stateDir,
  runId,
  input: null,
  ...extra,
});
const step = async (stateDir: string, runId: string, id: string): Promise<StepRecord> => {
  const found = (await readRun({ stateDir, runId })).steps[id];
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
};

describe('defineRoster decider entries', () => {
  it('stores a decider entry as a deep-frozen JSON copy beside agent entries', () => {
    const roster = defineRoster({
      Triage: { decider: 'jev', model: 'jev-1', description: 'Routes tickets.' },
      Clerk: { harness: 'claude' },
    });
    expect({ ...roster }).toEqual({
      Triage: { decider: 'jev', model: 'jev-1', description: 'Routes tickets.' },
      Clerk: { harness: 'claude' },
    });
    expect(Object.isFrozen(roster.Triage)).toBe(true);
    expect(defineRoster({ Bare: { decider: 'jev' } }).Bare).toEqual({ decider: 'jev' });
  });

  it('refuses an entry that sets both harness and decider', () => {
    expect(() => defineRoster({ Both: { harness: 'claude', decider: 'jev' } } as never)).toThrow(
      'Roster entry Both cannot set both harness and decider; an entry is an agent or a decider.',
    );
  });

  it.for([
    ['tools', []],
    ['expectsToolUse', true],
    ['timeoutMs', 1],
    ['systemPrompt', 'x'],
    ['onError', 'return'],
    ['profile', 'text'],
  ] as const)('refuses the agent key %s on a decider entry', ([key, value]) => {
    expect(() => defineRoster({ Triage: { decider: 'jev', [key]: value } } as never)).toThrow(
      `Roster entry Triage is a decider; it cannot set ${key} (a decider entry takes only decider, model and description).`,
    );
  });

  it.for([
    [{ decider: 'Bad Name' }, 'Roster entry Triage decider must be a decision provider name'],
    [{ decider: 5 }, 'Roster entry Triage decider must be a decision provider name'],
    [{ decider: 'jev', model: '' }, 'Roster entry Triage model must be a nonempty string.'],
    [{ decider: 'jev', model: 3 }, 'Roster entry Triage model must be a nonempty string.'],
    [{ decider: 'jev', description: 1 }, 'Roster entry Triage description must be a string.'],
  ] as const)('refuses %j', ([entry, message]) => {
    expect(() => defineRoster({ Triage: entry } as never)).toThrow(message);
  });

  it('checks decider entry names like any entry, and keeps the agent entry error', () => {
    expect(() => defineRoster({ text: { decider: 'jev' } } as never)).toThrow(
      'Roster entry name text is reserved',
    );
    expect(() => defineRoster({ Scout: {} } as never)).toThrow(
      'Roster entry Scout must name its harness or decider.',
    );
  });
});

describe('load-time provider check', () => {
  const triage = defineRoster({ Triage: { decider: 'jev' } });
  const message =
    "Roster entry Triage names decision provider jev, which workflow review does not declare; add it to the workflow's decisions.";

  it.for([
    ['no decisions', []],
    ['another provider', ['other']],
  ] as const)(
    'refuses a decider naming an undeclared provider with %s',
    async ([, names], { stateDir, runs }) => {
      const providers = names.map((name) => recording(name));
      const definition = defineWorkflow({
        ...base,
        name: 'review',
        decisions: providers.map(({ provider }) => provider),
        roster: triage,
        run: async (ctx) => {
          await ctx.step('first', { input: null, schema: z.null(), run: () => null });
          return null;
        },
      });
      expect(() => checkedDefinition(definition)).toThrow(message);
      expect(() => describeWorkflow(definition)).toThrow(message);
      await expect(runs.run(definition, options(stateDir, 'undeclared'))).rejects.toThrow(message);
      await expect(readRun({ stateDir, runId: 'undeclared' })).rejects.toThrow();
    },
  );

  it('checks an inline child against its own decisions', async ({ stateDir, runs }) => {
    const jev = recording('jev');
    const child = defineWorkflow({
      ...base,
      name: 'review',
      roster: triage,
      run: () => Promise.resolve(null),
    });
    const parent = defineWorkflow({
      ...base,
      name: 'parent',
      decisions: [jev.provider],
      roster: triage,
      children: [child],
      async run(ctx) {
        await ctx.step('first', { input: null, schema: z.null(), run: () => null });
        return ctx.workflow('child', child, null);
      },
    });
    expect(() => checkedDefinition(parent)).not.toThrow();
    expect(() => describeWorkflow(parent)).toThrow(message);
    await expect(runs.run(parent, options(stateDir, 'child'))).rejects.toThrow(message);
    expect(jev.requests).toEqual([]);
  });
});

describe('ctx.roster.Name.decide', () => {
  it('records the identity of the equivalent ctx.decide call, plus meta.roster', async ({
    stateDir,
    runs,
  }) => {
    const fake = recording('fake');
    const roster = defineRoster({ Triage: { decider: 'fake', model: 'm1' } });
    const viaRoster = defineWorkflow({
      ...base,
      name: 'decide',
      decisions: [fake.provider],
      roster,
      run: (ctx) => ctx.roster.Triage.decide('t', { state, questions }),
    });
    const viaDecide = defineWorkflow({
      ...base,
      name: 'decide',
      decisions: [fake.provider],
      roster,
      run: (ctx) => ctx.decide('t', { provider: 'fake', model: 'm1', state, questions }),
    });
    const a = await runs.run(viaRoster, options(stateDir, 'a'));
    const b = await runs.run(viaDecide, options(stateDir, 'b'));
    expect(a.output).toEqual(b.output);
    expect(fake.requests.map((request) => request.model)).toEqual(['m1', 'm1']);
    const [stepA, stepB] = [await step(stateDir, 'a', 't'), await step(stateDir, 'b', 't')];
    expect(stepA.fingerprint).toBe(stepB.fingerprint);
    expect(stepA.identity).toEqual(stepB.identity);
    // Each identity component is a digest of its value: decision/2 and the entry's provider/model.
    expect(stepA.identity).toMatchObject({
      version: digest('decision/2'),
      input: digest({ provider: 'fake', revision: 1, model: 'm1', state, questions }),
    });
    expect(stepA.meta).toEqual({
      integration: 'decision',
      op: 'decide',
      provider: 'fake',
      model: 'm1',
      roster: 'Triage',
    });
    expect(stepB.meta).toEqual({
      integration: 'decision',
      op: 'decide',
      provider: 'fake',
      model: 'm1',
    });
  });

  it('reuses a decision recorded by ctx.decide after the code switches to the roster', async ({
    stateDir,
    runs,
  }) => {
    const fake = recording('fake');
    const roster = defineRoster({ Triage: { decider: 'fake', model: 'm1' } });
    let failNext = true;
    const after = {
      input: null,
      schema: z.null(),
      run: () => {
        if (failNext) {
          failNext = false;
          throw new Error('first execution fails');
        }
        return null;
      },
    };
    const first = defineWorkflow({
      ...base,
      name: 'decide',
      decisions: [fake.provider],
      roster,
      async run(ctx) {
        const answers = await ctx.decide('t', { provider: 'fake', model: 'm1', state, questions });
        await ctx.step('after', after);
        return answers;
      },
    });
    const second = defineWorkflow({
      ...base,
      name: 'decide',
      decisions: [fake.provider],
      roster,
      async run(ctx) {
        const answers = await ctx.roster.Triage.decide('t', { state, questions });
        await ctx.step('after', after);
        return answers;
      },
    });
    await expect(runs.run(first, options(stateDir, 'switch'))).rejects.toThrow(
      'first execution fails',
    );
    expect(fake.requests).toHaveLength(1);
    const resumed = await runs.run(second, options(stateDir, 'switch', { resume: true }));
    expect(resumed.output).toMatchObject({ refund: { noul: 0.5 }, route: { choice: 'billing' } });
    expect(fake.requests).toHaveLength(1);
    // Replay keeps the recorded step, so its labels stay those of the ctx.decide call.
    expect((await step(stateDir, 'switch', 't')).meta).not.toHaveProperty('roster');
  });

  it('leaves the model of an entry without one to the configuration and the declaration', async ({
    stateDir,
    runs,
  }) => {
    const fake = recording('fake', 'declared-model');
    const definition = (run: 'roster' | 'decide') =>
      defineWorkflow({
        ...base,
        name: 'decide',
        decisions: [fake.provider],
        roster: defineRoster({ Triage: { decider: 'fake' } }),
        run: (ctx) =>
          run === 'roster'
            ? ctx.roster.Triage.decide('t', { state, questions: { refund } })
            : ctx.decide('t', { provider: 'fake', state, questions: { refund } }),
      });
    const configured = { decisionConfigurations: { fake: { defaultModel: 'run-model' } } };
    await runs.run(definition('roster'), options(stateDir, 'declared'));
    await runs.run(definition('decide'), options(stateDir, 'declared-decide'));
    await runs.run(definition('roster'), options(stateDir, 'configured', configured));
    expect(fake.requests.map((request) => request.model)).toEqual([
      'declared-model',
      'declared-model',
      'run-model',
    ]);
    const roster = await step(stateDir, 'declared', 't');
    expect(roster.fingerprint).toBe((await step(stateDir, 'declared-decide', 't')).fingerprint);
    expect(roster.meta).toMatchObject({ model: 'declared-model', roster: 'Triage' });
    expect((await step(stateDir, 'configured', 't')).meta).toMatchObject({
      model: 'run-model',
      roster: 'Triage',
    });
  });

  it('takes the step ID prefix of ctx.within and ctx.scope', async ({ stateDir, runs }) => {
    const fake = recording('fake');
    const definition = defineWorkflow({
      ...base,
      name: 'decide',
      decisions: [fake.provider],
      roster: defineRoster({ Triage: { decider: 'fake' } }),
      async run(ctx) {
        await ctx.within('p').roster.Triage.decide('t', { state, questions: { refund } });
        await ctx.scope('s', () => ctx.roster.Triage.decide('t', { state, questions: { refund } }));
        const untyped = ctx.roster as Readonly<Record<string, unknown>>;
        return {
          frozen: Object.isFrozen(ctx.roster.Triage),
          keys: Object.keys(ctx.roster.Triage),
          missing: !('toString' in untyped),
        };
      },
    });
    const result = await runs.run(definition, options(stateDir, 'prefix'));
    expect(result.output).toEqual({ frozen: true, keys: ['decide'], missing: true });
    const record = await readRun({ stateDir, runId: 'prefix' });
    expect(Object.keys(record.steps).sort()).toEqual(['p/t', 's/t']);
    expect(record.steps['p/t']?.meta).toMatchObject({ roster: 'Triage' });
  });

  it.for(['provider', 'model'] as const)(
    'fails the step for an untyped call-site %s before any request',
    async (key, { stateDir, runs }) => {
      const fake = recording('fake');
      const definition = defineWorkflow({
        ...base,
        name: 'decide',
        decisions: [fake.provider],
        roster: defineRoster({ Triage: { decider: 'fake' } }),
        run: (ctx) =>
          ctx.roster.Triage.decide('t', { state, questions: { refund }, [key]: 'fake' } as never),
      });
      await expect(runs.run(definition, options(stateDir, 'refused'))).rejects.toThrow(
        `ctx.roster.Triage.decide cannot set ${key}; roster entry Triage fixes it.`,
      );
      expect(fake.requests).toEqual([]);
      expect(fake.factory).not.toHaveBeenCalled();
    },
  );

  it('resolves a decider in an inline child against the child roster and decisions', async ({
    stateDir,
    runs,
  }) => {
    const outer = recording('outer');
    const inner = recording('inner');
    const child = defineWorkflow({
      ...base,
      name: 'child',
      decisions: [inner.provider],
      roster: defineRoster({ Triage: { decider: 'inner', model: 'child-model' } }),
      run: (ctx) => ctx.roster.Triage.decide('t', { state, questions: { refund } }),
    });
    const parent = defineWorkflow({
      ...base,
      name: 'parent',
      decisions: [outer.provider],
      roster: defineRoster({ Triage: { decider: 'outer' } }),
      children: [child],
      async run(ctx) {
        await ctx.workflow('child', child, null);
        return ctx.roster.Triage.decide('t', { state, questions: { refund } });
      },
    });
    await runs.run(parent, options(stateDir, 'children'));
    expect(inner.requests.map((request) => request.model)).toEqual(['child-model']);
    expect(outer.requests.map((request) => request.model)).toEqual([null]);
    const record = await readRun({ stateDir, runId: 'children' });
    expect(record.steps['child/t']?.meta).toMatchObject({ provider: 'inner', roster: 'Triage' });
    expect(record.steps['t']?.meta).toMatchObject({ provider: 'outer', roster: 'Triage' });
  });
});

describe('decider entries are not roles', () => {
  const fake = recording('fake');
  const roster = defineRoster({
    Triage: { decider: 'fake', model: 'm1', description: 'Routes tickets.' },
    Mechanic: { harness: 'codex', sandbox: 'workspace-write' },
  });
  const definition = defineWorkflow({
    ...base,
    name: 'mixed',
    requireGrants: true,
    decisions: [fake.provider],
    roster,
    run: (ctx) => ctx.roster.Triage.decide('t', { state, questions: { refund } }),
  });

  it('lists deciders in the description, outside the capability manifest', () => {
    const description = describeWorkflow(definition);
    expect(description.deciders).toEqual({
      Triage: { provider: 'fake', model: 'm1', description: 'Routes tickets.' },
    });
    expect(Object.keys(description.capabilities.profiles)).toContain('Mechanic');
    expect(description.capabilities.profiles).not.toHaveProperty('Triage');
    expect(description.capabilities.requiredGrants).toEqual(['Mechanic']);
    expect(compactWorkflowMetadata(description, null).deciders).toEqual(description.deciders);
    const bare = defineWorkflow({ ...base, name: 'bare', run: () => Promise.resolve(null) });
    expect(describeWorkflow(bare).deciders).toEqual({});
    expect(
      describeWorkflow(
        defineWorkflow({
          ...base,
          name: 'agents',
          roster: defineRoster({ Clerk: { harness: 'claude' } }),
          run: () => Promise.resolve(null),
        }),
      ).deciders,
    ).toEqual({});
  });

  it('refuses a --profile override naming a decider as an unknown profile', () => {
    const { capabilities: manifest } = describeWorkflow(definition);
    expect(() => validateProfileOverrides([{ profile: 'Triage', timeoutMs: 1 }], manifest)).toThrow(
      'Unknown override profile: Triage.',
    );
    expect(validateProfileOverrides([{ profile: 'Mechanic', timeoutMs: 1 }], manifest)).toEqual([
      { profile: 'Mechanic', timeoutMs: 1 },
    ]);
  });

  it('runs a decider under requireGrants without a grant for it', async ({ stateDir, runs }) => {
    const result = await runs.run(
      definition,
      options(stateDir, 'grants', { grants: ['Mechanic'] }),
    );
    expect(result.output).toEqual({ refund: { noul: 0.5 } });
    const record = await readRun({ stateDir, runId: 'grants' });
    expect(record.capabilities?.requiredGrants).toEqual(['Mechanic']);
    expect(record.capabilities?.profiles).not.toHaveProperty('Triage');
    expect(Object.keys(record.grantedProfiles ?? {})).toEqual(['Mechanic']);
  });
});
