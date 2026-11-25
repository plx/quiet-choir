// quiet-choir/std gates (std.patterns.checklist and gate) end to end against a scripted harness:
// exact step IDs, the verdict and decision rules in code, default prompts and their safe defaults,
// failure tolerance (a failed call becomes data, is counted, and is not retried on resume), replay
// after a tail failure without new calls, option validation before any effect, and the Codex
// schema check of every schema the gates send.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkCodexSchema,
  defineWorkflow,
  runWorkflow,
  stepId,
  z,
  type HarnessRequest,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowResult,
} from '../src/index.js';
import * as gates from '../src/std/gates.js';
import * as lenses from '../src/std/lenses.js';
import * as types from '../src/std/types.js';
import {
  ScriptedHarness,
  makeRoot,
  removeRoot,
  replayAfterTail,
  roundTrip,
  runOptions,
  tailFailure,
} from './std-harness.js';

let root: string;
beforeEach(async () => {
  root = await makeRoot();
});
afterEach(async () => {
  await removeRoot(root);
});

/** A workflow named `name` whose body is `body`, with an unchecked JSON output. */
function workflow(
  name: string,
  body: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition<null, unknown> {
  return defineWorkflow({
    name,
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) => body(ctx),
  });
}

/** Run `definition` once to completion (or rejection) as run `runId`. */
function run(
  definition: WorkflowDefinition<null, unknown>,
  harness: ScriptedHarness,
  runId = 'std',
) {
  return runWorkflow(definition, { ...runOptions(root, runId), harness, input: null });
}

/** The settled map IDs a run recorded, sorted. */
function mapIds(result: WorkflowResult<unknown>): string[] {
  return Object.keys(result.maps ?? {}).sort();
}

/**
 * Run `first` to an injected tail failure, then resume with `second`; return the resume's
 * rejection message, or `'resumed'` when it completed.
 */
