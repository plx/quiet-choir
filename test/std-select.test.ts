// quiet-choir/std selection patterns (std.patterns.tournament, rank, route, classify) end to end
// against a scripted harness: exact step IDs, default prompts and their safe defaults, answers
// constrained to known keys, the tally and counts computed in code, failure tolerance (a failed
// call becomes data, is counted, and is not retried on resume), replay after a tail failure without
// new calls, option validation before any effect, and the Codex schema check of every schema sent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkCodexSchema,
  defineWorkflow,
  runWorkflow,
  z,
  type HarnessRequest,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowResult,
} from '../src/index.js';
import * as lenses from '../src/std/lenses.js';
import * as select from '../src/std/select.js';
import type { Proposal } from '../src/std/types.js';
import {
  ScriptedHarness,
  makeRoot,
  removeRoot,
  replayAfterTail,
  runOptions,
  tailFailure,
} from './std-harness.js';

let root: string;
beforeEach(async () => {
  root = await makeRoot('choir-std-select-');
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

/** Every structured request's output schema passes the Codex schema check. */
function expectCodexSafe(harness: ScriptedHarness): void {
  const schemas = harness.calls.flatMap((call) =>
    call.outputSchema === null ? [] : [call.outputSchema],
  );
  expect(schemas.length).toBeGreaterThan(0);
  for (const schema of schemas) expect(checkCodexSchema(schema)).toEqual([]);
}

/** The JSON schema node at `path` (property names) in a request's output schema. */
function schemaAt(request: HarnessRequest | undefined, ...path: string[]): Record<string, unknown> {
  let node = request?.outputSchema as Record<string, unknown> | null | undefined;
  for (const segment of path) {
    if (segment === '[]') node = node?.['items'] as Record<string, unknown> | undefined;
    else
      node = (node?.['properties'] as Record<string, Record<string, unknown>> | undefined)?.[
        segment
      ];
  }
  if (node === null || node === undefined) throw new Error(`No schema at ${path.join('.')}`);
  return node;
}

/** The last request to `stepId`. */
function requestOf(harness: ScriptedHarness, stepId: string): HarnessRequest | undefined {
  return harness.calls.findLast((call) => call.stepId === stepId);
}

/**
 * Run `first` to an injected tail failure, then resume with `second`; returns `'resumed'` or the
 * resume's error message.
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

/** Every request carries the `calls` defaults. */
function expectCalls(harness: ScriptedHarness, calls: Readonly<Record<string, unknown>>): void {
  expect(harness.calls.length).toBeGreaterThan(0);
  for (const call of harness.calls) expect(call.options).toMatchObject(calls);
}

/** The call defaults the `calls` tests pass. */
const callDefaults = { timeoutMs: 12_345, addDirs: ['extra'] } as const;

// ---------------------------------------------------------------------------------------------
// tournament
// ---------------------------------------------------------------------------------------------

/** Neutral proposal titles per design lens, so a judge prompt reveals no entrant key. */
const titles: Readonly<Record<string, string>> = {
  'ship-simplest': 'One process',
  evolvability: 'Plugin host',
  'data-first': 'Event log',
  'operability-first': 'Supervised workers',
};

/** The proposal the scripted proposer writes for entrant `key`. */
function proposal(key: string): Proposal {
  const title = titles[key] ?? key;
  return {
    title,
    summary: `${title} summary.`,
    design: `# ${title}\n\nThe design.`,
    tradeoffs: [`${title} tradeoff`],
    risks: [`${title} risk`],
  };
}

/** A score sheet for `letter` giving every design criterion `score`. */
function sheet(letter: string, score: number, rationale = `${letter} rationale`) {
  return {
    entrant: letter,
    scores: { fitness: score, simplicity: score, evolvability: score, operability: score },
    rationale,
    bestIdea: `${letter} idea`,
  };
}

/** Judge seat -> letter -> score; A = 7.33, C = 7, B = 5.67, D = 4.67, judge 2 dissents on A. */
const panel: readonly Readonly<Record<string, number>>[] = [
  { A: 9, B: 6, C: 6, D: 5 },
  { A: 9, B: 5, C: 7, D: 4 },
  { A: 4, B: 6, C: 8, D: 5 },
];

/**
 * A tournament harness: proposers write {@link proposal}, judge `n` scores the letters in
 * `scores[n]` (in letter order), the synthesizer writes `FINAL`, and step IDs in `fail` throw.
 */
function arena(
  options: {
    readonly fail?: readonly string[];
    readonly scores?: readonly Readonly<Record<string, number>>[];
  } = {},
): ScriptedHarness {
  const scores = options.scores ?? panel;
  return scripted((request) => {
    const { stepId } = request;
    if (options.fail?.includes(stepId) === true) return new Error(`${stepId} crashed`);
    const parts = stepId.split('/');
    if (parts[1] === 'propose') return proposal(parts[2] ?? '?');
    if (parts[1] === 'judge') {
      const table = scores[Number(parts[2])] ?? {};
      return {
        sheets: Object.entries(table).map(([letter, score]) =>
          sheet(letter, score, `judge ${parts[2] ?? '?'} on ${letter}`),
        ),
      };
    }
    if (stepId === 't/synthesize') return 'FINAL';
    return undefined;
  });
}

/** A tournament workflow with one bound agent in every slot and `options` over the defaults. */
function contest(options: Partial<select.TournamentOptions<string>> = {}) {
  return workflow('tournament', (ctx) => {
    const agent = ctx.claude.bind({});
    return select.tournament<string>(ctx, {
      id: 't',
      team: { proposer: agent, judge: agent, synthesizer: agent },
      brief: 'Design a job queue for the CLI.',
      ...options,
    });
  });
}

const designKeys = lenses.design.map((lens) => lens.key);

describe('tournament', () => {
  it('proposes, judges anonymously, tallies in code and synthesizes with exact step IDs', async () => {
    const harness = arena();
    const result = await replayAfterTail(contest(), null, harness, root);
    const entry = (letter: string, key: string) => ({
      letter,
      entrant: key,
      proposal: proposal(key),
    });
    const criteria = (value: number) => ({
      fitness: value,
      simplicity: value,
      evolvability: value,
      operability: value,
    });
    expect(result.output).toEqual({
      winner: entry('A', 'ship-simplest'),
      entries: [
        entry('A', 'ship-simplest'),
        entry('B', 'evolvability'),
        entry('C', 'data-first'),
        entry('D', 'operability-first'),
      ],
      standings: [
        {
          letter: 'A',
          entrant: 'ship-simplest',
          title: 'One process',
          score: 7.33,
          criteria: criteria(7.33),
          votes: 3,
          bestIdeas: ['A idea', 'A idea', 'A idea'],
        },
        {
          letter: 'C',
          entrant: 'data-first',
          title: 'Event log',
          score: 7,
          criteria: criteria(7),
          votes: 3,
          bestIdeas: ['C idea', 'C idea', 'C idea'],
        },
        {
          letter: 'B',
          entrant: 'evolvability',
          title: 'Plugin host',
          score: 5.67,
          criteria: criteria(5.67),
          votes: 3,
          bestIdeas: ['B idea', 'B idea', 'B idea'],
        },
        {
          letter: 'D',
          entrant: 'operability-first',
          title: 'Supervised workers',
          score: 4.67,
          criteria: criteria(4.67),
          votes: 3,
          bestIdeas: ['D idea', 'D idea', 'D idea'],
        },
      ],
      design: 'FINAL',
      dissent: ['Judge 2 scored the winner 4/10 against the panel mean 7.33: judge 2 on A'],
      failedEntrants: [],
      failedJudges: 0,
      status: 'complete',
    });
    expect([...harness.ids()].sort()).toEqual(
      [
        ...designKeys.map((key) => `t/propose/${key}/proposal`),
        't/judge/0/scores',
        't/judge/1/scores',
        't/judge/2/scores',
        't/synthesize',
      ].sort(),
    );
    expect(harness.ids().at(-1)).toBe('t/synthesize');
    expect(logs(result)).toEqual([
      [
        'Tournament standings: A (ship-simplest) 7.33, C (data-first) 7, B (evolvability) 5.67, D (operability-first) 4.67.',
        null,
      ],
    ]);
    expectCodexSafe(harness);
  });

  it('writes default prompts with the philosophy, anonymity, rotation and the safe default', async () => {
    const harness = arena();
    await run(contest(), harness);
    const propose = harness.prompt('t/propose/data-first/proposal');
    const charter = lenses.design.find((lens) => lens.key === 'data-first')?.charter ?? '';
    expect(propose).toContain(
      `Propose a design for the brief below, as one entrant of a design tournament. ${charter}`,
    );
    expect(propose).toContain('## Context\n\nDesign a job queue for the CLI.');

    for (const seat of [0, 1, 2]) {
      const judge = harness.prompt(`t/judge/${String(seat)}/scores`);
      // `evolvability` is also a rubric criterion, so only the other entrant keys are checked.
      for (const key of designKeys.filter((key) => key !== 'evolvability'))
        expect(judge).not.toContain(key);
      expect(judge).toContain('### Rubric\n\n- fitness: ');
      expect(judge).toContain(
        'When a proposal does not show how it meets a criterion, score that criterion low: giving no credit for what is not shown is the safe default.',
      );
      // Judge n sees the proposals starting at the n-th letter.
      const first = ['A', 'B', 'C'][seat] ?? '';
      const order = ['A', 'B', 'C', 'D'].map((letter) => judge.indexOf(`"letter": "${letter}"`));
      expect(Math.min(...order)).toBe(judge.indexOf(`"letter": "${first}"`));
    }
    const judgeRequest = requestOf(harness, 't/judge/0/scores');
    expect(schemaAt(judgeRequest, 'sheets', '[]', 'entrant')['enum']).toEqual(['A', 'B', 'C', 'D']);
    expect(schemaAt(judgeRequest, 'sheets')['minItems']).toBe(1);

    const synthesize = harness.prompt('t/synthesize');
    expect(synthesize).toContain('### Winning proposal\n\n```json\n{\n  "title": "One process"');
    expect(synthesize).toContain('"proposal": "Event log"');
    expect(synthesize).toContain(
      '### Dissent\n\n- Judge 2 scored the winner 4/10 against the panel mean 7.33: judge 2 on A',
    );
    expect(synthesize).toContain('Address each dissenting judgement');
  });

  it('tolerates a failed proposer and judge, reletters the rest and does not retry them', async () => {
    const harness = arena({
      fail: ['t/propose/evolvability/proposal', 't/judge/1/scores'],
      scores: [{ A: 5, B: 8, C: 6 }, {}, { A: 6, B: 8, C: 9 }],
    });
    const result = await replayAfterTail(contest(), null, harness, root);
    const output = result.output as unknown as select.TournamentResult<string>;
    expect(output.entries.map(({ letter, entrant }) => `${letter}=${entrant}`)).toEqual([
      'A=ship-simplest',
      'B=data-first',
      'C=operability-first',
    ]);
    expect(output.standings.map(({ letter, score, votes }) => [letter, score, votes])).toEqual([
      ['B', 8, 2],
      ['C', 7.5, 2],
      ['A', 5.5, 2],
    ]);
    expect(output.winner?.entrant).toBe('data-first');
    expect(output.failedEntrants).toEqual(['evolvability']);
    expect(output.failedJudges).toBe(1);
    expect(output.status).toBe('degraded');
    expect(harness.count('t/propose/evolvability/proposal')).toBe(1);
    expect(harness.count('t/judge/1/scores')).toBe(1);
    expect(harness.prompt('t/judge/0/scores')).not.toContain('Plugin host');
    expect(logs(result).map(([message]) => message)).toEqual([
      '1 of 4 proposals failed; the tournament continues without them.',
      '1 of 3 judges failed; the tally uses the others.',
      'Tournament standings: B (data-first) 8, C (operability-first) 7.5, A (ship-simplest) 5.5.',
    ]);
    expect(logs(result)[1]?.[1]).toEqual({
      failures: [
        { judge: 1, error: expect.stringContaining('t/judge/1/scores crashed') as unknown },
      ],
    });
  });

  it('aborts as data when too few proposals succeed, without judging', async () => {
    const harness = arena({
      fail: ['ship-simplest', 'evolvability', 'operability-first'].map(
        (key) => `t/propose/${key}/proposal`,
      ),
    });
    const result = await replayAfterTail(contest(), null, harness, root);
    expect(result.output).toEqual({
      winner: null,
      entries: [{ letter: 'A', entrant: 'data-first', proposal: proposal('data-first') }],
      standings: [
        {
          letter: 'A',
          entrant: 'data-first',
          title: 'Event log',
          score: null,
          criteria: null,
          votes: 0,
          bestIdeas: [],
        },
      ],
      design: null,
      dissent: [],
      failedEntrants: ['ship-simplest', 'evolvability', 'operability-first'],
      failedJudges: 0,
      status: 'aborted',
    });
    expect(harness.ids().every((id) => id.startsWith('t/propose/'))).toBe(true);
    expect(logs(result)[0]?.[0]).toBe(
      'Tournament aborted: 1 of 4 proposals succeeded, fewer than minEntrants (2).',
    );
  });

  it('aborts when every judge fails, without synthesizing', async () => {
    const harness = arena({ fail: ['t/judge/0/scores', 't/judge/1/scores'] });
    const result = await run(contest({ judges: 2 }), harness);
    const output = result.output as unknown as select.TournamentResult<string>;
    expect(output.status).toBe('aborted');
    expect(output.failedJudges).toBe(2);
    expect(output.winner).toBeNull();
    expect(output.design).toBeNull();
    expect(output.standings.every((standing) => standing.score === null)).toBe(true);
    expect(harness.count('t/synthesize')).toBe(0);
  });

  it("returns the winner's own design without synthesis and breaks ties by entrant order", async () => {
    const harness = arena({ scores: [{ A: 6, B: 7, C: 7, D: 2 }] });
    const result = await run(contest({ judges: 1, synthesize: false }), harness);
    const output = result.output as unknown as select.TournamentResult<string>;
    expect(output.winner?.letter).toBe('B');
    expect(output.design).toBe(proposal('evolvability').design);
    expect(output.dissent).toEqual([]);
    expect(harness.count('t/synthesize')).toBe(0);
  });

  it('ignores a repeated sheet, counts an omitted letter as a missing vote and logs both', async () => {
    const harness = scripted((request) => {
      const { stepId } = request;
      if (stepId.startsWith('t/propose/')) return proposal(stepId.split('/')[2] ?? '?');
      if (stepId === 't/judge/0/scores') return { sheets: [sheet('A', 9), sheet('A', 1)] };
      if (stepId === 't/judge/1/scores') return { sheets: [sheet('A', 5), sheet('B', 6)] };
      return stepId === 't/synthesize' ? 'FINAL' : undefined;
    });
    const result = await run(
      contest({ entrants: lenses.design.slice(0, 2), judges: 2, dissentGap: 2 }),
      harness,
    );
    const output = result.output as unknown as select.TournamentResult<string>;
    expect(output.standings.map(({ letter, score, votes }) => [letter, score, votes])).toEqual([
      ['A', 7, 2],
      ['B', 6, 1],
    ]);
    expect(output.dissent).toEqual([
      'Judge 1 scored the winner 5/10 against the panel mean 7: A rationale',
    ]);
    expect(logs(result)[0]).toEqual([
      'Judge 0 scored some proposals twice or not at all; repeats are ignored and omissions count as missing votes.',
      { repeated: ['A'], omitted: ['B'] },
    ]);
  });

  it('builds the judge schema from a custom rubric and custom entrants', async () => {
    const entrants = [
      lenses.lens('fast', 'You favor speed.'),
      lenses.lens('cheap', 'You favor low cost.'),
    ];
    const harness = scripted((request) => {
      const { stepId } = request;
      if (stepId.startsWith('t/propose/')) return proposal(stepId.split('/')[2] ?? '?');
      if (stepId === 't/judge/0/scores') {
        const scores = (speed: number, cost: number) => ({ speed, cost });
        return {
          sheets: [
            { entrant: 'A', scores: scores(9, 3), rationale: 'fast', bestIdea: 'cache' },
            { entrant: 'B', scores: scores(4, 9), rationale: 'cheap', bestIdea: 'batch' },
          ],
        };
      }
      return stepId === 't/synthesize' ? 'FINAL' : undefined;
    });
    const result = await run(
      contest({
        entrants,
        judges: 1,
        rubric: { speed: 'How fast it is.', cost: 'How cheap it is.' },
      }),
      harness,
    );
    const output = result.output as unknown as select.TournamentResult<'speed' | 'cost'>;
    expect(output.standings.map((standing) => standing.criteria)).toEqual([
      { speed: 4, cost: 9 },
      { speed: 9, cost: 3 },
    ]);
    expect(output.winner?.entrant).toBe('cheap');
    const request = requestOf(harness, 't/judge/0/scores');
    expect(
      Object.keys(schemaAt(request, 'sheets', '[]', 'scores')['properties'] ?? {}).sort(),
    ).toEqual(['cost', 'speed']);
    expect(harness.prompt('t/judge/0/scores')).toContain(
      '### Rubric\n\n- speed: How fast it is.\n- cost: How cheap it is.',
    );
    expectCodexSafe(harness);
  });

  it('uses replacement prompts', async () => {
    const harness = arena({ scores: [{ A: 9, B: 1 }] });
    await run(
      contest({
        entrants: lenses.design.slice(0, 2),
        judges: 1,
        prompts: {
          propose: (entrant, brief) => `propose ${entrant.key}: ${brief}`,
          judge: (_brief, entries, _rubric, seat, seats) =>
            `judge ${String(seat)}/${String(seats)}: ${entries.map((e) => e.letter).join('')}`,
          synthesize: (_brief, winner, standings, dissent) =>
            `synthesize ${winner.letter} of ${String(standings.length)}, ${String(dissent.length)}`,
        },
      }),
      harness,
    );
    expect(harness.prompt('t/propose/evolvability/proposal')).toBe(
      'propose evolvability: Design a job queue for the CLI.',
    );
    expect(harness.prompt('t/judge/0/scores')).toBe('judge 0/1: AB');
    expect(harness.prompt('t/synthesize')).toBe('synthesize A of 2, 0');
  });

  it('hands custom prompts proposals in schema order, so replay renders the same text', async () => {
    const harness = arena({ scores: [{ A: 9, B: 1 }] });
    const definition = contest({
      entrants: lenses.design.slice(0, 2),
      judges: 1,
      prompts: { judge: (_brief, entries) => JSON.stringify(entries.map((e) => e.proposal)) },
    });
    await replayAfterTail(definition, null, harness, root);
    expect(harness.prompt('t/judge/0/scores')).toMatch(
      /^\[\{"title":"One process","summary":"One process summary\.","design":/u,
    );
  });

  it('tells proposers not to name their philosophy', async () => {
    const harness = arena({ scores: [{ A: 9, B: 1 }] });
    await run(contest({ entrants: lenses.design.slice(0, 2), judges: 1 }), harness);
    expect(harness.prompt('t/propose/ship-simplest/proposal')).toContain(
      'do not name your philosophy or refer to the other entrants.',
    );
  });

  it('passes the call defaults to every proposer, judge and synthesizer call', async () => {
    const harness = arena({ scores: [{ A: 9, B: 1 }] });
    await run(
      contest({ entrants: lenses.design.slice(0, 2), judges: 1, calls: callDefaults }),
      harness,
    );
    expect(harness.ids()).toContain('t/synthesize');
    expectCalls(harness, callDefaults);
  });

  it('refuses to replay judges after a rubric or version change the prompts do not show', async () => {
    const harness = scripted((request) => {
      const { stepId } = request;
      if (stepId.startsWith('t/propose/')) return proposal(stepId.split('/')[2] ?? '?');
      if (stepId === 't/judge/0/scores') {
        return {
          sheets: ['A', 'B'].map((entrant) => ({
            entrant,
            scores: { speed: 5, cost: 5 },
            rationale: 'r',
            bestIdea: 'i',
          })),
        };
      }
      return stepId === 't/synthesize' ? 'FINAL' : undefined;
    });
    // A custom judge prompt that shows neither the rubric nor the letters.
    const judged = (rubric: Readonly<Record<string, string>>, version?: string) =>
      contest({
        entrants: lenses.design.slice(0, 2),
        judges: 1,
        rubric,
        version,
        prompts: { judge: () => 'Score the proposals.' },
      });
    const before = { speed: 'How fast it is.', cost: 'How cheap it is.' };
    const after = { speed: 'How fast it is under load.', cost: 'How cheap it is.' };
    expect(await resumeChanged(judged(before), judged(after), harness)).toBe(
      'Settled map t/judge changed after an item completed (changed: items); --accept-code-change accepts only a mapper change. Fork a new run.',
    );
    expect(await resumeChanged(judged(before), judged(before, 'v2'), harness, 'version')).toMatch(
      /^Settled map t\/propose changed after an item completed \(changed: version\)/u,
    );
    expect(harness.count('t/judge/0/scores')).toBe(2);
  });

  it('validates options before any effect', async () => {
    const cases: [Partial<select.TournamentOptions<string>>, string][] = [
      [{ brief: '  ' }, 'brief must be a nonblank string.'],
      [{ entrants: [] }, 'entrants must not be empty.'],
      [
        {
          entrants: Array.from({ length: 27 }, (_unused, index) =>
            lenses.lens(`e${String(index)}`, 'Charter.'),
          ),
        },
        'entrants must hold at most 26 lenses; got 27.',
      ],
      [{ judges: 0 }, 'judges must be a positive integer; got 0.'],
      [{ minEntrants: 5 }, 'minEntrants (5) exceeds the number of entrants (4).'],
      [{ dissentGap: 0 }, 'dissentGap must be a positive number; got 0.'],
      [{ rubric: {} }, 'rubric needs at least one criterion'],
      [
        { rubric: { speed: ' ' } },
        'rubric must map nonblank keys to nonblank descriptions; check "speed".',
      ],
      [{ team: {} as select.TournamentTeam }, 'Team slot proposer is not filled.'],
      [{ concurrency: 0 }, 'concurrency must be a positive integer; got 0.'],
    ];
    const harness = arena();
    for (const [index, [options, message]] of cases.entries()) {
      await expect(run(contest(options), harness, `bad-${String(index)}`)).rejects.toThrow(message);
    }
    expect(harness.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// rank
// ---------------------------------------------------------------------------------------------

describe('rank', () => {
  const items = ['crash on start', 'typo in docs', 'data loss on save', 'slow search', 'old link'];
  const ranking = (options: Partial<select.RankOptions<string>> = {}) =>
    workflow('rank', (ctx) =>
      select.rank(ctx, {
        id: 'r',
        team: { ranker: ctx.claude.bind({}) },
        items,
        pick: 2,
        criterion: 'How urgently it needs a fix.',
        ...options,
      }),
    );

  it('selects the chosen keys best first, defers the rest in order and logs the cap', async () => {
    const harness = scripted((request) =>
      request.stepId === 'r/rank'
        ? { selected: ['3', '1'], rationale: 'Data loss and crashes first.' }
        : undefined,
    );
    const result = await replayAfterTail(ranking(), null, harness, root);
    expect(result.output).toEqual({
      selected: ['data loss on save', 'crash on start'],
      deferred: ['typo in docs', 'slow search', 'old link'],
      rationale: 'Data loss and crashes first.',
      status: 'ranked',
    });
    expect(harness.ids()).toEqual(['r/rank']);
    expect(logs(result)).toEqual([
      [
        'Ranked 5 items: selected 2, deferred 3.',
        { selected: ['3', '1'], deferred: ['2', '4', '5'] },
      ],
    ]);
    const prompt = harness.prompt('r/rank');
    expect(prompt).toContain(
      'Choose the 2 items below that rank highest on this criterion: How urgently it needs a fix.',
    );
    expect(prompt).toContain('## Context\n\n- 1: crash on start\n- 2: typo in docs');
    expect(prompt).toContain(
      'prefer the one whose neglect would cost more: that is the safe default.',
    );
    const request = requestOf(harness, 'r/rank');
    expect(schemaAt(request, 'selected', '[]')['enum']).toEqual(['1', '2', '3', '4', '5']);
    expect(schemaAt(request, 'selected')['maxItems']).toBe(2);
    expectCodexSafe(harness);
  });

  it('passes the call defaults to the ranker call', async () => {
    const harness = scripted(() => ({ selected: ['1'], rationale: 'r' }));
    await run(ranking({ calls: callDefaults }), harness);
    expectCalls(harness, callDefaults);
  });

  it('counts a repeated key in the reply once', async () => {
    const harness = scripted(() => ({ selected: ['5', '5'], rationale: 'Links rot.' }));
    const result = await run(ranking(), harness);
    expect(result.output).toMatchObject({
      selected: ['old link'],
      deferred: items.slice(0, 4),
      status: 'ranked',
    });
  });

  it('answers with caller keys and descriptions', async () => {
    const issues = [
      { number: 7, title: 'crash' },
      { number: 9, title: 'typo' },
      { number: 12, title: 'leak' },
    ];
    const harness = scripted(() => ({ selected: ['#12'], rationale: 'Leaks grow.' }));
    const result = await run(
      workflow('rank-keys', (ctx) =>
        select.rank(ctx, {
          id: 'r',
          team: { ranker: ctx.claude.bind({}) },
          items: issues,
          key: (issue) => `#${String(issue.number)}`,
          describe: (issue) => issue.title,
          pick: 1,
          criterion: 'Severity.',
        }),
      ),
      harness,
    );
    expect(result.output).toMatchObject({
      selected: [issues[2]],
      deferred: [issues[0], issues[1]],
    });
    expect(harness.prompt('r/rank')).toContain('- #7: crash\n- #9: typo\n- #12: leak');
  });

  it("defaults to the items' own key members, as classify assignments carry", async () => {
    const harness = scripted(() => ({ selected: ['7'], rationale: 'r' }));
    const result = await run(
      workflow('rank-own-keys', (ctx) =>
        select.rank(ctx, {
          id: 'r',
          team: { ranker: ctx.claude.bind({}) },
          items: [
            { key: '3', title: 'a' },
            { key: '7', title: 'b' },
          ],
          pick: 1,
          criterion: 'Anything.',
        }),
      ),
      harness,
    );
    expect(result.output).toMatchObject({ selected: [{ key: '7', title: 'b' }] });
    expect(harness.prompt('r/rank')).toContain('- 3: {"key":"3","title":"a"}\n- 7:');
  });

  it('describes non-string items as canonical JSON by default', async () => {
    const harness = scripted(() => ({ selected: ['2'], rationale: 'b' }));
    await run(
      workflow('rank-json', (ctx) =>
        select.rank(ctx, {
          id: 'r',
          team: { ranker: ctx.claude.bind({}) },
          items: [{ z: 0, a: 1 }, { b: [2] }],
          pick: 1,
          criterion: 'Anything.',
        }),
      ),
      harness,
    );
    expect(harness.prompt('r/rank')).toContain('- 1: {"a":1,"z":0}\n- 2: {"b":[2]}');
  });

  it('selects every item without a call when they fit within pick', async () => {
    const harness = scripted(() => undefined);
    const result = await run(ranking({ items: items.slice(0, 2) }), harness);
    expect(result.output).toEqual({
      selected: items.slice(0, 2),
      deferred: [],
      rationale: 'All 2 items fit within pick 2; nothing was ranked.',
      status: 'all-selected',
    });
    expect(harness.calls).toEqual([]);
  });

  it('throws a failed ranker call so a resume retries it', async () => {
    let fail = true;
    const harness = scripted(() =>
      fail ? new Error('ranker down') : { selected: ['1'], rationale: 'r' },
    );
    const options = { ...runOptions(root, 'retry'), harness };
    await expect(runWorkflow(ranking(), { ...options, input: null })).rejects.toThrow(
      'ranker down',
    );
    fail = false;
    const resumed = await runWorkflow(ranking(), { ...options, resume: true });
    expect(resumed.output).toMatchObject({ selected: ['crash on start'], status: 'ranked' });
    expect(harness.count('r/rank')).toBe(2);
  });

  it('validates options before any effect', async () => {
    const harness = scripted(() => undefined);
    const cases: [Partial<select.RankOptions<string>>, string][] = [
      [{ pick: 0 }, 'pick must be a positive integer; got 0.'],
      [{ criterion: ' ' }, 'criterion must be a nonblank string.'],
      [{ key: () => 'same' }, 'Duplicate item key: "same".'],
      [{ key: () => '' }, 'Item keys must be nonblank strings; got "".'],
      [{ team: {} as select.RankTeam }, 'Team slot ranker is not filled.'],
    ];
    for (const [index, [options, message]] of cases.entries()) {
      await expect(run(ranking(options), harness, `bad-${String(index)}`)).rejects.toThrow(message);
    }
    expect(harness.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------------------------

describe('route', () => {
  const routes = {
    fix: 'A defect with a known cause and a small fix.',
    docs: 'Only documentation needs to change.',
    escalate: 'Anything unclear, risky or large.',
  } as const;
  const routing = (options: Partial<select.RouteOptions<'fix' | 'docs' | 'escalate'>> = {}) =>
    workflow('route', (ctx) =>
      select.route(ctx, {
        id: 'triage',
        team: { router: ctx.claude.bind({}) },
        subject: 'The README links to a removed page.',
        routes,
        fallback: 'escalate',
        ...options,
      }),
    );

  it('routes to the chosen key with exact step IDs and names the safe default', async () => {
    const harness = scripted(() => ({ route: 'docs', reason: 'Only the README changes.' }));
    const result = await replayAfterTail(routing(), null, harness, root);
    expect(result.output).toEqual({
      route: 'docs',
      reason: 'Only the README changes.',
      fallback: false,
      status: 'routed',
    });
    expect(harness.ids()).toEqual(['triage/route']);
    const prompt = harness.prompt('triage/route');
    expect(prompt).toContain('### Subject\n\nThe README links to a removed page.');
    expect(prompt).toContain('### Routes\n\n- fix: A defect');
    expect(prompt).toContain(
      'When no route clearly fits or the subject is ambiguous, choose escalate: it is the safe default.',
    );
    expect(schemaAt(requestOf(harness, 'triage/route'), 'route')['enum']).toEqual([
      'fix',
      'docs',
      'escalate',
    ]);
    expectCodexSafe(harness);
  });

  it('takes the fallback when the router fails and does not retry it on resume', async () => {
    const harness = scripted(() => new Error('router down'));
    const result = await replayAfterTail(routing(), null, harness, root);
    expect(result.output).toMatchObject({ route: 'escalate', fallback: true, status: 'fallback' });
    expect((result.output as { reason: string }).reason).toContain('router down');
    expect(harness.count('triage/route')).toBe(1);
    expect(logs(result)[0]?.[0]).toBe('Router failed; taking the fallback route escalate.');
  });

  it('throws without a fallback, and a resume retries the router', async () => {
    let fail = true;
    const harness = scripted(() =>
      fail ? new Error('router down') : { route: 'fix', reason: 'Small fix.' },
    );
    const definition = routing({ fallback: undefined });
    const options = { ...runOptions(root, 'retry'), harness };
    await expect(runWorkflow(definition, { ...options, input: null })).rejects.toThrow(
      'router down',
    );
    fail = false;
    const resumed = await runWorkflow(definition, { ...options, resume: true });
    expect(resumed.output).toEqual({
      route: 'fix',
      reason: 'Small fix.',
      fallback: false,
      status: 'routed',
    });
    expect(harness.count('triage/route')).toBe(2);
    expect(harness.prompt('triage/route')).toContain(
      'When several routes could fit, choose the one that fits best and say why.',
    );
  });

  it('passes the call defaults to the router call', async () => {
    const harness = scripted(() => ({ route: 'fix', reason: 'r' }));
    await run(routing({ calls: callDefaults }), harness);
    expectCalls(harness, callDefaults);
  });

  it('uses a replacement prompt', async () => {
    const harness = scripted(() => ({ route: 'fix', reason: 'r' }));
    await run(
      routing({
        prompts: {
          route: (subject, table, fallback) =>
            `${subject} | ${Object.keys(table).join(',')} | ${fallback ?? 'none'}`,
        },
      }),
      harness,
    );
    expect(harness.prompt('triage/route')).toBe(
      'The README links to a removed page. | fix,docs,escalate | escalate',
    );
  });

  it('validates options before any effect', async () => {
    const harness = scripted(() => undefined);
    await expect(run(routing({ subject: '' }), harness, 'b0')).rejects.toThrow(
      'subject must be a nonblank string.',
    );
    await expect(run(routing({ fallback: 'other' as 'fix' }), harness, 'b1')).rejects.toThrow(
      'fallback "other" is not one of the routes: "fix", "docs", "escalate".',
    );
    await expect(
      run(
        workflow('route-empty', (ctx) =>
          select.route(ctx, {
            id: 'triage',
            team: { router: ctx.claude.bind({}) },
            subject: 'x',
            routes: {},
          }),
        ),
        harness,
        'b2',
      ),
    ).rejects.toThrow('routes must not be empty.');
    await expect(run(routing({ routes: { ...routes, docs: ' ' } }), harness, 'b3')).rejects.toThrow(
      'routes must map nonblank keys to nonblank descriptions; check "docs".',
    );
    await expect(run(routing({ team: {} as select.RouteTeam }), harness, 'b4')).rejects.toThrow(
      'Team slot router is not filled.',
    );
    expect(harness.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------------------------

describe('classify', () => {
  const labels = {
    bug: 'Something is broken.',
    feature: 'A request for new behavior.',
    docs: 'Documentation is missing or wrong.',
  } as const;
  const items = ['crash on save', 'add dark mode', 'typo in README', 'hello?', 'slow start'];
  const tagging = (
    options: Partial<select.ClassifyOptions<string, 'bug' | 'feature' | 'docs'>> = {},
  ) =>
    workflow('classify', (ctx) =>
      select.classify(ctx, {
        id: 'c',
        team: { tagger: ctx.claude.bind({}) },
        items,
        labels,
        chunk: 2,
        ...options,
      }),
    );
  /** One tagged entry of a batch reply. */
  const tag = (key: string, ...chosen: string[]) => ({
    key,
    labels: chosen,
    reason: `${key} reason`,
  });

  it('labels batches, counts in code and reports unlabeled and failed items', async () => {
    const harness = scripted((request) => {
      switch (request.stepId) {
        case 'c/chunk/0/tag':
          return { items: [tag('1', 'bug'), tag('2', 'feature')] };
        case 'c/chunk/1/tag':
          // Item 4 gets no label; item 3 is answered twice (the repeat is ignored).
          return { items: [tag('3', 'docs'), tag('3', 'bug'), tag('4')] };
        case 'c/chunk/2/tag':
          return new Error('tagger down');
        default:
          return undefined;
      }
    });
    const result = await replayAfterTail(tagging(), null, harness, root);
    expect(result.output).toEqual({
      assignments: [
        { key: '1', item: 'crash on save', labels: ['bug'], reason: '1 reason' },
        { key: '2', item: 'add dark mode', labels: ['feature'], reason: '2 reason' },
        { key: '3', item: 'typo in README', labels: ['docs'], reason: '3 reason' },
      ],
      counts: [
        { label: 'bug', count: 1 },
        { label: 'feature', count: 1 },
        { label: 'docs', count: 1 },
      ],
      unlabeled: ['hello?'],
      failed: ['slow start'],
      failedChunks: 1,
      status: 'degraded',
    });
    expect([...harness.ids()].sort()).toEqual(['c/chunk/0/tag', 'c/chunk/1/tag', 'c/chunk/2/tag']);
    expect(harness.count('c/chunk/2/tag')).toBe(1);
    expect(logs(result)).toEqual([
      [
        'Batch 1 answered some items twice or not at all; repeats are ignored and omitted items count as unlabeled.',
        { repeated: ['3'], omitted: [] },
      ],
      [
        'Batch 2 failed (unknown); its 1 items are reported as failed.',
        { keys: ['5'], error: expect.stringContaining('tagger down') as unknown },
      ],
    ]);
    const prompt = harness.prompt('c/chunk/1/tag');
    expect(prompt).toContain(
      'Label each item below with the one label from the taxonomy that fits it best.',
    );
    expect(prompt).toContain(
      '### Taxonomy\n\n- bug: Something is broken.\n- feature: A request for new behavior.',
    );
    expect(prompt).toContain('### Items\n\n- 3: typo in README\n- 4: hello?');
    expect(prompt).toContain(
      'When no label clearly fits an item, give it no label: an empty list is the safe default, better than a wrong label.',
    );
    const request = requestOf(harness, 'c/chunk/1/tag');
    expect(schemaAt(request, 'items', '[]', 'key')['enum']).toEqual(['3', '4']);
    expect(schemaAt(request, 'items', '[]', 'labels')['maxItems']).toBe(1);
    expect(schemaAt(request, 'items', '[]', 'labels', '[]')['enum']).toEqual([
      'bug',
      'feature',
      'docs',
    ]);
    expectCodexSafe(harness);
  });

  it('takes several labels in multi mode, in taxonomy order, and counts omitted items', async () => {
    const harness = scripted((request) =>
      request.stepId === 'c/chunk/0/tag'
        ? { items: [tag('#2', 'docs', 'bug', 'docs')] }
        : undefined,
    );
    const result = await run(
      tagging({
        items: ['a', 'b'],
        multi: true,
        chunk: 10,
        key: (item) => `#${String(item.charCodeAt(0) - 96)}`,
      }),
      harness,
    );
    expect(result.output).toEqual({
      assignments: [{ key: '#2', item: 'b', labels: ['bug', 'docs'], reason: '#2 reason' }],
      counts: [
        { label: 'bug', count: 1 },
        { label: 'docs', count: 1 },
        { label: 'feature', count: 0 },
      ],
      unlabeled: ['a'],
      failed: [],
      failedChunks: 0,
      status: 'complete',
    });
    expect(harness.ids()).toEqual(['c/chunk/0/tag']);
    expect(harness.prompt('c/chunk/0/tag')).toContain(
      'Label each item below with every label from the taxonomy that applies to it.',
    );
    expect(schemaAt(requestOf(harness, 'c/chunk/0/tag'), 'items', '[]', 'labels')['maxItems']).toBe(
      3,
    );
    expect(logs(result)).toEqual([
      [
        'Batch 0 answered some items twice or not at all; repeats are ignored and omitted items count as unlabeled.',
        { repeated: [], omitted: ['#1'] },
      ],
    ]);
    expectCodexSafe(harness);
  });

  it('passes the call defaults to every tagger call', async () => {
    const harness = scripted(() => ({ items: [] }));
    await run(tagging({ calls: callDefaults }), harness);
    expect(harness.calls).toHaveLength(3);
    expectCalls(harness, callDefaults);
  });

  it('refuses to replay batches after a mode, taxonomy or version change the prompt does not show', async () => {
    const harness = scripted(() => ({ items: [tag('1', 'bug')] }));
    // A custom prompt that shows neither the mode nor the labels.
    const blind = (options: Partial<select.ClassifyOptions<string, 'bug' | 'feature' | 'docs'>>) =>
      tagging({
        items: ['a'],
        prompts: { tag: (entries) => entries.map((entry) => entry.text).join(',') },
        ...options,
      });
    const changed =
      'Settled map c/chunk changed after an item completed (changed: items); --accept-code-change accepts only a mapper change. Fork a new run.';
    expect(await resumeChanged(blind({}), blind({ multi: true }), harness, 'multi')).toBe(changed);
    expect(
      await resumeChanged(blind({}), blind({ labels: { ...labels, docs: 'Docs.' } }), harness, 'l'),
    ).toBe('resumed');
    expect(
      await resumeChanged(blind({}), blind({ labels: ['bug', 'docs', 'feature'] }), harness, 'o'),
    ).toBe(changed);
    expect(await resumeChanged(blind({}), blind({ version: '2' }), harness, 'v')).toMatch(
      /^Settled map c\/chunk changed after an item completed \(changed: version\)/u,
    );
  });

  it('accepts a plain list of label names', async () => {
    const harness = scripted(() => ({ items: [tag('1', 'docs'), tag('2', 'bug')] }));
    const result = await run(
      workflow('classify-list', (ctx) =>
        select.classify(ctx, {
          id: 'c',
          team: { tagger: ctx.claude.bind({}) },
          items: ['typo', 'crash'],
          labels: ['bug', 'docs'],
        }),
      ),
      harness,
    );
    expect(result.output).toMatchObject({
      assignments: [
        { key: '1', item: 'typo', labels: ['docs'] },
        { key: '2', item: 'crash', labels: ['bug'] },
      ],
      counts: [
        { label: 'bug', count: 1 },
        { label: 'docs', count: 1 },
      ],
      status: 'complete',
    });
    const prompt = harness.prompt('c/chunk/0/tag');
    expect(prompt).toContain('### Taxonomy\n\n- bug\n- docs\n\n### Items\n\n- 1: typo\n- 2: crash');
    expect(prompt).toContain('Use only the labels in the taxonomy, in their plain meaning.');
    expectCodexSafe(harness);
  });

  it('makes no call for no items', async () => {
    const harness = scripted(() => undefined);
    const result = await run(tagging({ items: [] }), harness);
    expect(result.output).toMatchObject({ assignments: [], failed: [], status: 'complete' });
    expect(harness.calls).toEqual([]);
  });

  it('uses a replacement prompt per batch', async () => {
    const harness = scripted(() => ({ items: [] }));
    await run(
      tagging({
        items: ['a', 'b', 'c'],
        prompts: {
          tag: (entries, table, multi) =>
            `${entries.map((entry) => `${entry.key}=${entry.text}`).join(',')} ${Object.keys(table).join('/')} ${String(multi)}`,
        },
      }),
      harness,
    );
    expect(harness.prompt('c/chunk/0/tag')).toBe('1=a,2=b bug/feature/docs false');
    expect(harness.prompt('c/chunk/1/tag')).toBe('3=c bug/feature/docs false');
  });

  it('validates options before any effect', async () => {
    const harness = scripted(() => undefined);
    const cases: [Partial<select.ClassifyOptions<string, 'bug' | 'feature' | 'docs'>>, string][] = [
      [{ chunk: 0 }, 'chunk must be a positive integer; got 0.'],
      [{ key: () => 'k' }, 'Duplicate item key: "k".'],
      [{ concurrency: 1.5 }, 'concurrency must be a positive integer; got 1.5.'],
      [
        { labels: { ...labels, docs: '' } },
        'labels must map nonblank keys to nonblank descriptions; check "docs".',
      ],
    ];
    for (const [index, [options, message]] of cases.entries()) {
      await expect(run(tagging(options), harness, `bad-${String(index)}`)).rejects.toThrow(message);
    }
    await expect(
      run(
        workflow('classify-empty', (ctx) =>
          select.classify(ctx, {
            id: 'c',
            team: { tagger: ctx.claude.bind({}) },
            items,
            labels: {},
          }),
        ),
        harness,
        'empty',
      ),
    ).rejects.toThrow('labels must not be empty.');
    await expect(
      run(tagging({ labels: ['bug', 'docs', 'bug'] as never }), harness, 'dup'),
    ).rejects.toThrow('Duplicate label: "bug".');
    await expect(run(tagging({ labels: ['bug', ' '] as never }), harness, 'blank')).rejects.toThrow(
      'labels must be nonblank strings; got " ".',
    );
    await expect(
      run(tagging({ team: {} as select.ClassifyTeam }), harness, 'team'),
    ).rejects.toThrow('Team slot tagger is not filled.');
    expect(harness.calls).toEqual([]);
  });
});
