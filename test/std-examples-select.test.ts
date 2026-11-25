// The std selection recipes run end to end against a scripted harness:
// examples/patterns/std-design-tournament.workflow.ts (a tournament over an input brief with the
// default entrants and rubric, returning the TournamentResult),
// examples/patterns/std-triage.workflow.ts (classify input issues against the default or an input
// label set, then rank the most urgent) and examples/patterns/std-route.workflow.ts (route a
// request to one of four branches, each one short call, with a fallback branch). Calls that matter
// are scripted by step ID; the rest get schema-valid filler from synthesizeOutput. Each run proves
// replay after a tail failure without new calls.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorkflow, synthesizeOutput, z, type HarnessRequest } from '../src/index.js';
import * as std from '../src/std/index.js';
import { design } from '../src/std/lenses.js';
import type { Proposal } from '../src/std/types.js';
import { capabilityManifest } from '../src/workflow/runtime/profiles.js';
import designTournament from '../examples/patterns/std-design-tournament.workflow.js';
import routeRecipe from '../examples/patterns/std-route.workflow.js';
import triage from '../examples/patterns/std-triage.workflow.js';
import {
  ScriptedHarness,
  makeRoot,
  removeRoot,
  replayAfterTail,
  roundTrip,
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

it('needs no grant: every selection recipe calls only read-only roles', () => {
  const required = (workflow: object) =>
    capabilityManifest(workflow, { requireGrants: true }).requiredGrants;
  expect(required(designTournament)).toEqual([]);
  expect(required(triage)).toEqual([]);
  expect(required(routeRecipe)).toEqual([]);
});

/** The entrant and score of each standing, best first. */
function standings(
  result: { readonly standings: readonly std.patterns.Standing[] } | null | undefined,
) {
  return result?.standings.map(({ entrant, score }) => ({ entrant, score }));
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
    expect(result.output).toMatchObject({
      outcome: 'decided',
      winner: { letter: 'C', entrant: 'data-first', proposal: proposal('data-first') },
      design: '# Final design',
      dissent: [],
      failedEntrants: [],
      failedJudges: 0,
      failures: 0,
      status: 'complete',
    });
    expect(standings(result.output)).toEqual([
      { entrant: 'data-first', score: 7.33 },
      { entrant: 'evolvability', score: 7 },
      { entrant: 'ship-simplest', score: 6.33 },
      { entrant: 'operability-first', score: 4.67 },
    ]);
    expect(result.output?.entries.map((entry) => entry.entrant)).toEqual(
      design.map((lens) => lens.key),
    );
    roundTrip(std.patterns.TournamentResult, result.output);
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
    // Planners propose and synthesize; Judges score.
    const model = (id: string) =>
      (calls.calls.find((call) => call.stepId === id)?.options as { model?: string }).model;
    expect(model('tournament/propose/data-first/proposal')).toBe(std.roles.Planner.model);
    expect(model('tournament/judge/0/scores')).toBe(std.roles.Judge.model);
    expect(model('tournament/synthesize')).toBe(std.roles.Planner.model);
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
      outcome: 'decided',
      winner: { entrant: 'evolvability' },
      dissent: ['Judge 1 scored the winner 4/10 against the panel mean 7: A scored 4.'],
      failedEntrants: ['ship-simplest'],
      failures: 1,
      status: 'degraded',
    });
    expect(standings(result.output)).toEqual([
      { entrant: 'evolvability', score: 7 },
      { entrant: 'data-first', score: 6 },
      { entrant: 'operability-first', score: 5 },
    ]);
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
    expect(result.output).toMatchObject({
      outcome: 'aborted',
      winner: null,
      design: null,
      dissent: [],
      failedEntrants: design.slice(1).map((lens) => lens.key),
      failures: 3,
      status: 'degraded',
    });
    expect(standings(result.output)).toEqual([{ entrant: 'ship-simplest', score: null }]);
    expect(calls.ids().filter((id) => !id.includes('/propose/'))).toEqual([]);
  });
});

describe('std-triage', () => {
  /** The recipe's issue shape. */
  const Issue = z.object({ number: z.int().min(1), title: z.string(), body: z.string() });
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
    expect(result.output).toMatchObject({
      labeled: {
        counts: [
          { label: 'bug', count: 2 },
          { label: 'feature', count: 1 },
          { label: 'docs', count: 1 },
          { label: 'question', count: 0 },
        ],
        unlabeled: [issues[4]],
        omitted: [],
        failed: [],
        failures: 0,
        status: 'complete',
      },
      urgent: [issues[3], issues[0]],
    });
    expect(result.output?.labeled.assignments.map(({ key, labels }) => [key, labels])).toEqual([
      ['1', ['bug']],
      ['2', ['feature']],
      ['3', ['docs']],
      ['4', ['bug']],
    ]);
    // The labeled result also parses against the default taxonomy's label names.
    const labels = ['bug', 'feature', 'docs', 'question'];
    roundTrip(std.patterns.ClassifyResult(Issue, labels), result.output?.labeled);
    expect(calls.ids()).toEqual(['classify/chunk/0/tag', 'rank/rank']);
    const classify = calls.prompt('classify/chunk/0/tag');
    expect(classify).toContain('### Taxonomy\n\n- bug\n- feature\n- docs\n- question');
    expect(classify).toContain('- 4: {"body":"Data loss on sync.","number":14');
    const rank = calls.prompt('rank/rank');
    expect(rank).toContain('Choose the 2 items below that rank highest on this criterion: How');
    expect(rank).toContain('"labels":["bug"]');
    expect(rank).not.toContain('Hello?');
    // The tagger is the tool-free Clerk and the ranker the Judge.
    const [tagger, ranker] = calls.calls;
    expect(tagger?.options).toMatchObject({ tools: [], model: std.roles.Clerk.model });
    expect(ranker?.options).toMatchObject({ model: std.roles.Judge.model });
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
      labeled: {
        counts: [
          { label: 'p1', count: 3 },
          { label: 'p0', count: 2 },
        ],
        unlabeled: [],
        status: 'complete',
      },
      urgent: issues,
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
      labeled: {
        counts: [
          { label: 'bug', count: 2 },
          { label: 'feature', count: 0 },
          { label: 'docs', count: 0 },
          { label: 'question', count: 0 },
        ],
        unlabeled: [],
        failed: many.slice(0, 10),
        failedChunks: 1,
        failures: 1,
        status: 'degraded',
      },
      urgent: [many[11]],
    });
    expect(calls.count('classify/chunk/0/tag')).toBe(1);
    expect(calls.prompt('rank/rank')).toContain('- 11: {"item":{"body":"Issue 10.","number":110');
  });
});

