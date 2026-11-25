// quiet-choir/std panels (std.patterns.lensPanel, vote, verify, hunt) end to end against a scripted
// harness: exact step IDs, default prompts and their safe defaults, failure tolerance (a failed call
// becomes data, is counted, and is not retried on resume), replay after a tail failure without new
// calls, the hunt's dry rule and call cap, option validation before any effect, and the Codex
// schema check of every schema the panels send.
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
import { findingKey } from '../src/std/data.js';
import * as lenses from '../src/std/lenses.js';
import * as panels from '../src/std/panels.js';
import * as types from '../src/std/types.js';
import {
  ScriptedHarness,
  makeRoot,
  promptOf,
  removeRoot,
  replayAfterTail,
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

/** A harness answering each call through `answer`; a returned Error is thrown. */
function scripted(answer: (request: HarnessRequest) => unknown): ScriptedHarness {
  return new ScriptedHarness((request) => {
    const reply = answer(request);
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw new Error(`Unexpected call ${request.stepId}`);
    return reply;
  });
}

/** The log events a run recorded, as `[message, data]` pairs. */
function logs(result: WorkflowResult<unknown>): [string, unknown][] {
  return (result.events ?? []).flatMap((event) =>
    event.type === 'log' ? [[event.message, event.data] as [string, unknown]] : [],
  );
}

/** A located finding in `file` with the given title and severity. */
function finding(title: string, severity: types.Severity, file = 'src/a.ts'): types.Finding {
  return { title, file, line: 3, severity, evidence: `${file}:3`, failureScenario: 'it breaks' };
}

/** The step-ID segment of a finding's key, as hunt and verify use it. */
function segment(item: types.Finding): string {
  return stepId(findingKey(item));
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

const subset = lenses.review.filter((lens) =>
  ['correctness', 'security', 'tests'].includes(lens.key),
);

describe('lensPanel', () => {
  const panel = (options: Partial<panels.LensPanelOptions<types.Findings>> = {}) =>
    workflow('lens-panel', (ctx) =>
      panels.lensPanel(ctx, {
        id: 'panel',
        team: { reader: ctx.claude.bind({}) },
        lenses: subset,
        subject: 'The diff of src/a.ts.',
        schema: types.Findings,
        ...options,
      }),
    );
  /** Each lens reports one finding titled after the lens; lenses in `failing` throw. */
  const readers = (...failing: string[]) =>
    scripted((request) => {
      const lens = request.stepId.split('/')[2] ?? '?';
      if (failing.includes(lens)) return new Error(`${lens} reader crashed`);
      return { findings: [finding(`${lens} issue`, 'medium')] };
    });

  it('asks one reader per lens with exact step IDs and collects answers in lens order', async () => {
    const harness = readers();
    const result = await replayAfterTail(panel(), null, harness, root);
    expect(result.output).toEqual({
      results: subset.map((lens) => ({
        lens,
        value: { findings: [finding(`${lens.key} issue`, 'medium')] },
      })),
      failed: [],
      quorum: true,
      status: 'complete',
    });
    expect(mapIds(result)).toEqual(['panel/lens']);
    expect([...harness.ids()].sort()).toEqual([
      'panel/lens/correctness/read',
      'panel/lens/security/read',
      'panel/lens/tests/read',
    ]);
    const prompt = harness.prompt('panel/lens/security/read');
    expect(prompt).toContain(
      `Examine the subject below. Work through one lens only, security: ${subset[1]?.charter ?? ''}`,
    );
    expect(prompt).toContain('## Context\n\nThe diff of src/a.ts.');
    expect(prompt).toContain('When this lens finds nothing, an empty answer is valid.');
  });

  it('reports a failed lens as data, keeps quorum by count and does not retry it', async () => {
    const harness = readers('security');
    const result = await replayAfterTail(panel(), null, harness, root);
    const output = result.output as unknown as panels.LensPanelResult<types.Findings>;
    expect(output.results.map((answer) => answer.lens.key)).toEqual(['correctness', 'tests']);
    expect(output.failed).toEqual([subset[1]]);
    expect(output).toMatchObject({ quorum: true, status: 'degraded' });
    expect(harness.count('panel/lens/security/read')).toBe(1);

    const most = await run(panel(), readers('security', 'tests'), 'most');
    expect(most.output).toMatchObject({ quorum: false, status: 'degraded' });
  });

  it('uses the task, a custom prompt and unique keys for repeated lens keys', async () => {
    const twin = [lenses.lens('a', 'First charter.'), lenses.lens('a', 'Second charter.')];
    const tasked = readers();
    await run(panel({ lenses: twin, task: 'Review the diff below for defects.' }), tasked, 't');
    expect([...tasked.ids()].sort()).toEqual(['panel/lens/a.2/read', 'panel/lens/a/read']);
    expect(tasked.prompt('panel/lens/a.2/read')).toMatch(
      /^Review the diff below for defects\. Work through one lens only, a: Second charter\./u,
    );

    const custom = readers();
    const result = await run(
      panel({ prompts: { read: (lens, subject) => `${lens.key} :: ${subject}` } }),
      custom,
      'c',
    );
    expect(custom.prompt('panel/lens/tests/read')).toBe('tests :: The diff of src/a.ts.');
    expect(result.output).toMatchObject({ status: 'complete' });
  });

  it('refuses to replay answers after a prompt or version change', async () => {
    const harness = readers();
    expect(await resumeChanged(panel(), panel({ task: 'Look closer.' }), harness)).toBe(
      'Settled map panel/lens changed after an item completed (changed: items); --accept-code-change accepts only a mapper change. Fork a new run.',
    );
    expect(await resumeChanged(panel(), panel({ version: '2' }), harness, 'version')).toMatch(
      /^Settled map panel\/lens changed after an item completed \(changed: version\)/u,
    );
    expect(harness.calls).toHaveLength(6);
  });

  it('refuses to replay answers after a call placement change, not a deadline change', async () => {
    const harness = readers();
    expect(await resumeChanged(panel(), panel({ calls: { addDirs: ['extra'] } }), harness)).toMatch(
      /^Settled map panel\/lens changed after an item completed \(changed: items\)/u,
    );
    expect(
      await resumeChanged(panel(), panel({ calls: { timeoutMs: 5_000 } }), harness, 'policy'),
    ).toBe('resumed');
  });

  it('passes the call defaults to every reader call', async () => {
    const calls = { timeoutMs: 12_345, addDirs: ['extra'] };
    const harness = readers();
    await run(panel({ calls }), harness);
    expect(harness.calls).toHaveLength(3);
    for (const call of harness.calls) expect(call.options).toMatchObject(calls);
  });

  it('validates options before any call', async () => {
    const harness = readers();
    await expect(run(panel({ team: {} as panels.LensTeam }), harness, 'team')).rejects.toThrow(
      'Team slot reader is not filled.',
    );
    await expect(run(panel({ lenses: [] }), harness, 'empty')).rejects.toThrow(
      'lenses must not be empty.',
    );
    await expect(run(panel({ concurrency: 0 }), harness, 'conc')).rejects.toThrow(
      'concurrency must be a positive integer; got 0.',
    );
    expect(harness.calls).toHaveLength(0);
  });
});

describe('vote', () => {
  const ballot = (options: Partial<panels.VoteOptions> = {}) =>
    workflow('vote', (ctx) =>
      panels.vote(ctx, {
        id: 'v',
        team: { voter: ctx.claude.bind({}) },
        question: 'Is the change safe to merge?',
        ...options,
      }),
    );
  /** Seat `n` votes `votes[n]`: true, false, or an Error to fail. */
  const voters = (...votes: (boolean | Error)[]) =>
    scripted((request) => {
      const seat = Number(request.stepId.split('/')[2]);
      const vote = votes[seat];
      return vote instanceof Error || vote === undefined
        ? vote
        : { yes: vote, reasoning: `seat ${String(seat)}` };
    });

  it('decides a majority with exact step IDs and seat-ordered reasons', async () => {
    const harness = voters(true, true, false);
    const result = await replayAfterTail(ballot(), null, harness, root);
    expect(result.output).toEqual({
      outcome: 'yes',
      yes: 2,
      no: 1,
      missing: 0,
      seats: 3,
      reasons: ['yes: seat 0', 'yes: seat 1', 'no: seat 2'],
      status: 'complete',
    });
    expect(mapIds(result)).toEqual(['v/seat']);
    expect([...harness.ids()].sort()).toEqual([
      'v/seat/0/ballot',
      'v/seat/1/ballot',
      'v/seat/2/ballot',
    ]);
    const prompt = harness.prompt('v/seat/1/ballot');
    expect(prompt).toMatch(/^Vote yes or no on this question: Is the change safe to merge\?/u);
    expect(prompt).toContain('vote no; that is the safe default.');
    expect(prompt).not.toContain('## Context');
  });

  it('counts a failed seat as missing, leaves the vote open and does not retry it', async () => {
    const harness = voters(true, new Error('seat crashed'), false);
    const result = await replayAfterTail(ballot({ context: 'The diff.' }), null, harness, root);
    expect(result.output).toEqual({
      outcome: 'undecided',
      yes: 1,
      no: 1,
      missing: 1,
      seats: 3,
      reasons: ['yes: seat 0', 'no: seat 2'],
      status: 'degraded',
    });
    expect(harness.count('v/seat/1/ballot')).toBe(1);
    expect(harness.prompt('v/seat/0/ballot')).toContain('## Context\n\nThe diff.');
  });

  it('applies the rule and a custom prompt per seat', async () => {
    const both = await run(ballot({ seats: 2, rule: 'unanimous' }), voters(true, true), 'u1');
    expect(both.output).toMatchObject({ outcome: 'yes', seats: 2 });
    const split = await run(ballot({ seats: 2, rule: 'unanimous' }), voters(true, false), 'u2');
    expect(split.output).toMatchObject({ outcome: 'no', yes: 1, no: 1 });

    const harness = voters(false, true, true, true);
    const result = await run(
      ballot({
        seats: 4,
        rule: { atLeast: 1 },
        prompts: {
          ballot: (question, seat, seats) => `${question} (${String(seat)}/${String(seats)})`,
        },
      }),
      harness,
      'custom',
    );
    expect(result.output).toMatchObject({ outcome: 'yes', yes: 3, no: 1 });
    expect(harness.prompt('v/seat/3/ballot')).toBe('Is the change safe to merge? (3/4)');
  });

  it('passes the call defaults to every seat and refuses a changed question on resume', async () => {
    const calls = { timeoutMs: 12_345, addDirs: ['extra'] };
    const harness = voters(true, true, true);
    await run(ballot({ calls }), harness);
    expect(harness.calls).toHaveLength(3);
    for (const call of harness.calls) expect(call.options).toMatchObject(calls);

    const message = await resumeChanged(ballot(), ballot({ question: 'Is it fast?' }), harness);
    expect(message).toMatch(
      /^Settled map v\/seat changed after an item completed \(changed: items\)/u,
    );
  });

  it('refuses to replay seats after a call placement change', async () => {
    const harness = voters(true, true, true);
    expect(await resumeChanged(ballot(), ballot({ calls: { cwd: 'pkg' } }), harness)).toMatch(
      /^Settled map v\/seat changed after an item completed \(changed: items\)/u,
    );
  });

  it('refuses a second panel with the same id in one scope', async () => {
    const harness = voters(true, true, true);
    const twice = workflow('vote-twice', async (ctx) => {
      const team = { voter: ctx.claude.bind({}) };
      await panels.vote(ctx, { id: 'v', team, question: 'First?' });
      return panels.vote(ctx, { id: 'v', team, question: 'Second?' });
    });
    await expect(run(twice, harness)).rejects.toThrow('Duplicate settled map ID: v/seat.');
    expect(harness.calls).toHaveLength(3);
  });

  it('validates the team, seats, rule and concurrency before any call', async () => {
    const harness = voters(true, true, true);
    await expect(run(ballot({ team: {} as panels.VoteTeam }), harness, 't')).rejects.toThrow(
      'Team slot voter is not filled.',
    );
    await expect(run(ballot({ seats: 0 }), harness, 's0')).rejects.toThrow(
      'seats must be a positive integer; got 0.',
    );
    await expect(run(ballot({ rule: { atLeast: 4 } }), harness, 'r4')).rejects.toThrow(
      'Invalid vote rule',
    );
    await expect(run(ballot({ concurrency: 1.5 }), harness, 'c')).rejects.toThrow(
      'concurrency must be a positive integer; got 1.5.',
    );
    expect(harness.calls).toHaveLength(0);
  });
});

describe('verify', () => {
  const claims = [
    finding('Null dereference in parse', 'high'),
    finding('Off by one in slice', 'low', 'src/b.ts'),
    finding('Leaked handle', 'medium', 'src/c.ts'),
  ];
  const [nullDeref, offByOne, leak] = claims as [types.Finding, types.Finding, types.Finding];
  const check = (options: Partial<panels.VerifyOptions<types.Finding>> = {}) =>
    workflow('verify', (ctx) =>
      panels.verify(ctx, {
        id: 'verify',
        team: { skeptic: ctx.claude.bind({}) },
        items: claims,
        key: findingKey,
        ...options,
      }),
    );
  /** Skeptics uphold `nullDeref`, refute `offByOne`, and split on `leak` with seat 2 failing. */
  const skeptics = () =>
    scripted((request) => {
      const [, , key, , seat] = request.stepId.split('/');
      if (key === segment(nullDeref)) return { refuted: false, reasoning: `holds ${seat ?? ''}` };
      if (key === segment(offByOne)) return { refuted: true, reasoning: `guarded ${seat ?? ''}` };
      if (seat === '0') return { refuted: false, reasoning: 'leaks' };
      if (seat === '1') return { refuted: true, reasoning: 'closed in finally' };
      return new Error('skeptic crashed');
    });

  it('decides each item by its own panel with exact step IDs and the safe default prompt', async () => {
    const harness = skeptics();
    const result = await replayAfterTail(check(), null, harness, root);
    const output = result.output as unknown as panels.VerifyResult<types.Finding>;
    expect(output.confirmed).toEqual([
      {
        key: segment(nullDeref),
        item: nullDeref,
        outcome: 'confirmed',
        upheld: 3,
        against: 0,
        missing: 0,
        seats: 3,
        reasons: ['upheld: holds 0', 'upheld: holds 1', 'upheld: holds 2'],
      },
    ]);
    expect(output.refuted.map((verdict) => [verdict.item.title, verdict.against])).toEqual([
      ['Off by one in slice', 3],
    ]);
    expect(output.undecided).toEqual([
      {
        key: segment(leak),
        item: leak,
        outcome: 'undecided',
        upheld: 1,
        against: 1,
        missing: 1,
        seats: 3,
        reasons: ['upheld: leaks', 'refuted: closed in finally'],
      },
    ]);
    expect(output).toMatchObject({ failedVotes: 1, status: 'degraded' });
    expect(mapIds(result)).toEqual(
      ['verify/item', ...claims.map((claim) => `verify/item/${segment(claim)}/seat`)].sort(),
    );
    expect([...harness.ids()].sort()).toEqual(
      claims
        .flatMap((claim) =>
          [0, 1, 2].map((seat) => `verify/item/${segment(claim)}/seat/${String(seat)}/verdict`),
        )
        .sort(),
    );
    expect(harness.count(`verify/item/${segment(leak)}/seat/2/verdict`)).toBe(1);
    const prompt = harness.prompt(`verify/item/${segment(nullDeref)}/seat/0/verdict`);
    expect(prompt).toMatch(/^Try to refute the claim below\./u);
    expect(prompt).toContain('```json\n{\n  "title": "Null dereference in parse",');
    expect(prompt).toContain('refute the claim (refuted: true); that is the safe default.');
    expect(prompt).not.toContain('## Subject');
  });

  it('shows the context under the claim and passes the call defaults to every seat', async () => {
    const calls = { timeoutMs: 12_345, addDirs: ['extra'] };
    const harness = skeptics();
    await run(check({ items: [nullDeref], context: 'The diff of src/a.ts.', calls }), harness);
    expect(harness.calls).toHaveLength(3);
    for (const call of harness.calls) expect(call.options).toMatchObject(calls);
    const prompt = harness.prompt(`verify/item/${segment(nullDeref)}/seat/2/verdict`);
    expect(prompt).toContain('"failureScenario": "it breaks"\n}\n```\n\n## Subject\n\nThe diff');
    expect(prompt).toContain('check it against that material and the code it refers to.');
  });

  it('uses a string item itself as the claim', async () => {
    const harness = scripted(() => ({
      refuted: true,
      reasoning: 'The cache is cleared on write.',
    }));
    const result = await run(
      workflow('verify-text', (ctx) =>
        panels.verify(ctx, {
          id: 'verify',
          team: { skeptic: ctx.claude.bind({}) },
          items: ['The cache is never invalidated.'],
          seats: 1,
        }),
      ),
      harness,
    );
    expect(harness.prompt('verify/item/0/seat/0/verdict')).toContain(
      '## Context\n\nThe cache is never invalidated.\n\n## Guidance',
    );
    expect(result.output).toMatchObject({
      refuted: [{ key: '0', item: 'The cache is never invalidated.', against: 1 }],
      status: 'complete',
    });
  });

  it('replays JSON claims from a z.record workflow input after a resume without the input', async () => {
    const definition = defineWorkflow({
      name: 'verify-input',
      version: '1',
      input: z.object({ claims: z.array(z.record(z.string(), z.string())) }),
      output: z.unknown(),
      run: (ctx, input) =>
        panels.verify(ctx, {
          id: 'verify',
          team: { skeptic: ctx.claude.bind({}) },
          items: input.claims,
          seats: 1,
        }),
    });
    const harness = scripted(() => ({ refuted: false, reasoning: 'It holds.' }));
    const wrapped = tailFailure(definition);
    const options = { ...runOptions(root), harness };
    const input = { claims: [{ zeta: 'The last field.', alpha: 'The first field.' }] };
    await expect(runWorkflow(wrapped, { ...options, input })).rejects.toThrow(
      'Injected tail failure',
    );
    const resumed = await runWorkflow(wrapped, { ...options, resume: true });
    expect(harness.calls).toHaveLength(1);
    expect(resumed.output).toMatchObject({ confirmed: [{ key: '0', upheld: 1 }] });
  });

  it('refuses a version change for a seat map an interrupted run left behind', async () => {
    // A run budget of one attempt stops the run inside the only item's seat map: one seat commits
    // there, the item itself does not, so on resume the outer map starts over and only the seat
    // map's own version check keeps the committed seat from being reused under a new version.
    const harness = scripted(() => ({ refuted: false, reasoning: 'ok' }));
    const options = { ...runOptions(root), harness };
    const one = (version?: string) =>
      check({ items: [nullDeref], key: undefined, seats: 2, version });
    await expect(
      runWorkflow(one(), { ...options, input: null, maxRunAgentAttempts: 1 }),
    ).rejects.toThrow('maxRunAgentAttempts');
    await expect(
      runWorkflow(one('v2'), { ...options, resume: true, maxRunAgentAttempts: 10 }),
    ).rejects.toThrow(
      'Settled map verify/item/0/seat changed after an item completed (changed: version)',
    );
    expect(harness.calls).toHaveLength(1);
  });

  it('refuses to replay verdicts after a call placement change, in either map', async () => {
    const harness = skeptics();
    const message = await resumeChanged(check(), check({ calls: { addDirs: ['extra'] } }), harness);
    expect(message).toMatch(
      /^Settled map verify\/item changed after an item completed \(changed: items\)/u,
    );
    // As above, a run budget of one attempt leaves only a seat of the seat map committed.
    const options = { ...runOptions(root, 'seat'), harness };
    const one = (calls?: { readonly addDirs: string[] }) =>
      check({ items: [nullDeref], key: undefined, seats: 2, calls });
    await expect(
      runWorkflow(one(), { ...options, input: null, maxRunAgentAttempts: 1 }),
    ).rejects.toThrow('maxRunAgentAttempts');
    await expect(
      runWorkflow(one({ addDirs: ['extra'] }), {
        ...options,
        resume: true,
        maxRunAgentAttempts: 10,
      }),
    ).rejects.toThrow(
      'Settled map verify/item/0/seat changed after an item completed (changed: items)',
    );
  });

  it('refuses to replay verdicts after a version change in the outer map', async () => {
    const harness = skeptics();
    const message = await resumeChanged(check(), check({ version: 'v2' }), harness);
    expect(message).toMatch(
      /^Settled map verify\/item changed after an item completed \(changed: version\)/u,
    );
  });

  it('defaults keys to the index and sizes panels per item with custom claims and prompts', async () => {
    const harness = scripted((request) => ({
      refuted: promptOf(request).includes('Off by one'),
      reasoning: 'checked',
    }));
    const result = await run(
      check({
        key: undefined,
        seats: (item) => (item.severity === 'high' ? 2 : 1),
        claim: (item) => `${item.file}: ${item.title}`,
        prompts: {
          verify: (claim, seat, seats) => `${claim} [${String(seat)} of ${String(seats)}]`,
        },
      }),
      harness,
      'sized',
    );
    expect([...harness.ids()].sort()).toEqual([
      'verify/item/0/seat/0/verdict',
      'verify/item/0/seat/1/verdict',
      'verify/item/1/seat/0/verdict',
      'verify/item/2/seat/0/verdict',
    ]);
    expect(harness.prompt('verify/item/0/seat/1/verdict')).toBe(
      'src/a.ts: Null dereference in parse [1 of 2]',
    );
    const output = result.output as unknown as panels.VerifyResult<types.Finding>;
    expect(output.confirmed.map((verdict) => [verdict.key, verdict.seats])).toEqual([
      ['0', 2],
      ['2', 1],
    ]);
    expect(output.refuted.map((verdict) => verdict.key)).toEqual(['1']);
    expect(output).toMatchObject({ undecided: [], failedVotes: 0, status: 'complete' });
  });

  it('suffixes repeated keys and records nothing for no items', async () => {
    const harness = scripted(() => ({ refuted: false, reasoning: 'ok' }));
    await run(check({ items: [nullDeref, nullDeref], seats: 1 }), harness, 'twice');
    expect([...harness.ids()].sort()).toEqual([
      `verify/item/${segment(nullDeref)}.2/seat/0/verdict`,
      `verify/item/${segment(nullDeref)}/seat/0/verdict`,
    ]);

    const none = await run(check({ items: [] }), harness, 'none');
    expect(none.output).toEqual({
      confirmed: [],
      refuted: [],
      undecided: [],
      failedVotes: 0,
      status: 'complete',
    });
    expect(none.maps ?? {}).toEqual({});
  });

  it('validates the team, seats and the rule before any call', async () => {
    const harness = skeptics();
    await expect(run(check({ team: {} as panels.VerifyTeam }), harness, 't')).rejects.toThrow(
      'Team slot skeptic is not filled.',
    );
    await expect(run(check({ seats: () => 0 }), harness, 's0')).rejects.toThrow(
      'seats must be a positive integer; got 0.',
    );
    await expect(run(check({ seats: 2, rule: { atLeast: 3 } }), harness, 'r3')).rejects.toThrow(
      'Invalid vote rule',
    );
    expect(harness.calls).toHaveLength(0);
  });
});

describe('hunt', () => {
  const pool = ['a', 'b', 'c', 'd'].map((key) => lenses.lens(key, `Charter ${key}.`));
  const f1 = finding('First bug', 'high');
  const f2 = finding('Second bug', 'critical', 'src/b.ts');
  const f3 = finding('Third bug', 'low', 'src/c.ts');
  const search = (options: Partial<panels.HuntOptions> = {}) =>
    workflow('hunt', (ctx) =>
      panels.hunt(ctx, {
        id: 'h',
        team: { finder: ctx.claude.bind({}), skeptic: ctx.claude.bind({}) },
        subject: 'The parser.',
        lenses: pool,
        perRound: 2,
        rounds: 6,
        seats: 1,
        ...options,
      }),
    );
  /**
   * Finders answer from `finds` by `<round>/<lens>` (default: nothing); an Error fails the call.
   * Skeptics uphold every finding except those titled in `refute`.
   */
  const hunters = (
    finds: Readonly<Record<string, types.Finding[] | Error>>,
    refute: string[] = [],
  ) =>
    scripted((request) => {
      const parts = request.stepId.split('/');
      if (parts.at(-1) === 'find') {
        const found = finds[`${parts[2] ?? ''}/${parts[4] ?? ''}`] ?? [];
        return found instanceof Error ? found : { findings: found };
      }
      const refuted = refute.some((title) => promptOf(request).includes(title));
      return { refuted, reasoning: refuted ? 'guarded' : 'reproduced' };
    });

  it('rotates lenses, verifies each round’s new findings and stops after two dry rounds', async () => {
    const harness = hunters(
      { '0/a': [f1], '0/b': [f2, { ...f1, title: 'first  BUG' }], '1/c': [f1] },
      ['Second bug'],
    );
    const result = await replayAfterTail(search(), null, harness, root);
    const output = result.output as unknown as panels.HuntResult;
    expect(output.confirmed.map((verdict) => verdict.item)).toEqual([f1]);
    expect(output.refuted.map((verdict) => verdict.item)).toEqual([f2]);
    expect(output).toMatchObject({
      undecided: [],
      unverified: [],
      rounds: 3,
      dryRounds: 2,
      failedFinders: 0,
      failedVotes: 0,
      callsAdmitted: 8,
      ended: 'dry',
      status: 'complete',
    });
    expect(mapIds(result)).toEqual(
      [
        'h/round/0/item',
        `h/round/0/item/${segment(f1)}/seat`,
        `h/round/0/item/${segment(f2)}/seat`,
        'h/round/0/lens',
        'h/round/1/lens',
        'h/round/2/lens',
      ].sort(),
    );
    expect(
      harness
        .ids()
        .filter((id) => id.startsWith('h/round/0/'))
        .sort(),
    ).toEqual([
      `h/round/0/item/${segment(f1)}/seat/0/verdict`,
      `h/round/0/item/${segment(f2)}/seat/0/verdict`,
      'h/round/0/lens/a/find',
      'h/round/0/lens/b/find',
    ]);
    expect(
      harness
        .ids()
        .filter((id) => !id.startsWith('h/round/0/'))
        .sort(),
    ).toEqual([
      'h/round/1/lens/c/find',
      'h/round/1/lens/d/find',
      'h/round/2/lens/a/find',
      'h/round/2/lens/b/find',
    ]);
    const first = harness.prompt('h/round/0/lens/a/find');
    expect(first).toMatch(
      /^Hunt for defects in the subject below through one lens, a: Charter a\./u,
    );
    expect(first).not.toContain('Already reported');
    const later = harness.prompt('h/round/1/lens/c/find');
    expect(later).toContain(
      '## Already reported\n\n- src/b.ts:3: Second bug\n- src/a.ts:3: First bug',
    );
    expect(later).toContain('Do not report anything listed under Already reported');
    const skeptic = harness.prompt(`h/round/0/item/${segment(f2)}/seat/0/verdict`);
    expect(skeptic).toContain('refute the claim (refuted: true); that is the safe default.');
    expect(skeptic).toContain('## Subject\n\nThe parser.\n\n## Guidance');
  });

  it('never counts a round with a failed finder as dry and does not retry it', async () => {
    const harness = hunters({ '0/a': new Error('finder crashed') });
    const result = await replayAfterTail(search({ rounds: 3 }), null, harness, root);
    expect(result.output).toMatchObject({
      rounds: 3,
      dryRounds: 2,
      failedFinders: 1,
      ended: 'dry',
      status: 'degraded',
    });
    expect(harness.count('h/round/0/lens/a/find')).toBe(1);
  });

  it('counts failed seats and leaves a finding undecided', async () => {
    const harness = scripted((request) => {
      if (request.stepId === 'h/round/0/lens/a/find') return { findings: [f1] };
      if (request.stepId.endsWith('/find')) return { findings: [] };
      return request.stepId.endsWith('/seat/1/verdict')
        ? new Error('skeptic crashed')
        : { refuted: request.stepId.endsWith('/seat/2/verdict'), reasoning: 'checked' };
    });
    const result = await run(search({ seats: 3 }), harness);
    const output = result.output as unknown as panels.HuntResult;
    expect(output.undecided.map((verdict) => [verdict.item.title, verdict.missing])).toEqual([
      ['First bug', 1],
    ]);
    expect(output).toMatchObject({ failedVotes: 1, failedFinders: 0, status: 'degraded' });
  });

  it('admits calls up to maxCalls, logs what it leaves out and ends at the call limit', async () => {
    const harness = hunters({ '0/a': [f3, f1], '0/b': [f2] });
    const result = await replayAfterTail(
      search({ perRound: 3, seats: 2, maxCalls: 7 }),
      null,
      harness,
      root,
    );
    const output = result.output as unknown as panels.HuntResult;
    expect(output.confirmed.map((verdict) => verdict.item)).toEqual([f2, f1]);
    expect(output).toMatchObject({
      unverified: [f3],
      rounds: 1,
      callsAdmitted: 7,
      ended: 'call-limit',
      status: 'call-limit',
    });
    expect(harness.ids().filter((id) => id.endsWith('/verdict'))).toHaveLength(4);
    expect(logs(result)).toEqual([
      [
        'Call limit: round 0 leaves 1 finding(s) unverified.',
        { round: 0, unverified: ['src/c.ts:3: Third bug'] },
      ],
    ]);

    const lensCap = hunters({});
    const capped = await run(search({ perRound: 3, maxCalls: 2 }), lensCap, 'lens-cap');
    expect(lensCap.ids().sort()).toEqual(['h/round/0/lens/a/find', 'h/round/0/lens/b/find']);
    expect(capped.output).toMatchObject({ rounds: 1, callsAdmitted: 2, ended: 'call-limit' });
    expect(logs(capped)).toEqual([
      ['Call limit: round 0 skips 1 lens(es).', { round: 0, skipped: ['c'] }],
    ]);

    const spent = hunters({ '0/a': [f1] });
    const exact = await run(search({ maxCalls: 3 }), spent, 'exact');
    expect(exact.output).toMatchObject({ rounds: 1, callsAdmitted: 3, status: 'call-limit' });
    expect(logs(exact)).toEqual([
      ['Call limit reached before round 1; the hunt ends.', { round: 1, maxCalls: 3 }],
    ]);
  });

  it('defaults to the bug lenses and runs every lens before it ends dry', async () => {
    const harness = hunters({});
    const result = await run(
      search({ lenses: undefined, perRound: undefined, rounds: undefined, seats: undefined }),
      harness,
    );
    // Two dry windows cover only six of the eight lenses, so a third round runs the last two.
    expect(result.output).toMatchObject({
      rounds: 3,
      dryRounds: 3,
      callsAdmitted: 9,
      ended: 'dry',
      status: 'complete',
    });
    expect(new Set(harness.ids())).toEqual(
      new Set(
        lenses.bugs.map(
          (lens, index) => `h/round/${String(Math.floor(index / 3))}/lens/${lens.key}/find`,
        ),
      ).add('h/round/2/lens/error-handling/find'),
    );

    const single = hunters({});
    const patient = await run(search({ perRound: 1, patience: 1 }), single, 'single');
    expect(patient.output).toMatchObject({ rounds: 4, dryRounds: 4, ended: 'dry' });
    expect(single.ids()).toEqual(
      ['a', 'b', 'c', 'd'].map((key, n) => `h/round/${String(n)}/lens/${key}/find`),
    );

    const short = await run(search({ perRound: 1, rounds: 3 }), hunters({}), 'short');
    expect(short.output).toMatchObject({ rounds: 3, dryRounds: 3, ended: 'round-limit' });

    const busy = hunters({ '0/a': [f1] });
    const limited = await run(search({ rounds: 1 }), busy, 'limit');
    expect(limited.output).toMatchObject({ rounds: 1, ended: 'round-limit', status: 'complete' });
  });

  it('refuses to replay finders after a call placement change', async () => {
    const harness = hunters({ '0/a': [f1] });
    expect(await resumeChanged(search(), search({ calls: { worktree: true } }), harness)).toMatch(
      /^Settled map h\/round\/0\/lens changed after an item completed \(changed: items\)/u,
    );
  });

  it('passes the call defaults to every call and sizes each finding once', async () => {
    const calls = { timeoutMs: 12_345, addDirs: ['extra'] };
    const harness = hunters({ '0/a': [f1, f3], '0/b': [f2] });
    const sized: string[] = [];
    const result = await run(
      search({
        calls,
        seats: (item) => {
          sized.push(item.title);
          return item.severity === 'low' ? 1 : 2;
        },
      }),
      harness,
    );
    expect(sized).toEqual(['Second bug', 'First bug', 'Third bug']);
    // Three rounds of two finders, plus 2 + 2 + 1 seats for the round-0 findings.
    expect(result.output).toMatchObject({ rounds: 3, callsAdmitted: 6 + 5, status: 'complete' });
    expect(harness.ids().filter((id) => id.endsWith('/verdict'))).toHaveLength(5);
    for (const call of harness.calls) expect(call.options).toMatchObject(calls);
  });

  it('validates options before any call', async () => {
    const harness = hunters({});
    const cases: [Partial<panels.HuntOptions>, string][] = [
      [{ team: { finder: {} } as unknown as panels.HuntTeam }, 'Team slot skeptic is not filled.'],
      [{ lenses: [] }, 'lenses must not be empty.'],
      [{ perRound: 0 }, 'perRound must be a positive integer; got 0.'],
      [{ rounds: 0 }, 'rounds must be a positive integer; got 0.'],
      [{ patience: -1 }, 'patience must be a positive integer; got -1.'],
      [{ maxCalls: 0 }, 'maxCalls must be a positive integer; got 0.'],
      [{ seats: 1, rule: { atLeast: 2 } }, 'Invalid vote rule'],
      [{ concurrency: 0 }, 'concurrency must be a positive integer; got 0.'],
    ];
    for (const [index, [options, message]] of cases.entries())
      await expect(run(search(options), harness, `bad-${String(index)}`)).rejects.toThrow(message);
    expect(harness.calls).toHaveLength(0);
  });
});

describe('schemas', () => {
  it('sends only schemas both harnesses accept', () => {
    for (const schema of [types.Findings, types.Refutation, types.Ballot])
      expect(checkCodexSchema(schema)).toEqual([]);
  });

  it('declares teams whose slots name a std role', () => {
    expect(Object.keys(panels.LensTeam.slots)).toEqual(['reader']);
    expect(Object.keys(panels.VoteTeam.slots)).toEqual(['voter']);
    expect(Object.keys(panels.VerifyTeam.slots)).toEqual(['skeptic']);
    expect(Object.keys(panels.HuntTeam.slots)).toEqual(['finder', 'skeptic']);
    for (const team of [panels.LensTeam, panels.VoteTeam, panels.VerifyTeam, panels.HuntTeam])
      for (const description of Object.values<string>(team.slots))
        expect(description).toMatch(/std\.roles\.[A-Z]/u);
  });
});
