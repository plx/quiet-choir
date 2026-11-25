// The std selection recipes run end to end against a scripted harness:
// examples/patterns/std-design-tournament.workflow.ts (a tournament over an input brief with the
// default entrants and rubric) and examples/patterns/std-triage.workflow.ts (classify input issues
// against the default or an input label set, then rank the most urgent). Calls that matter are
// scripted by step ID; the rest get schema-valid filler from synthesizeOutput. Each run proves
// replay after a tail failure without new calls.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorkflow, synthesizeOutput, type HarnessRequest } from '../src/index.js';
import { design } from '../src/std/lenses.js';
import type { Proposal } from '../src/std/types.js';
import designTournament from '../examples/patterns/std-design-tournament.workflow.js';
import triage from '../examples/patterns/std-triage.workflow.js';
import {
  ScriptedHarness,
  makeRoot,
  removeRoot,
  replayAfterTail,
  runOptions,
} from './std-harness.js';

let root: string;
beforeEach(async () => {
  root = await makeRoot('choir-std-examples-select-');
});
afterEach(async () => {
  await removeRoot(root);
});

/**
 * A harness that answers scripted step IDs from `replies` (an Error is thrown, a function is called
 * with the request) and fills any other structured call with synthesizeOutput.
 */
function harness(
  replies: Readonly<Record<string, unknown>>,
  fallback: (request: HarnessRequest) => unknown = () => undefined,
): ScriptedHarness {
  return new ScriptedHarness((request: HarnessRequest) => {
    const reply = replies[request.stepId] ?? fallback(request);
    if (reply instanceof Error) throw reply;
    if (reply !== undefined) return reply;
    if (request.outputSchema === null) throw new Error(`Unexpected text call ${request.stepId}`);
    return synthesizeOutput(request.outputSchema, request.stepId);
  });
}

describe('std-design-tournament', () => {
  /** The proposal entrant `key` writes. */
  const proposal = (key: string): Proposal => ({
    title: 'A plan',
    summary: 'A summary.',
    design: `Design by ${key}.`,
    tradeoffs: ['A tradeoff.'],
    risks: ['A risk.'],
  });
  /** A judge reply giving each letter its score on every criterion. */
  const scores = (table: Readonly<Record<string, number>>) => ({
    sheets: Object.entries(table).map(([entrant, score]) => ({
      entrant,
      scores: { fitness: score, simplicity: score, evolvability: score, operability: score },
      rationale: `${entrant} scored ${String(score)}.`,
      bestIdea: `${entrant}'s idea`,
    })),
  });
  const proposers = (request: HarnessRequest) => {
    const [, stage, key = ''] = request.stepId.split('/');
    return stage === 'propose' ? proposal(key) : undefined;
  };

  it('runs the default entrants and rubric to a synthesized design and replays', async () => {
    const calls = harness(
      {
        'tournament/judge/0/scores': scores({ A: 6, B: 9, C: 7, D: 5 }),
        'tournament/judge/1/scores': scores({ A: 6, B: 8, C: 7, D: 4 }),
        'tournament/judge/2/scores': scores({ A: 7, B: 4, C: 8, D: 5 }),
        'tournament/synthesize': '# Final design',
      },
      proposers,
    );
    const input = { brief: 'Design a cache for the build server.', judges: 3 };
    const result = await replayAfterTail(designTournament, input, calls, root);
    expect(result.output).toEqual({
      status: 'complete',
      winner: 'data-first',
      design: '# Final design',
      standings: [
        { entrant: 'data-first', score: 7.33 },
        { entrant: 'evolvability', score: 7 },
        { entrant: 'ship-simplest', score: 6.33 },
        { entrant: 'operability-first', score: 4.67 },
      ],
      dissent: [],
    });
    expect([...calls.ids()].sort()).toEqual(
      [
        ...design.map((lens) => `tournament/propose/${lens.key}/proposal`),
        'tournament/judge/0/scores',
        'tournament/judge/1/scores',
        'tournament/judge/2/scores',
        'tournament/synthesize',
      ].sort(),
    );
    const synthesis = calls.prompt('tournament/synthesize');
    expect(synthesis).toContain('Design a cache for the build server.');
    expect(synthesis).toContain('"design": "Design by data-first."');
  });

  it('reports dissent and a degraded run when an entrant fails, without retrying it', async () => {
    // The surviving proposals are schema-valid filler; only the failure and the scores matter.
    const calls = harness({
      'tournament/propose/ship-simplest/proposal': new Error('proposer crashed'),
      'tournament/judge/0/scores': scores({ A: 10, B: 6, C: 5 }),
      'tournament/judge/1/scores': scores({ A: 4, B: 6, C: 5 }),
      'tournament/synthesize': '# Final design',
    });
    const input = { brief: 'Design a cache.', judges: 2 };
    const result = await replayAfterTail(designTournament, input, calls, root);
    expect(result.output).toMatchObject({
      status: 'degraded',
      winner: 'evolvability',
      standings: [
        { entrant: 'evolvability', score: 7 },
        { entrant: 'data-first', score: 6 },
        { entrant: 'operability-first', score: 5 },
      ],
      dissent: ['Judge 1 scored the winner 4/10 against the panel mean 7: A scored 4.'],
    });
    expect(calls.count('tournament/propose/ship-simplest/proposal')).toBe(1);
  });

  it('aborts without judges when fewer than two proposals succeed', async () => {
    const failing = Object.fromEntries(
      design.slice(1).map((lens) => [`tournament/propose/${lens.key}/proposal`, new Error('no')]),
    );
    const calls = harness(failing, proposers);
    const result = await runWorkflow(designTournament, {
      ...runOptions(root),
      harness: calls,
      input: { brief: 'Design a cache.', judges: 3 },
    });
    expect(result.output).toEqual({
      status: 'aborted',
      winner: null,
      design: null,
      standings: [{ entrant: 'ship-simplest', score: null }],
      dissent: [],
    });
    expect(calls.ids().filter((id) => !id.includes('/propose/'))).toEqual([]);
  });
});