async function resumeChanged(
  first: WorkflowDefinition<null, unknown>,
  second: WorkflowDefinition<null, unknown>,
  harness: ScriptedHarness,
  runId = 'changed',
): Promise<string> {
  const options = { ...runOptions(root, runId), harness };
  await expect(runWorkflow(tailFailure(first), { ...options, input: null })).rejects.toThrow(
    'Injected tail failure',
  );
  return runWorkflow(tailFailure(second), { ...options, resume: true }).then(
    () => 'resumed',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

/** Answer each call from `replies` by step ID, else from `fallback`; an Error value is thrown. */
function scripted(
  replies: Readonly<Record<string, unknown>>,
  fallback?: (request: HarnessRequest) => unknown,
): ScriptedHarness {
  return new ScriptedHarness((request) => {
    const reply = replies[request.stepId] ?? fallback?.(request);
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw new Error(`Unexpected call ${request.stepId}`);
    return reply;
  });
}

/** The property names of the output schema the last call to `stepId` sent. */
function schemaKeys(harness: ScriptedHarness, stepId: string): string[] {
  const call = harness.calls.findLast((entry) => entry.stepId === stepId);
  const schema = call?.outputSchema as { properties?: Record<string, unknown> } | null | undefined;
  return Object.keys(schema?.properties ?? {}).sort();
}

/** Every structured request's output schema passes the Codex schema check. */
function expectCodexSafe(harness: ScriptedHarness): void {
  const schemas = harness.calls.flatMap((call) =>
    call.outputSchema === null ? [] : [call.outputSchema],
  );
  expect(schemas.length).toBeGreaterThan(0);
  for (const schema of schemas) expect(checkCodexSchema(schema)).toEqual([]);
}

/** A criterion result with `status`. */
function checked(status: types.CheckStatus): types.CriterionResult {
  return { status, evidence: `src/a.ts:1 shows ${status}` };
}

/** An assessment with `status` and a summary naming it. */
function assessed(status: types.GateStatus, summary = `Rated ${status}.`): types.Assessment {
  return { status, summary, evidence: [`evidence for ${status}`] };
}

/** A skeptic verdict. */
function verdict(refuted: boolean): types.Refutation {
  return { refuted, reasoning: refuted ? 'A guard prevents it.' : 'Reproduced from the code.' };
}

describe('checklist', () => {
  const criteria = ['Invalid input returns 400.', 'The flag is documented.', 'Tests cover it.'];
  const checklist = (options: Partial<gates.ChecklistOptions> = {}) =>
    workflow('checklist', (ctx) =>
      gates.checklist(ctx, {
        id: 'acceptance',
        team: { checker: ctx.claude.bind({}) },
        subject: 'The change in main..HEAD.',
        criteria,
        ...options,
      }),
    );
  const ids = ['C1', 'C2', 'C3'].map((id) => `acceptance/criterion/${id}/check`);

  it('checks each criterion with exact step IDs and is done when every criterion passes', async () => {
    const harness = scripted({}, () => checked('pass'));
    const result = await replayAfterTail(checklist(), null, harness, root);
    expect(result.output).toEqual({
      verdict: 'done',
      results: criteria.map((criterion, index) => ({
        criterion: { id: `C${String(index + 1)}`, criterion, how: '' },
        result: checked('pass'),
      })),
      counts: { pass: 3, fail: 0, partial: 0, unverifiable: 0 },
      failures: 0,
      status: 'complete',
    });
    roundTrip(gates.ChecklistResult, result.output);
    expect(harness.ids().sort()).toEqual(ids);
    const prompt = harness.prompt('acceptance/criterion/C2/check');
    expect(prompt).toMatch(
      /^Check whether acceptance criterion C2 holds for the target below: The flag is documented\.\n\n## Context\n\nThe change in main\.\.HEAD\.\n\n## Guidance\n\n/u,
    );
    expect(prompt).toContain('Choose the most direct check');
    expect(prompt).toContain('answer unverifiable; that is the safe default, never pass.');
    expect(prompt).toContain('## Output\n\nThe status and the evidence');
  });

  it('is not done as soon as one criterion fails or holds only in part', async () => {
    const failing = await run(
      checklist(),
      scripted(
        { [ids[0] ?? '']: checked('fail'), [ids[1] ?? '']: new Error('checker crashed') },
        () => checked('unverifiable'),
      ),
    );
    expect(failing.output).toMatchObject({
      verdict: 'not-done',
      counts: { pass: 0, fail: 1, partial: 0, unverifiable: 1 },
      failures: 1,
      status: 'degraded',
    });
    roundTrip(gates.ChecklistResult, failing.output);
    const partial = await run(
      checklist(),
      scripted({ [ids[2] ?? '']: checked('partial') }, () => checked('pass')),
      'partial',
    );
    expect(partial.output).toMatchObject({
      verdict: 'not-done',
      counts: { pass: 2, fail: 0, partial: 1, unverifiable: 0 },
    });
  });

  it('is unverified when a criterion is unverifiable or its call failed, and does not retry the failure', async () => {
    const unverifiable = await run(
      checklist(),
      scripted({ [ids[1] ?? '']: checked('unverifiable') }, () => checked('pass')),
    );
    expect(unverifiable.output).toMatchObject({
      verdict: 'unverified',
      counts: { pass: 2, unverifiable: 1 },
      failures: 0,
      status: 'complete',
    });

    const harness = scripted({ [ids[0] ?? '']: new Error('checker crashed') }, () =>
      checked('pass'),
    );
    const result = await replayAfterTail(checklist(), null, harness, root, 'errored');
    expect(result.output).toMatchObject({
      verdict: 'unverified',
      counts: { pass: 2, fail: 0, partial: 0, unverifiable: 0 },
      failures: 1,
      status: 'degraded',
    });
    expect((result.output as unknown as gates.ChecklistResult).results[0]?.result).toBeNull();
    roundTrip(gates.ChecklistResult, result.output);
    expect(harness.count(ids[0] ?? '')).toBe(1);
  });

  it('numbers string criteria by position, keeps criterion objects, and follows their how', async () => {
    const harness = scripted({}, () => checked('pass'));
    const object: types.Criterion = {
      id: 'AC-7 login',
      criterion: 'A locked account cannot log in.',
      how: 'Run the auth tests.',
    };
    const result = await run(checklist({ criteria: ['First.', object, 'Third.'] }), harness);
    const results = (result.output as unknown as gates.ChecklistResult).results;
    roundTrip(gates.ChecklistResult, result.output);
    expect(results.map((entry) => entry.criterion)).toEqual([
      { id: 'C1', criterion: 'First.', how: '' },
      object,
      { id: 'C3', criterion: 'Third.', how: '' },
    ]);
    expect(harness.ids().sort()).toEqual(
      ['C1', stepId(object.id), 'C3'].map((id) => `acceptance/criterion/${id}/check`).sort(),
    );
    const prompt = harness.prompt(`acceptance/criterion/${stepId(object.id)}/check`);
    expect(prompt).toContain('acceptance criterion AC-7 login holds');
    expect(prompt).toContain('- Check it this way: Run the auth tests.');
  });

  it('sends a replacement prompt and the CriterionResult schema', async () => {
    const harness = scripted({}, () => checked('pass'));
    await run(
      checklist({
        criteria: ['Only one.'],
        prompts: {
          check: (criterion, subject) => `${criterion.id}|${criterion.criterion}|${subject}`,
        },
      }),
      harness,
    );
    expect(harness.prompt('acceptance/criterion/C1/check')).toBe(
      'C1|Only one.|The change in main..HEAD.',
    );
    expect(schemaKeys(harness, 'acceptance/criterion/C1/check')).toEqual(['evidence', 'status']);
    expectCodexSafe(harness);
  });

  it('spreads calls into every checker call and records one settled map', async () => {
    const calls = { timeoutMs: 12_345, addDirs: ['extra'] };
    const harness = scripted({}, () => checked('pass'));
    const result = await run(checklist({ calls }), harness);
    expect(mapIds(result)).toEqual(['acceptance/criterion']);
    expect(harness.calls).toHaveLength(3);
    for (const call of harness.calls) expect(call.options).toMatchObject(calls);
  });

  it('refuses to replay settled criteria after a subject, prompt or version change', async () => {
    const changed = (options: Partial<gates.ChecklistOptions>, runId: string) =>
      resumeChanged(
        checklist(),
        checklist(options),
        scripted({}, () => checked('pass')),
        runId,
      );
    const items =
      /^Settled map acceptance\/criterion changed after an item completed \(changed: items/u;
    expect(await changed({ subject: 'The change in main..next.' }, 'subject')).toMatch(items);
    expect(
      await changed({ prompts: { check: (criterion) => criterion.criterion } }, 'prompt'),
    ).toMatch(items);
    expect(await changed({ version: '2' }, 'version')).toMatch(
      /^Settled map acceptance\/criterion changed after an item completed \(changed: version\)/u,
    );
  });

  it('refuses to replay settled criteria after a call placement change', async () => {
    const harness = scripted({}, () => checked('pass'));
    expect(
      await resumeChanged(checklist(), checklist({ calls: { cwd: 'pkg' } }), harness, 'placed'),
    ).toMatch(
      /^Settled map acceptance\/criterion changed after an item completed \(changed: items\)/u,
    );
  });

  it('refuses invalid options before any effect', async () => {
    const cases: [Partial<gates.ChecklistOptions>, string][] = [
      [{ team: {} as unknown as gates.ChecklistTeam }, 'Team slot checker is not filled.'],
      [{ criteria: [] }, 'criteria must not be empty.'],
      [{ criteria: ['ok', '  '] }, 'criteria[1] must not be blank.'],
      [
        { criteria: [{ id: '', criterion: 'x', how: '' }] },
        'criteria[0] is not a valid criterion: id:',
      ],
      [
        { criteria: ['first', { id: 'C1', criterion: 'again', how: '' }] },
        'Duplicate criterion ID: "C1".',
      ],
      [{ concurrency: 0 }, 'concurrency must be a positive integer; got 0.'],
    ];
    for (const [index, [options, message]] of cases.entries()) {
      const harness = scripted({}, () => checked('pass'));
      await expect(run(checklist(options), harness, `bad-${String(index)}`)).rejects.toThrow(
        message,
      );
      expect(harness.calls).toHaveLength(0);
    }
  });
});

describe('gate', () => {
  const gate = (options: Partial<gates.GateOptions> = {}) =>
    workflow('gate', (ctx) =>
      gates.gate(ctx, {
        id: 'gate',
        team: { assessor: ctx.claude.bind({}), skeptic: ctx.claude.bind({}) },
        subject: 'Release 2.4: commits and diff stat.',
        ...options,
      }),
    );
  const assess = (key: string) => `gate/dimension/${key}/assess`;
  const seat = (key: string, n: number) => `gate/blocker/${key}/seat/${String(n)}/verdict`;
  /** Every dimension passes unless scripted; every skeptic upholds unless scripted. */
  const passing = (request: HarnessRequest) =>
    request.stepId.endsWith('/assess') ? assessed('pass') : verdict(false);

  it('assesses every release dimension with exact step IDs and goes when all pass', async () => {
    const harness = scripted({}, passing);
    const result = await replayAfterTail(gate(), null, harness, root);
    const output = result.output as unknown as gates.GateResult;
    roundTrip(gates.GateResult, output);
    expect(output).toMatchObject({
      decision: 'go',
      blockers: [],
      undecided: [],
      downgraded: [],
      concerns: [],
      cannotCheck: [],
      failed: [],
      reasons: [],
      failedVotes: 0,
      failures: 0,
      status: 'complete',
    });
    expect(output.assessments).toEqual(
      lenses.release.map((lens) => ({
        key: lens.key,
        lens,
        assessment: assessed('pass'),
        challenge: null,
        disposition: 'pass',
      })),
    );
    expect(harness.ids().sort()).toEqual(lenses.release.map((lens) => assess(lens.key)).sort());
    const prompt = harness.prompt(assess('security'));
    const security = lenses.release.find((lens) => lens.key === 'security');
    expect(prompt).toMatch(
      /^Assess whether the subject below is ready to ship\. Assess one dimension only, security: /u,
    );
    expect(prompt).toContain(security?.charter ?? '?');
    expect(prompt).toContain('## Context\n\nRelease 2.4: commits and diff stat.');
    expect(prompt).toContain(
      'or cannot-check when you could not assess the dimension; that is the safe default.',
    );
    expect(schemaKeys(harness, assess('tests'))).toEqual(['evidence', 'status', 'summary']);
    expectCodexSafe(harness);
  });

  it('challenges each blocker and decides no-go, downgrades and conditions in code', async () => {
    const harness = scripted(
      {
        [assess('tests')]: assessed('blocker', 'The suite fails on Windows.'),
        [assess('security')]: assessed('blocker', 'A token is logged.'),
        [assess('docs')]: assessed('concern', 'The changelog is thin.'),
        [assess('performance')]: assessed('cannot-check', 'No benchmarks ran.'),
        [assess('operability')]: new Error('assessor crashed'),
        [seat('tests', 0)]: verdict(true),
        [seat('tests', 1)]: verdict(true),
        [seat('tests', 2)]: verdict(false),
        [seat('security', 0)]: verdict(false),
        [seat('security', 1)]: verdict(false),
        [seat('security', 2)]: verdict(true),
      },
      passing,
    );
    const result = await replayAfterTail(gate({ seats: 3 }), null, harness, root);
    const output = result.output as unknown as gates.GateResult;
    roundTrip(gates.GateResult, output);
    expect(output).toMatchObject({
      decision: 'no-go',
      blockers: ['security'],
      undecided: [],
      downgraded: ['tests'],
      concerns: ['docs'],
      cannotCheck: ['performance'],
      failed: ['operability'],
      reasons: [
        'tests (downgraded): The suite fails on Windows.',
        'security (blocker): A token is logged.',
        'performance (cannot-check): No benchmarks ran.',
        'docs (concern): The changelog is thin.',
        'operability (failed): The assessor call failed.',
      ],
      failedVotes: 0,
      failures: 1,
      status: 'degraded',
    });
    const security = output.assessments.find((entry) => entry.key === 'security');
    expect(security?.challenge).toEqual({
      outcome: 'confirmed',
      upheld: 2,
      against: 1,
      missing: 0,
      seats: 3,
      reasons: [
        'upheld: Reproduced from the code.',
        'upheld: Reproduced from the code.',
        'refuted: A guard prevents it.',
      ],
    });
    expect(
      harness
        .ids()
        .filter((id) => id.startsWith('gate/blocker/'))
        .sort(),
    ).toEqual(['tests', 'security'].flatMap((key) => [0, 1, 2].map((n) => seat(key, n))).sort());
    expect(harness.count(assess('operability'))).toBe(1);
    expect(schemaKeys(harness, seat('tests', 0))).toEqual(['reasoning', 'refuted']);
    expectCodexSafe(harness);
    expect(mapIds(result)).toEqual([
      'gate/blocker',
      'gate/blocker/security/seat',
      'gate/blocker/tests/seat',
      'gate/dimension',
    ]);
    const challenge = harness.prompt(seat('security', 1));
    expect(challenge).toMatch(/^Try to refute the blocker an assessor reported below\./u);
    expect(challenge).toContain(
      '## Context\n\n## Gate\n\nAssess whether the subject below is ready to ship.\n\n## Dimension\n\nsecurity: ',
    );
    expect(challenge).toContain(
      '## Reported blocker\n\nA token is logged.\n\nEvidence:\n\n- evidence for blocker',
    );
    expect(challenge).toContain('## Subject\n\nRelease 2.4: commits and diff stat.');
    expect(challenge).toContain('refute the blocker (refuted: true); that is the safe default.');
  });

  it('is conditional-go when the only blocker is refuted', async () => {
    const harness = scripted(
      { [assess('docs')]: assessed('blocker'), [seat('docs', 0)]: verdict(true) },
      passing,
    );
    const result = await run(gate(), harness);
    expect(result.output).toMatchObject({
      decision: 'conditional-go',
      blockers: [],
      downgraded: ['docs'],
      reasons: ['docs (downgraded): Rated blocker.'],
      status: 'complete',
    });
    expect(harness.ids().filter((id) => id.startsWith('gate/blocker/'))).toEqual([seat('docs', 0)]);
  });

  it('runs no blocker map without a blocker and spreads calls into every call', async () => {
    const calls = { timeoutMs: 12_345, addDirs: ['extra'] };
    const go = await run(gate({ calls }), scripted({}, passing));
    expect(mapIds(go)).toEqual(['gate/dimension']);

    const harness = scripted({ [assess('docs')]: assessed('blocker') }, passing);
    const result = await run(gate({ calls, seats: 2 }), harness, 'blocked');
    expect(mapIds(result)).toEqual(['gate/blocker', 'gate/blocker/docs/seat', 'gate/dimension']);
    expect(harness.calls).toHaveLength(lenses.release.length + 2);
    for (const call of harness.calls) expect(call.options).toMatchObject(calls);
  });

  it('is conditional-go and degraded when every assessor call fails', async () => {
    const harness = scripted({}, (request) =>
      request.stepId.endsWith('/assess') ? new Error('assessor crashed') : verdict(false),
    );
    const result = await replayAfterTail(gate(), null, harness, root);
    const keys = lenses.release.map((lens) => lens.key);
    expect(result.output).toMatchObject({
      decision: 'conditional-go',
      blockers: [],
      failed: keys,
      reasons: keys.map((key) => `${key} (failed): The assessor call failed.`),
      failures: keys.length,
      status: 'degraded',
    });
    expect(harness.calls).toHaveLength(keys.length);
    roundTrip(gates.GateResult, result.output);
  });

  it('refuses to replay settled assessments or verdicts after a prompt or version change', async () => {
    const blocking = () => scripted({ [assess('docs')]: assessed('blocker') }, passing);
    const changed = (options: Partial<gates.GateOptions>, runId: string) =>
      resumeChanged(gate(), gate(options), blocking(), runId);
    expect(await changed({ task: 'Decide whether to merge.' }, 'task')).toMatch(
      /^Settled map gate\/dimension changed after an item completed \(changed: items/u,
    );
    expect(
      await changed({ prompts: { challenge: (dimension) => `Refute ${dimension.key}.` } }, 'seat'),
    ).toMatch(/^Settled map gate\/blocker changed after an item completed \(changed: items/u);
    expect(await changed({ version: '2' }, 'version')).toMatch(
      /^Settled map gate\/dimension changed after an item completed \(changed: version\)/u,
    );
  });

  it('refuses to replay settled assessments after a call placement change', async () => {
    const harness = scripted({ [assess('docs')]: assessed('blocker') }, passing);
    expect(
      await resumeChanged(gate(), gate({ calls: { addDirs: ['extra'] } }), harness, 'placed'),
    ).toMatch(/^Settled map gate\/dimension changed after an item completed \(changed: items\)/u);
  });

  it('refuses a changed challenge for a seat map an interrupted run left behind', async () => {
    // A budget of two attempts stops the run inside the only blocker's seat map: one seat commits
    // there and the blocker item does not, so only the seat map's items carry the old prompt.
    const harness = scripted({ [assess('api')]: assessed('blocker') }, passing);
    const options = { ...runOptions(root), harness };
    const one = (challenge?: (dimension: lenses.Lens) => string) =>
      gate({
        dimensions: [lenses.lens('api', 'Public API changes.')],
        seats: 2,
        prompts: { challenge },
      });
    await expect(
      runWorkflow(one(), { ...options, input: null, maxRunAgentAttempts: 2 }),
    ).rejects.toThrow('maxRunAgentAttempts');
    await expect(
      runWorkflow(
        one((dimension) => `Refute ${dimension.key}.`),
        {
          ...options,
          resume: true,
          maxRunAgentAttempts: 10,
        },
      ),
    ).rejects.toThrow(
      'Settled map gate/blocker/api/seat changed after an item completed (changed: items',
    );
    expect(harness.calls).toHaveLength(2);
  });

  it('refuses an unfilled skeptic slot before any assessor runs', async () => {
    const harness = scripted({ [assess('tests')]: assessed('blocker') }, passing);
    const definition = workflow('gate', (ctx) =>
      gates.gate(ctx, {
        id: 'gate',
        team: { assessor: ctx.claude.bind({}) } as unknown as gates.GateTeam,
        subject: 'Release 2.4.',
      }),
    );
    await expect(run(definition, harness)).rejects.toThrow('Team slot skeptic is not filled.');
    expect(harness.calls).toHaveLength(0);
  });

  it('fails closed: a blocker whose skeptic failed stays undecided and blocks without a retry', async () => {
    const harness = scripted(
      {
        [assess('compatibility')]: assessed('blocker', 'The config format changed.'),
        [seat('compatibility', 0)]: new Error('skeptic crashed'),
      },
      passing,
    );
    const result = await replayAfterTail(gate(), null, harness, root);
    expect(result.output).toMatchObject({
      decision: 'no-go',
      blockers: [],
      undecided: ['compatibility'],
      reasons: ['compatibility (undecided): The config format changed.'],
      failedVotes: 1,
      failures: 1,
      status: 'degraded',
    });
    expect(harness.count(seat('compatibility', 0))).toBe(1);
    roundTrip(gates.GateResult, result.output);
  });

  it('uses custom dimensions, task, rule and prompts', async () => {
    const dimensions = [
      lenses.lens('api', 'Public API changes.'),
      lenses.lens('api', 'Public API changes again.'),
    ];
    const harness = scripted(
      { [assess('api.2')]: assessed('blocker'), [seat('api.2', 1)]: verdict(false) },
      (request) => (request.stepId.endsWith('/assess') ? assessed('pass') : verdict(true)),
    );
    const result = await run(
      gate({
        dimensions,
        seats: 2,
        rule: { atLeast: 1 },
        prompts: {
          challenge: (dimension, assessment, subject, n, seats) =>
            `${dimension.key}|${assessment.status}|${subject}|${String(n)}/${String(seats)}`,
        },
        task: 'Decide whether to merge.',
      }),
      harness,
    );
    expect(result.output).toMatchObject({ decision: 'no-go', blockers: ['api.2'] });
    roundTrip(gates.GateResult, result.output);
    expect(harness.prompt(assess('api'))).toMatch(
      /^Decide whether to merge\. Assess one dimension only, api: Public API changes\./u,
    );
    expect(harness.prompt(seat('api.2', 1))).toBe(
      'api|blocker|Release 2.4: commits and diff stat.|1/2',
    );

    const custom = scripted({}, passing);
    await run(
      gate({ prompts: { assess: (dimension) => `Only ${dimension.key}.` } }),
      custom,
      'own',
    );
    expect(custom.prompt(assess('tests'))).toBe('Only tests.');
  });

  it('refuses invalid options before any effect', async () => {
    const cases: [Partial<gates.GateOptions>, string][] = [
      [{ team: {} as unknown as gates.GateTeam }, 'Team slot assessor is not filled.'],
      [{ dimensions: [] }, 'dimensions must not be empty.'],
      [{ seats: 0 }, 'seats must be a positive integer; got 0.'],
      [{ seats: 2, rule: { atLeast: 3 } }, 'Invalid vote rule'],
      [{ concurrency: 1.5 }, 'concurrency must be a positive integer; got 1.5.'],
    ];
    for (const [index, [options, message]] of cases.entries()) {
      const harness = scripted({}, passing);
      await expect(run(gate(options), harness, `bad-${String(index)}`)).rejects.toThrow(message);
      expect(harness.calls).toHaveLength(0);
    }
  });
});

describe('gate schemas', () => {
  it('sends only schemas both harnesses accept', () => {
    for (const schema of [types.CriterionResult, types.Assessment, types.Refutation])
      expect(checkCodexSchema(schema)).toEqual([]);
  });

  it('declares the team slots', () => {
    expect(Object.keys(gates.ChecklistTeam.slots)).toEqual(['checker']);
    expect(Object.keys(gates.GateTeam.slots)).toEqual(['assessor', 'skeptic']);
    expect(gates.GateTeam.slots.skeptic).toContain('std.roles.Skeptic');
  });
});