describe('std-route', () => {
  const request = 'Exporting a report with an empty title crashes the CLI.';
  /** Each route's branch: its step ID, the role it calls and the opening of its prompt. */
  const branches = {
    question: ['answer', std.roles.Reader, 'Answer the question below, citing file:line.'],
    bug: ['diagnose', std.roles.Reviewer, 'Find the cause of the bug below, at file:line.'],
    feature: ['scope', std.roles.Planner, 'Scope the feature below; list open questions.'],
    unclear: ['clarify', std.roles.Writer, 'Ask its author what the request below lacks.'],
  } as const;

  it.each(Object.entries(branches))(
    'routes a %s request to its branch, one short call, and replays',
    async (route, [id, role, task]) => {
      const calls = harness({
        'route/route': { route, reason: `It reads as a ${route}.` },
        [id]: `The ${id} reply.`,
      });
      const result = await replayAfterTail(routeRecipe, { request }, calls, root, `std-${route}`);
      expect(result.output).toEqual({
        routed: {
          route,
          reason: `It reads as a ${route}.`,
          fallback: false,
          failures: 0,
          status: 'complete',
        },
        reply: `The ${id} reply.`,
      });
      roundTrip(std.patterns.RouteResult(Object.keys(branches)), result.output?.routed);
      expect(calls.ids()).toEqual(['route/route', id]);
      expect(Object.keys(result.steps).sort()).toEqual(['probe/tail', 'route/route', id].sort());
      // The branch call shows the request under its task, and runs as the branch's role.
      expect(calls.prompt(id)).toBe(`${task}\n\n## Context\n\n${request}`);
      const branch = calls.calls[1]?.options as { tools?: unknown; model?: unknown };
      expect(branch.tools).toEqual(role.tools);
      expect(branch.model).toBe('model' in role ? role.model : undefined);
    },
  );

  it('asks the Clerk to choose among the routes, naming unclear as the safe default', async () => {
    const calls = harness({ 'route/route': { route: 'bug', reason: 'A crash.' } }, () => 'Reply.');
    await runWorkflow(routeRecipe, { ...runOptions(root), harness: calls, input: { request } });
    const prompt = calls.prompt('route/route');
    expect(prompt).toContain(`### Subject\n\n${request}`);
    expect(prompt).toContain(
      '### Routes\n\n- question: Asks how something works or where it is; the code and its docs can answer it.\n- bug: ',
    );
    expect(prompt).toContain('choose unclear: it is the safe default.');
    expect(calls.calls[0]?.options).toMatchObject({ tools: [], model: std.roles.Clerk.model });
  });

  it('takes the unclear branch when the router fails, without retrying the router', async () => {
    const calls = harness({
      'route/route': new Error('router crashed'),
      clarify: 'What did you run, and what did you expect?',
    });
    const result = await replayAfterTail(routeRecipe, { request }, calls, root);
    expect(result.output).toMatchObject({
      routed: { route: 'unclear', fallback: true, failures: 1, status: 'degraded' },
      reply: 'What did you run, and what did you expect?',
    });
    expect(result.output?.routed.reason).toContain('router crashed');
    expect(calls.ids()).toEqual(['route/route', 'clarify']);
    expect(calls.count('route/route')).toBe(1);
  });

  it('fails the run when the chosen branch fails, and retries only that branch on resume', async () => {
    let failing = true;
    const calls = harness(
      { 'route/route': { route: 'question', reason: 'A question.' } },
      (call) => {
        if (call.stepId !== 'answer') return undefined;
        if (failing) return new Error('reader crashed');
        return 'The answer.';
      },
    );
    const options = { ...runOptions(root), harness: calls };
    await expect(runWorkflow(routeRecipe, { ...options, input: { request } })).rejects.toThrow(
      'reader crashed',
    );
    failing = false;
    const resumed = await runWorkflow(routeRecipe, { ...options, resume: true });
    expect(resumed.output?.reply).toBe('The answer.');
    expect(calls.ids()).toEqual(['route/route', 'answer', 'answer']);
  });
});
