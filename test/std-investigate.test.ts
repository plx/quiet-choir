// quiet-choir/std investigation patterns (std.patterns.falsify, research) end to end against a
// scripted harness: exact step IDs, default prompts and their safe defaults, the structural
// confidence and lead ranking decided in code, failure tolerance (a failed call becomes data, is
// counted and logged, and is not retried on resume), caps that log what they leave out, replay
// after a tail failure without new calls, option validation before any effect, and the Codex
// schema check of every schema the patterns send.
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
import * as investigate from '../src/std/investigate.js';
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

/** A harness answering each call by step ID; a returned Error is thrown. */
function scripted(
  replies: Readonly<Record<string, (request: HarnessRequest) => unknown>>,
): ScriptedHarness {
  return new ScriptedHarness((request) => {
    const reply = replies[request.stepId];
    if (reply === undefined) throw new Error(`Unexpected call ${request.stepId}`);
    const value = reply(request);
    if (value instanceof Error) throw value;
    return value;
  });
}

/** The step IDs called, sorted: the calls of one settled map start in no fixed order. */
function calledIds(harness: ScriptedHarness): string[] {
  return [...harness.ids()].sort();
}

/**
 * Run `first` to an injected tail failure, then resume the run with `second`; returns the resume's
 * error message, or `'resumed'`.
 */