describe('std-triage', () => {
  const issue = (number: number, title: string) => ({ number, title, body: `${title}.` });
  const issues = [
    issue(11, 'Crash when saving'),
    issue(12, 'Add dark mode'),
    issue(13, 'Typo in README'),
    issue(14, 'Data loss on sync'),
    issue(15, 'Hello?'),
  ];
  /** The parsed triage input. */
  type TriageInput = Parameters<typeof triage.run>[1];
  /** Triage input without `labels`, so the workflow's default label set applies when it parses it. */
  const defaults = (input: Omit<TriageInput, 'labels'>): TriageInput => input as TriageInput;
  /** One tagged entry of a classify batch reply. */
  const tag = (key: string, ...labels: string[]) => ({ key, labels, reason: `Issue ${key}.` });

  it('classifies against the default labels, ranks the urgent ones and replays', async () => {
    const calls = harness({
      'classify/chunk/0/tag': {
        items: [tag('1', 'bug'), tag('2', 'feature'), tag('3', 'docs'), tag('4', 'bug'), tag('5')],
      },
      // The ranker answers with the assignments' own keys: the data loss, then the crash.
      'rank/rank': { selected: ['4', '1'], rationale: 'Data loss first, then the crash.' },
    });
    const result = await replayAfterTail(triage, defaults({ issues, top: 2 }), calls, root);
    expect(result.output).toEqual({
      status: 'complete',
      counts: [
        { label: 'bug', count: 2 },
        { label: 'feature', count: 1 },
        { label: 'docs', count: 1 },
        { label: 'question', count: 0 },
      ],
      urgent: [issues[3], issues[0]],
      unlabeled: [issues[4]],
    });
    expect(calls.ids()).toEqual(['classify/chunk/0/tag', 'rank/rank']);
    const classify = calls.prompt('classify/chunk/0/tag');
    expect(classify).toContain('### Taxonomy\n\n- bug\n- feature\n- docs\n- question');
    expect(classify).toContain('- 4: {"body":"Data loss on sync.","number":14');
    const rank = calls.prompt('rank/rank');
    expect(rank).toContain('Choose the 2 items below that rank highest on this criterion: How');
    expect(rank).toContain('"labels":["bug"]');
    expect(rank).not.toContain('Hello?');
  });

  it('uses an input label set, and needs no ranking call when few issues are labeled', async () => {
    const calls = harness({
      'classify/chunk/0/tag': {
        items: [tag('1', 'p0'), tag('2', 'p1'), tag('3', 'p1'), tag('4', 'p0'), tag('5', 'p1')],
      },
    });
    const result = await runWorkflow(triage, {
      ...runOptions(root),
      harness: calls,
      input: { issues, labels: ['p0', 'p1'], top: 5 },
    });
    expect(result.output).toMatchObject({
      status: 'complete',
      counts: [
        { label: 'p1', count: 3 },
        { label: 'p0', count: 2 },
      ],
      urgent: issues,
      unlabeled: [],
    });
    expect(calls.ids()).toEqual(['classify/chunk/0/tag']);
  });

  it('reports a failed batch as degraded and ranks what was labeled', async () => {
    const many = Array.from({ length: 12 }, (_unused, index) =>
      issue(100 + index, `Issue ${String(index)}`),
    );
    const calls = harness({
      'classify/chunk/0/tag': new Error('tagger down'),
      'classify/chunk/1/tag': { items: [tag('11', 'bug'), tag('12', 'bug')] },
      'rank/rank': { selected: ['12'], rationale: 'The second bug is worse.' },
    });
    const result = await replayAfterTail(triage, defaults({ issues: many, top: 1 }), calls, root);
    expect(result.output).toMatchObject({
      status: 'degraded',
      counts: [
        { label: 'bug', count: 2 },
        { label: 'feature', count: 0 },
        { label: 'docs', count: 0 },
        { label: 'question', count: 0 },
      ],
      urgent: [many[11]],
      unlabeled: [],
    });
    expect(calls.count('classify/chunk/0/tag')).toBe(1);
    expect(calls.prompt('rank/rank')).toContain('- 11: {"item":{"body":"Issue 10.","number":110');
  });
});