async function resumeChanged(
  first: WorkflowDefinition<null, unknown>,
  second: WorkflowDefinition<null, unknown>,
  harness: ScriptedHarness,
): Promise<string> {
  const options = { ...runOptions(root, 'changed'), harness };
  await expect(runWorkflow(tailFailure(first), { ...options, input: null })).rejects.toThrow(
    'Injected tail failure',
  );
  return runWorkflow(tailFailure(second), { ...options, resume: true }).then(
    () => 'resumed',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

/** The log events a run recorded, as `[message, data]` pairs. */
function logs(result: WorkflowResult<unknown>): [string, unknown][] {
  return (result.events ?? []).flatMap((event) =>
    event.type === 'log' ? [[event.message, event.data] as [string, unknown]] : [],
  );
}

describe('falsify', () => {
  const question = 'Why did checkout requests time out after the 1.4.1 deploy?';
  const evidence = '## Commits\n\nabc1234 Lower the pool size to 4';

  /** A hypothesis `id` whose cause and predictions name it. */
  const hypothesis = (id: string): types.Hypothesis => ({
    id,
    cause: `Cause ${id}`,
    mechanism: `Mechanism ${id}`,
    predictions: [`Prediction ${id}.1`, `Prediction ${id}.2`],
  });
  const verdict = (outcome: types.FalsificationVerdict): types.Falsification => ({
    verdict: outcome,
    reasoning: `Checked: ${outcome}`,
    checked: ['Prediction checked'],
  });

  /** A workflow running falsify as `inc` with the given extra options. */
  const inquiry = (options: Partial<investigate.FalsifyOptions> = {}) =>
    workflow('falsify', async (ctx) => {
      const agent = ctx.claude.bind({});
      return investigate.falsify(ctx, {
        id: 'inc',
        team: { theorist: agent, falsifier: agent },
        question,
        context: evidence,
        ...options,
      });
    });

  /** Replies: the theorist proposes `ids`; each falsifier answers from `outcomes`. */
  const replies = (
    ids: readonly string[],
    outcomes: Readonly<Record<string, types.FalsificationVerdict | Error>>,
  ) => {
    const script: Record<string, (request: HarnessRequest) => unknown> = {
      'inc/theorize': () => ({ hypotheses: ids.map(hypothesis) }),
    };
    for (const [key, outcome] of Object.entries(outcomes)) {
      script[`inc/hypothesis/${key}/falsify`] = () =>
        outcome instanceof Error ? outcome : verdict(outcome);
    }
    return script;
  };

  it('rates one survivor whose rivals were all falsified as high, and replays', async () => {
    const harness = scripted(
      replies(['H1', 'H2', 'H3'], { H1: 'survives', H2: 'falsified', H3: 'falsified' }),
    );
    const result = await replayAfterTail(inquiry(), null, harness, root);
    expect(result.output).toEqual({
      hypotheses: [
        { key: 'H1', hypothesis: hypothesis('H1'), verdict: verdict('survives') },
        { key: 'H2', hypothesis: hypothesis('H2'), verdict: verdict('falsified') },
        { key: 'H3', hypothesis: hypothesis('H3'), verdict: verdict('falsified') },
      ],
      survivors: [hypothesis('H1')],
      confidence: 'high',
      falsified: 2,
      failures: 0,
      status: 'complete',
    });
    roundTrip(investigate.FalsifyResult, result.output);
    expect(calledIds(harness)).toEqual(
      [
        'inc/theorize',
        'inc/hypothesis/H1/falsify',
        'inc/hypothesis/H2/falsify',
        'inc/hypothesis/H3/falsify',
      ].sort(),
    );
    expect(harness.ids()[0]).toBe('inc/theorize');

    const theorize = harness.prompt('inc/theorize');
    expect(theorize).toContain(
      `Propose up to 4 distinct, competing hypotheses that could answer this question: ${question}`,
    );
    expect(theorize).toContain(`## Context\n\n### Evidence\n\n${evidence}\n\n## Guidance`);
    expect(theorize).toContain('Use short unique IDs: H1, H2, and so on.');

    const falsify = harness.prompt('inc/hypothesis/H2/falsify');
    expect(falsify.startsWith(`Try to falsify hypothesis H2 as the answer to this question:`)).toBe(
      true,
    );
    expect(falsify).toContain(
      '### Hypothesis H2\n\nCause H2\n\nMechanism: Mechanism H2\n\nPredictions:\n\n1. Prediction H2.1\n2. Prediction H2.2',
    );
    expect(falsify).toContain(
      '### Rival hypotheses (context only)\n\n- H1: Cause H1\n- H3: Cause H3',
    );
    expect(falsify).toContain(`### Evidence\n\n${evidence}`);
    expect(falsify).toContain(
      '- Check each prediction against the evidence above and against the code, logs or data',
    );
    expect(falsify).toContain('answer untestable; that is the safe default');
    const schemas = harness.calls.map((call) => call.outputSchema !== null);
    expect(schemas).toEqual([true, true, true, true]);
  });

  it('decides medium, split and none from the verdicts in code', async () => {
    const cases: [readonly string[], Record<string, types.FalsificationVerdict>, string][] = [
      [['H1'], { H1: 'survives' }, 'medium'],
      [['H1', 'H2'], { H1: 'survives', H2: 'untestable' }, 'medium'],
      [['H1', 'H2', 'H3'], { H1: 'falsified', H2: 'survives', H3: 'untestable' }, 'medium'],
      [['H1', 'H2', 'H3'], { H1: 'survives', H2: 'survives', H3: 'falsified' }, 'split'],
      [['H1', 'H2'], { H1: 'falsified', H2: 'untestable' }, 'none'],
    ];
    for (const [index, [ids, outcomes, confidence]] of cases.entries()) {
      const result = await run(inquiry(), scripted(replies(ids, outcomes)), `c${String(index)}`);
      expect(result.output).toMatchObject({ confidence, failures: 0, status: 'complete' });
      roundTrip(investigate.FalsifyResult, result.output);
    }
  });

  it('keeps a failed falsifier as an open hypothesis, logs it and does not retry it', async () => {
    const harness = scripted(
      replies(['H1', 'H2', 'H3'], {
        H1: 'survives',
        H2: 'falsified',
        H3: new Error('falsifier crashed'),
      }),
    );
    const result = await replayAfterTail(inquiry(), null, harness, root);
    expect(result.output).toMatchObject({
      survivors: [hypothesis('H1')],
      confidence: 'medium',
      falsified: 1,
      failures: 1,
      status: 'degraded',
    });
    expect((result.output as unknown as investigate.FalsifyResult).hypotheses[2]).toEqual({
      key: 'H3',
      hypothesis: hypothesis('H3'),
      verdict: null,
    });
    expect(harness.count('inc/hypothesis/H3/falsify')).toBe(1);
    roundTrip(investigate.FalsifyResult, result.output);
    expect(logs(result)).toContainEqual([
      'inc: 1 of 3 falsifier call(s) failed; those hypotheses stay open.',
      { failed: ['H3'] },
    ]);
  });

  it('tests only `count` hypotheses, logging the rest, and keys repeated or unclean IDs', async () => {
    const odd = 'root cause?';
    const harness = scripted({
      'inc/theorize': () => ({
        hypotheses: [hypothesis('H1'), hypothesis('H1'), hypothesis(odd), hypothesis('H4')],
      }),
      'inc/hypothesis/H1/falsify': () => verdict('falsified'),
      'inc/hypothesis/H1.2/falsify': () => verdict('survives'),
      [`inc/hypothesis/${stepId(odd)}/falsify`]: () => verdict('falsified'),
    });
    const result = await run(inquiry({ count: 3 }), harness);
    expect(result.output).toMatchObject({
      survivors: [hypothesis('H1')],
      confidence: 'high',
      falsified: 2,
    });
    const tested = (result.output as unknown as investigate.FalsifyResult).hypotheses;
    roundTrip(investigate.FalsifyResult, result.output);
    expect(tested.map((entry) => entry.key)).toEqual(['H1', 'H1.2', stepId(odd)]);
    expect(harness.prompt('inc/theorize')).toContain('Propose up to 3 distinct');
    expect(harness.prompt('inc/hypothesis/H1.2/falsify')).toContain(
      `- H1: Cause H1\n- ${stepId(odd)}: Cause ${odd}`,
    );
    expect(logs(result)).toContainEqual([
      'inc: the theorist proposed 4 hypotheses; testing the first 3 and not the remaining 1.',
      { dropped: ['H4: Cause H4'] },
    ]);
  });

  it('omits the evidence sections without context and uses replacement prompts', async () => {
    for (const [index, absent] of [undefined, ' \n '].entries()) {
      const bare = scripted(replies(['H1'], { H1: 'untestable' }));
      await run(inquiry({ context: absent }), bare, `bare-${String(index)}`);
      expect(bare.prompt('inc/theorize')).not.toContain('## Context');
      const falsify = bare.prompt('inc/hypothesis/H1/falsify');
      expect(falsify).not.toContain('### Evidence');
      expect(falsify).not.toContain('the evidence above');
      expect(falsify).toContain('- Check each prediction against the code, logs or data');
      expect(falsify).not.toContain('Rival hypotheses');
    }

    const custom = scripted(replies(['H1', 'H2'], { H1: 'survives', H2: 'falsified' }));
    await run(
      inquiry({
        prompts: {
          theorize: (text, count) => `theorize ${String(count)}: ${text}`,
          falsify: (tested, rivals, text) =>
            `falsify ${tested.id} against ${rivals.map((rival) => rival.id).join(',')}: ${text}`,
        },
      }),
      custom,
      'custom',
    );
    expect(custom.prompt('inc/theorize')).toBe(`theorize 4: ${question}`);
    expect(custom.prompt('inc/hypothesis/H1/falsify')).toBe(`falsify H1 against H2: ${question}`);
  });

  it('passes the call defaults to the theorist and every falsifier', async () => {
    const calls = { timeoutMs: 12_345, addDirs: ['extra'] };
    const harness = scripted(replies(['H1', 'H2'], { H1: 'survives', H2: 'falsified' }));
    await run(inquiry({ calls }), harness);
    expect(harness.calls).toHaveLength(3);
    for (const call of harness.calls) expect(call.options).toMatchObject(calls);
  });

  it('refuses a changed falsifier prompt on resume instead of reusing the verdicts', async () => {
    const harness = scripted(replies(['H1', 'H2'], { H1: 'survives', H2: 'falsified' }));
    const message = await resumeChanged(
      inquiry(),
      inquiry({ prompts: { falsify: (tested) => `Falsify ${tested.id}.` } }),
      harness,
    );
    expect(message).toMatch(
      /^Settled map inc\/hypothesis changed after an item completed \(changed: items\)/u,
    );
    expect(harness.calls).toHaveLength(3);
  });

  it('propagates a failed theorist call', async () => {
    const harness = scripted({ 'inc/theorize': () => new Error('theorist crashed') });
    await expect(run(inquiry(), harness)).rejects.toThrow('theorist crashed');
  });

  it('validates its options before any effect', async () => {
    const harness = scripted({});
    const cases: [Partial<investigate.FalsifyOptions>, string][] = [
      [{ count: 0 }, 'count must be a positive integer; got 0.'],
      [{ count: 9 }, 'count must be at most 8 (the most std.types.Hypotheses allows); got 9.'],
      [{ count: 2.5 }, 'count must be a positive integer; got 2.5.'],
      [{ concurrency: 0 }, 'concurrency must be a positive integer; got 0.'],
      [{ question: '  ' }, 'falsify needs a nonblank question.'],
      [{ team: {} as investigate.FalsifyTeam }, 'Team slot theorist is not filled.'],
    ];
    for (const [index, [options, message]] of cases.entries()) {
      await expect(run(inquiry(options), harness, `bad-${String(index)}`)).rejects.toThrow(message);
    }
    expect(harness.calls).toHaveLength(0);
  });
});

describe('research', () => {
  const question = 'Does undici 7 still pool connections per origin?';
  const angles = [
    lenses.lens('docs', 'Official documentation.'),
    lenses.lens('code', 'The source code.'),
    lenses.lens('issues', 'The issue tracker.'),
  ];
  const lead = (ref: string): types.Lead => ({ ref, why: `Reveals ${ref}` });
  const claim = (text: string, source: string): types.Citation => ({
    claim: text,
    source,
    quote: null,
  });

  /** A workflow running research as `rs` with the given extra options. */
  const study = (options: Partial<investigate.ResearchOptions> = {}) =>
    workflow('research', async (ctx) => {
      const agent = ctx.claude.bind({});
      return investigate.research(ctx, {
        id: 'rs',
        team: { scout: agent, reader: agent, synthesizer: agent },
        question,
        angles,
        ...options,
      });
    });

  const docsA = 'https://example.com/docs/pool';
  const docsB = 'https://example.com/docs/agent';
  const codeA = 'lib/dispatcher/pool.js';
  const codeB = 'lib/dispatcher/client.js';
  const issueA = 'https://github.com/nodejs/undici/issues/1';

  it('ranks corroborated leads first, caps the reads, cites the claims, and replays', async () => {
    const harness = scripted({
      'rs/scout/docs/leads': () => ({ leads: [lead(docsA), lead(docsB)] }),
      // The same pool page under another spelling corroborates docsA.
      'rs/scout/code/leads': () => ({
        leads: [lead(codeA), lead('http://www.Example.com/docs/pool/#top'), lead(codeB)],
      }),
      'rs/scout/issues/leads': () => ({ leads: [lead(issueA)] }),
      [`rs/read/${stepId(docsA)}/claims`]: () => ({
        claims: [claim('Pools are per origin.', `${docsA}#pool`)],
      }),
      [`rs/read/${stepId(codeA)}/claims`]: () => ({
        claims: [
          claim('Pool keys by origin.', `${codeA}:12`),
          claim('Pools are per  ORIGIN.', `${docsA}#pool`),
        ],
      }),
      [`rs/read/${stepId(issueA)}/claims`]: () => ({ claims: [] }),
      'rs/synthesize': () => 'Yes [1, 2].',
    });
    const result = await replayAfterTail(study({ reads: 3 }), null, harness, root);
    expect(result.output).toEqual({
      answered: true,
      answer: 'Yes [1, 2].',
      // issueA was read but yielded no claim, so it is not a source.
      sources: [lead(docsA), lead(codeA)],
      claims: [
        claim('Pools are per origin.', `${docsA}#pool`),
        claim('Pool keys by origin.', `${codeA}:12`),
      ],
      deferred: [lead(docsB), lead(codeB)],
      unread: [],
      failedScouts: 0,
      failedReads: 0,
      failures: 0,
      status: 'complete',
    });
    roundTrip(investigate.ResearchResult, result.output);
    expect(calledIds(harness)).toEqual(
      [
        'rs/scout/docs/leads',
        'rs/scout/code/leads',
        'rs/scout/issues/leads',
        `rs/read/${stepId(docsA)}/claims`,
        `rs/read/${stepId(codeA)}/claims`,
        `rs/read/${stepId(issueA)}/claims`,
        'rs/synthesize',
      ].sort(),
    );
    // Every scout answers before any reader, and the synthesizer comes last.
    expect(
      harness
        .ids()
        .slice(0, 3)
        .every((id) => id.startsWith('rs/scout/')),
    ).toBe(true);
    expect(harness.ids().at(-1)).toBe('rs/synthesize');
    expect(logs(result)).toContainEqual([
      'rs: the scouts named 5 distinct leads; reading the first 3 and deferring 2.',
      { deferred: [docsB, codeB] },
    ]);

    const scout = harness.prompt('rs/scout/code/leads');
    expect(scout).toContain('searching from one angle only, code: The source code.');
    expect(scout).toContain(`### Question\n\n${question}`);
    expect(scout).toContain('Return at most 5 leads, best first.');
    const read = harness.prompt(`rs/read/${stepId(codeA)}/claims`);
    expect(read).toContain(`### Source\n\n${codeA}\n\nExpected to reveal: Reveals ${codeA}`);
    expect(read).toContain('leave it out; that is the safe default');
    const synthesize = harness.prompt('rs/synthesize');
    expect(
      synthesize.startsWith('Answer the research question below from the numbered claims only.'),
    ).toBe(true);
    expect(synthesize).toContain(
      `### Claims\n\n1. Pools are per origin.\n   Source: ${docsA}#pool\n2. Pool keys by origin.\n   Source: ${codeA}:12`,
    );
    expect(synthesize).toContain('- Use only the claims above and add no facts of your own');
    expect(synthesize).toContain('such as [2] or [1, 4]');
    expect(synthesize).not.toContain('Not read');
    expect(harness.calls.at(-1)?.outputSchema).toBeNull();
  });

  it('tolerates failed scouts and readers, tells the synthesizer, and does not retry them', async () => {
    const harness = scripted({
      'rs/scout/docs/leads': () => ({ leads: [lead(docsA)] }),
      'rs/scout/code/leads': () => new Error('scout crashed'),
      'rs/scout/issues/leads': () => ({ leads: [lead(issueA)] }),
      [`rs/read/${stepId(docsA)}/claims`]: () => ({
        claims: [{ ...claim('Pools are per origin.', docsA), quote: 'one pool per origin' }],
      }),
      [`rs/read/${stepId(issueA)}/claims`]: () => new Error('reader crashed'),
      'rs/synthesize': () => 'Yes [1].',
    });
    const result = await replayAfterTail(study(), null, harness, root);
    expect(result.output).toMatchObject({
      answer: 'Yes [1].',
      sources: [lead(docsA)],
      deferred: [],
      unread: [lead(issueA)],
      failedScouts: 1,
      failedReads: 1,
      failures: 2,
      status: 'degraded',
    });
    expect(harness.count('rs/scout/code/leads')).toBe(1);
    expect(harness.count(`rs/read/${stepId(issueA)}/claims`)).toBe(1);
    roundTrip(investigate.ResearchResult, result.output);
    const synthesize = harness.prompt('rs/synthesize');
    expect(synthesize).toContain('Quote: one pool per origin');
    expect(synthesize).toContain(`### Not read\n\n- ${issueA}`);
    expect(synthesize).toContain('The sources under "Not read" could not be read');
    expect(logs(result)).toEqual(
      expect.arrayContaining([
        ['rs: 1 of 3 scout call(s) failed.', { failed: ['code'] }],
        ['rs: 1 of 2 reader call(s) failed.', { unread: [issueA] }],
      ]),
    );
  });

  it('is unanswered without leads or claims, and calls no reader or synthesizer then', async () => {
    const empty = scripted({
      'rs/scout/docs/leads': () => ({ leads: [] }),
      'rs/scout/code/leads': () => new Error('scout crashed'),
      'rs/scout/issues/leads': () => ({ leads: [] }),
    });
    const none = await run(study(), empty, 'none');
    expect(none.output).toEqual({
      answered: false,
      answer: '',
      sources: [],
      claims: [],
      deferred: [],
      unread: [],
      failedScouts: 1,
      failedReads: 0,
      failures: 1,
      status: 'degraded',
    });
    expect(empty.ids()).toHaveLength(3);
    roundTrip(investigate.ResearchResult, none.output);
    expect(logs(none)).toContainEqual([
      'rs: no scout named a lead; the question is unanswered.',
      null,
    ]);

    const silent = scripted({
      'rs/scout/docs/leads': () => ({ leads: [lead(docsA)] }),
      'rs/scout/code/leads': () => ({ leads: [] }),
      'rs/scout/issues/leads': () => ({ leads: [] }),
      [`rs/read/${stepId(docsA)}/claims`]: () => ({ claims: [] }),
    });
    const quiet = await run(study(), silent, 'quiet');
    expect(quiet.output).toMatchObject({
      answered: false,
      answer: '',
      sources: [],
      unread: [],
      failedReads: 0,
      failures: 0,
      status: 'complete',
    });
    expect(silent.ids()).not.toContain('rs/synthesize');
    roundTrip(investigate.ResearchResult, quiet.output);
  });

  it('keeps hash routes, issues and other pages distinct, merging only anchors', async () => {
    const pool = 'https://undici.nodejs.org/#/docs/api/Pool';
    const agentPage = 'https://undici.nodejs.org/#/docs/api/Agent';
    const issue1 = 'nodejs/undici#1';
    const issue2 = 'nodejs/undici#2';
    const file = 'lib/pool.js';
    const harness = new ScriptedHarness((request) => {
      if (request.stepId === 'rs/scout/docs/leads')
        return { leads: [lead(pool), lead(agentPage), lead(`${docsA}#options`)] };
      if (request.stepId === 'rs/scout/code/leads')
        return { leads: [lead(`./${file}#L12-L40`), lead(issue1), lead(docsA)] };
      if (request.stepId === 'rs/scout/issues/leads')
        return {
          leads: [
            lead(issue2),
            lead(`${file}#L3`),
            lead('HTTPS://undici.nodejs.org#/docs/api/Pool/'),
          ],
        };
      if (request.stepId.endsWith('/leads')) throw new Error(`Unexpected call ${request.stepId}`);
      return { claims: [] };
    });
    const result = await run(study({ reads: 3 }), harness);
    const output = result.output as unknown as investigate.ResearchResult;
    roundTrip(investigate.ResearchResult, output);
    // Six distinct leads: the pool page, the file and docsA were each named by two scouts and come
    // first; the rest follow by rank across the scouts. The first spelling of each is kept.
    const read = harness.ids().filter((id) => id.startsWith('rs/read/'));
    expect(read.sort()).toEqual(
      [pool, `./${file}#L12-L40`, `${docsA}#options`]
        .map((ref) => `rs/read/${stepId(ref)}/claims`)
        .sort(),
    );
    expect(output.deferred).toEqual([lead(issue2), lead(agentPage), lead(issue1)]);
  });

  it('keys a repeated angle key with a suffix', async () => {
    const harness = new ScriptedHarness((request) => {
      if (request.stepId.endsWith('/leads')) return { leads: [] };
      throw new Error(`Unexpected call ${request.stepId}`);
    });
    const twice = [angles[0], lenses.lens('docs', 'The changelog.')].flatMap((angle) =>
      angle === undefined ? [] : [angle],
    );
    await run(study({ angles: twice }), harness);
    expect(calledIds(harness)).toEqual(['rs/scout/docs.2/leads', 'rs/scout/docs/leads']);
    expect(harness.prompt('rs/scout/docs.2/leads')).toContain('docs: The changelog.');
  });

  it('passes the call defaults to every scout, reader and synthesizer call', async () => {
    const calls = { timeoutMs: 12_345, addDirs: ['extra'] };
    const harness = scripted({
      'rs/scout/docs/leads': () => ({ leads: [lead(docsA)] }),
      'rs/scout/code/leads': () => ({ leads: [lead(codeA)] }),
      'rs/scout/issues/leads': () => ({ leads: [] }),
      [`rs/read/${stepId(docsA)}/claims`]: () => ({ claims: [claim('Per origin.', docsA)] }),
      [`rs/read/${stepId(codeA)}/claims`]: () => ({ claims: [] }),
      'rs/synthesize': () => 'Yes [1].',
    });
    await run(study({ calls }), harness);
    expect(harness.calls).toHaveLength(6);
    for (const call of harness.calls) expect(call.options).toMatchObject(calls);
  });

  it('refuses a changed reader prompt on resume instead of reusing the claims', async () => {
    const harness = scripted({
      'rs/scout/docs/leads': () => ({ leads: [lead(docsA)] }),
      'rs/scout/code/leads': () => ({ leads: [] }),
      'rs/scout/issues/leads': () => ({ leads: [] }),
      [`rs/read/${stepId(docsA)}/claims`]: () => ({ claims: [claim('Per origin.', docsA)] }),
      'rs/synthesize': () => 'Yes [1].',
    });
    const message = await resumeChanged(
      study(),
      study({ prompts: { read: (item) => `Read ${item.ref}.` } }),
      harness,
    );
    expect(message).toMatch(
      /^Settled map rs\/read changed after an item completed \(changed: items\)/u,
    );
    expect(harness.calls).toHaveLength(5);
  });

  it('refuses to replay the scouts after a call placement change', async () => {
    const harness = scripted({
      'rs/scout/docs/leads': () => ({ leads: [] }),
      'rs/scout/code/leads': () => ({ leads: [] }),
      'rs/scout/issues/leads': () => ({ leads: [] }),
    });
    expect(await resumeChanged(study(), study({ calls: { addDirs: ['extra'] } }), harness)).toMatch(
      /^Settled map rs\/scout changed after an item completed \(changed: items\)/u,
    );
  });

  it('lets a failed synthesizer reject, then retries only the synthesizer on resume', async () => {
    let synthesis: string | Error = new Error('synthesizer crashed');
    const harness = scripted({
      'rs/scout/docs/leads': () => ({ leads: [lead(docsA)] }),
      'rs/scout/code/leads': () => ({ leads: [] }),
      'rs/scout/issues/leads': () => ({ leads: [] }),
      [`rs/read/${stepId(docsA)}/claims`]: () => ({ claims: [claim('Per origin.', docsA)] }),
      'rs/synthesize': () => synthesis,
    });
    const options = { ...runOptions(root, 'synth'), harness };
    await expect(runWorkflow(study(), { ...options, input: null })).rejects.toThrow(
      'synthesizer crashed',
    );
    synthesis = 'Yes [1].';
    const resumed = await runWorkflow(study(), { ...options, resume: true });
    expect(resumed.output).toMatchObject({ answer: 'Yes [1].', status: 'complete' });
    expect(harness.calls).toHaveLength(6);
    expect(harness.count('rs/synthesize')).toBe(2);
  });

  it('refuses a team without a reader before any scout runs', async () => {
    const harness = scripted({});
    const partial = workflow('partial', async (ctx) => {
      const agent = ctx.claude.bind({});
      return investigate.research(ctx, {
        id: 'rs',
        team: { scout: agent, synthesizer: agent } as unknown as investigate.ResearchTeam,
        question,
      });
    });
    await expect(run(partial, harness)).rejects.toThrow('Team slot reader is not filled.');
    expect(harness.calls).toHaveLength(0);
  });

  it('defaults to the std.lenses.research angles and shows the background', async () => {
    const harness = new ScriptedHarness((request) => {
      if (request.stepId.endsWith('/leads')) return { leads: [] };
      throw new Error(`Unexpected call ${request.stepId}`);
    });
    await run(study({ angles: undefined, context: 'We run Node 24.' }), harness);
    expect(calledIds(harness)).toEqual(
      lenses.research.map((angle) => `rs/scout/${angle.key}/leads`).sort(),
    );
    expect(harness.prompt('rs/scout/official-docs/leads')).toContain(
      `### Question\n\n${question}\n\n### Background\n\nWe run Node 24.`,
    );

    const blank = new ScriptedHarness(() => ({ leads: [] }));
    await run(study({ context: '  ' }), blank, 'blank');
    expect(blank.prompt('rs/scout/docs/leads')).not.toContain('### Background');
  });

  it('uses replacement prompts', async () => {
    const harness = scripted({
      'rs/scout/docs/leads': () => ({ leads: [lead(docsA)] }),
      'rs/scout/code/leads': () => ({ leads: [] }),
      'rs/scout/issues/leads': () => ({ leads: [] }),
      [`rs/read/${stepId(docsA)}/claims`]: () => ({ claims: [claim('Per origin.', docsA)] }),
      'rs/synthesize': () => 'Yes.',
    });
    await run(
      study({
        prompts: {
          scout: (angle, text) => `scout ${angle.key}: ${text}`,
          read: (item, text) => `read ${item.ref}: ${text}`,
          synthesize: (text, claims, unread) =>
            `answer ${text} from ${String(claims.length)} claims, ${String(unread.length)} unread`,
        },
      }),
      harness,
    );
    expect(harness.prompt('rs/scout/docs/leads')).toBe(`scout docs: ${question}`);
    expect(harness.prompt(`rs/read/${stepId(docsA)}/claims`)).toBe(`read ${docsA}: ${question}`);
    expect(harness.prompt('rs/synthesize')).toBe(`answer ${question} from 1 claims, 0 unread`);
  });

  it('validates its options before any effect', async () => {
    const harness = scripted({});
    const cases: [Partial<investigate.ResearchOptions>, string][] = [
      [{ angles: [] }, 'angles must not be empty.'],
      [{ reads: 0 }, 'reads must be a positive integer; got 0.'],
      [{ concurrency: -1 }, 'concurrency must be a positive integer; got -1.'],
      [{ question: '' }, 'research needs a nonblank question.'],
    ];
    for (const [index, [options, message]] of cases.entries()) {
      await expect(run(study(options), harness, `bad-${String(index)}`)).rejects.toThrow(message);
    }
    expect(harness.calls).toHaveLength(0);
  });
});

describe('teams and schemas', () => {
  it('declares the slots each pattern calls', () => {
    expect(Object.keys(investigate.FalsifyTeam.slots)).toEqual(['theorist', 'falsifier']);
    expect(Object.keys(investigate.ResearchTeam.slots)).toEqual(['scout', 'reader', 'synthesizer']);
  });

  it('sends only schemas Codex accepts', () => {
    for (const schema of [types.Hypotheses, types.Falsification, types.Leads, types.Claims]) {
      expect(checkCodexSchema(schema)).toEqual([]);
    }
  });
});
