// The std panel recipes run end to end: examples/patterns/std-bug-hunt.workflow.ts (hunt over an
// input scope, returning the whole HuntResult) against a scripted harness, and, in a temporary
// repository, examples/patterns/std-code-review.workflow.ts (lensPanel over the review lenses of a
// real Git diff, then verify) and examples/patterns/std-vote.workflow.ts (a unanimous merge-safety
// vote over a range's diff stat and diff). Calls that matter are scripted by step ID; the rest get
// schema-valid filler from synthesizeOutput. Each run proves replay after a tail failure without
// new calls or commands.
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NodeProcessRunner,
  runWorkflow,
  stepId,
  synthesizeOutput,
  type Command,
  type ExecResult,
  type HarnessInvocation,
  type HarnessRequest,
  type ProcessRunRequest,
  type ProcessRunner,
  type WorkflowDefinition,
  type WorkflowResult,
} from '../src/index.js';
import * as std from '../src/std/index.js';
import { findingKey } from '../src/std/data.js';
import { review } from '../src/std/lenses.js';
import type { Finding, Severity } from '../src/std/types.js';
import { capabilityManifest } from '../src/workflow/runtime/profiles.js';
import bugHunt from '../examples/patterns/std-bug-hunt.workflow.js';
import codeReview from '../examples/patterns/std-code-review.workflow.js';
import mergeVote from '../examples/patterns/std-vote.workflow.js';
import {
  ScriptedHarness,
  makeRoot,
  promptOf,
  removeRoot,
  replayAfterTail,
  roundTrip,
  runOptions,
  tailFailure,
} from './std-harness.js';

const execute = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await makeRoot('choir-std-examples-panels-');
});
afterEach(async () => {
  await removeRoot(root);
});

it('needs no grant: every panel recipe calls only read-only roles', () => {
  const required = (workflow: object) =>
    capabilityManifest(workflow, { requireGrants: true }).requiredGrants;
  expect(required(bugHunt)).toEqual([]);
  expect(required(codeReview)).toEqual([]);
  expect(required(mergeVote)).toEqual([]);
});

/** A located finding with the given title, severity and file. */
function finding(title: string, severity: Severity, file = 'src/a.ts'): Finding {
  return { title, file, line: 2, severity, evidence: `${file}:2`, failureScenario: 'it breaks' };
}

/** The step-ID segment of a finding's key, as verify and hunt use it. */
function segment(item: Finding): string {
  return stepId(findingKey(item));
}

/**
 * A harness that answers scripted step IDs from `replies` (an Error is thrown), reports no findings
 * for any other finder or reader, refutes every claim whose prompt mentions a title in `refute`,
 * upholds every other claim, and fills any other structured call with synthesizeOutput.
 */
function harness(
  replies: Readonly<Record<string, unknown>>,
  refute: readonly string[] = [],
): ScriptedHarness {
  return new ScriptedHarness((request: HarnessRequest) => {
    const reply = replies[request.stepId];
    if (reply instanceof Error) throw reply;
    if (reply !== undefined) return reply;
    if (request.stepId.endsWith('/verdict')) {
      const refuted = refute.some((title) => promptOf(request).includes(title));
      return { refuted, reasoning: refuted ? 'A guard prevents it.' : 'Reproduced from the code.' };
    }
    // A finder or reader without a scripted reply found nothing.
    if (/\/(?:find|read)$/u.test(request.stepId)) return { findings: [] };
    if (request.outputSchema === null) throw new Error(`Unexpected text call ${request.stepId}`);
    return synthesizeOutput(request.outputSchema, request.stepId);
  });
}

describe('std-bug-hunt', () => {
  const high = finding('Unchecked null in parse', 'high');
  const critical = finding('Buffer overrun on empty input', 'critical', 'src/b.ts');
  const low = finding('Misleading error text', 'low', 'src/c.ts');

  it('returns the confirmed findings most severe first and replays without new calls', async () => {
    const calls = harness(
      {
        'hunt/round/0/lens/error-handling/find': { findings: [high, low] },
        'hunt/round/0/lens/boundaries/find': { findings: [critical] },
        'hunt/round/1/lens/contracts/find': { findings: [high] },
      },
      [low.title],
    );
    const input = { scope: 'src/', rounds: 4, maxCalls: 80 };
    const result = await replayAfterTail(bugHunt, input, calls, root);
    // The whole HuntResult: the confirmed findings most severe first, and the refuted one apart.
    expect(result.output).toMatchObject({
      status: 'complete',
      ended: 'dry',
      rounds: 3,
      dryRounds: 2,
      findings: [critical, high],
      unverified: [],
      undecided: [],
      failures: 0,
    });
    expect(result.output?.confirmed.map((verdict) => verdict.item)).toEqual([critical, high]);
    expect(result.output?.refuted.map((verdict) => verdict.item)).toEqual([low]);
    roundTrip(std.patterns.HuntResult, result.output);

    const finders = calls.ids().filter((id) => id.endsWith('/find'));
    expect(finders.sort()).toEqual(
      [
        '0/error-handling',
        '0/boundaries',
        '0/concurrency',
        '1/resource-lifecycle',
        '1/state-machines',
        '1/contracts',
        '2/time-and-ordering',
        '2/input-validation',
        '2/error-handling',
      ]
        .map((entry) => {
          const [round = '', lens = ''] = entry.split('/');
          return `hunt/round/${round}/lens/${lens}/find`;
        })
        .sort(),
    );
    const verdicts = calls.ids().filter((id) => id.endsWith('/verdict'));
    expect(verdicts.sort()).toEqual(
      [high, low, critical]
        .flatMap((item) =>
          [0, 1, 2].map(
            (seat) => `hunt/round/0/item/${segment(item)}/seat/${String(seat)}/verdict`,
          ),
        )
        .sort(),
    );
    expect(calls.prompt('hunt/round/0/lens/boundaries/find')).toContain('## Context\n\nsrc/');
    expect(calls.prompt('hunt/round/1/lens/contracts/find')).toContain(
      '- src/c.ts:2: Misleading error text',
    );
    expect(calls.prompt(`hunt/round/0/item/${segment(low)}/seat/2/verdict`)).toContain(
      '## Subject\n\nsrc/\n\n## Guidance',
    );
  });

  it('reports the call limit when maxCalls cannot cover the hunt', async () => {
    const calls = harness({ 'hunt/round/0/lens/error-handling/find': { findings: [high, low] } });
    const result = await runWorkflow(bugHunt, {
      ...runOptions(root),
      harness: calls,
      input: { scope: 'src/', rounds: 4, maxCalls: 6 },
    });
    expect(result.output).toMatchObject({
      status: 'complete',
      ended: 'call-limit',
      rounds: 1,
      findings: [high],
      unverified: [low],
      failures: 0,
    });
    expect(calls.ids().filter((id) => id.endsWith('/verdict'))).toHaveLength(3);
  });

  it('reports a failed finder as degraded and keeps hunting without retrying it', async () => {
    const calls = harness({
      'hunt/round/0/lens/error-handling/find': new Error('finder crashed'),
      'hunt/round/0/lens/boundaries/find': { findings: [critical] },
    });
    const result = await replayAfterTail(
      bugHunt,
      { scope: 'src/', rounds: 4, maxCalls: 80 },
      calls,
      root,
    );
    expect(result.output).toMatchObject({
      status: 'degraded',
      ended: 'dry',
      findings: [critical],
      failedFinders: 1,
      failures: 1,
    });
    expect(calls.count('hunt/round/0/lens/error-handling/find')).toBe(1);
  });
});

/** A real process runner that records each command it is asked to run. */
class RecordingRunner implements ProcessRunner {
  public readonly commands: Command[] = [];
  private readonly inner = new NodeProcessRunner();

  public run(request: ProcessRunRequest, invocation: HarnessInvocation): Promise<ExecResult> {
    this.commands.push(request.command);
    return this.inner.run(request, invocation);
  }
}

/** Run `git` in the test root with a fixed identity and no signing. */
async function git(...args: string[]): Promise<string> {
  const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
  const { stdout } = await execute('git', [...identity, '-c', 'commit.gpgSign=false', ...args], {
    cwd: root,
  });
  return stdout;
}

/** Commit the `src` directory with `message` and return the new commit's SHA. */
async function commit(message: string): Promise<string> {
  await git('add', '--', 'src');
  await git('commit', '--quiet', '-m', message);
  return (await git('rev-parse', 'HEAD')).trim();
}

/**
 * A repository in the test root with a base commit and one change that makes `parse` accept null
 * and call trim on it; returns the base commit.
 */
async function repository(): Promise<string> {
  await git('init', '--quiet');
  const hooks = join(root, 'empty-hooks');
  await mkdir(hooks);
  await git('config', '--local', 'core.hooksPath', hooks);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'export const parse = (s: string) => s;\n');
  const base = await commit('base');
  await writeFile(
    join(root, 'src', 'a.ts'),
    'export const parse = (s: string | null) => s.trim();\n',
  );
  await commit('change');
  return base;
}

/**
 * Run `workflow` to an injected tail failure, then resume it twice: the resumes make no new agent
 * call and run no command, and record the same steps.
 */
async function replay<I, O>(
  workflow: WorkflowDefinition<I, O>,
  input: I,
  calls: ScriptedHarness,
  runner: RecordingRunner,
): Promise<WorkflowResult<O>> {
  const wrapped = tailFailure(workflow);
  const options = { ...runOptions(root), harness: calls, processRunner: runner };
  await expect(runWorkflow(wrapped, { ...options, input })).rejects.toThrow(
    'Injected tail failure',
  );
  const [agentCalls, commands] = [calls.calls.length, runner.commands.length];
  const resumed = await runWorkflow(wrapped, { ...options, resume: true });
  expect([calls.calls.length, runner.commands.length]).toEqual([agentCalls, commands]);
  const again = await runWorkflow(wrapped, { ...options, resume: true });
  expect(again.steps).toEqual(resumed.steps);
  return resumed;
}

describe('std-code-review', () => {
  let base: string;
  let runner: RecordingRunner;

  beforeEach(async () => {
    base = await repository();
    runner = new RecordingRunner();
  });

  const nullDeref = finding('Null dereference in parse', 'high');
  const injection = finding('Untrusted input reaches trim', 'critical');
  const style = finding('Arrow function style', 'low');

  it('reviews the range diff through every lens and returns the confirmed findings', async () => {
    const calls = harness(
      {
        'review/lens/correctness/read': { findings: [style, nullDeref] },
        'review/lens/security/read': {
          findings: [injection, { ...nullDeref, title: 'null dereference in PARSE' }],
        },
        'review/lens/performance/read': new Error('reviewer crashed'),
      },
      [style.title],
    );
    const range = `${base}..HEAD`;
    const result = await replay(codeReview, { range }, calls, runner);
    expect(result.output).toEqual({ status: 'degraded', findings: [injection, nullDeref] });

    expect(runner.commands).toEqual([
      ['git', 'diff', '--no-color', '--no-ext-diff', '--no-relative', range, '--'],
    ]);
    expect(
      calls
        .ids()
        .filter((id) => id.startsWith('review/'))
        .sort(),
    ).toEqual(review.map((lens) => `review/lens/${lens.key}/read`).sort());
    expect(calls.count('review/lens/performance/read')).toBe(1);
    expect(
      calls
        .ids()
        .filter((id) => id.startsWith('verify/'))
        .sort(),
    ).toEqual(
      // Items are keyed by position after deduplication: style, nullDeref, injection.
      [0, 1, 2]
        .flatMap((item) =>
          [0, 1, 2].map((seat) => `verify/item/${String(item)}/seat/${String(seat)}/verdict`),
        )
        .sort(),
    );
    const prompt = calls.prompt('review/lens/security/read');
    const opening = `Review the changes in ${range} below for defects. Work through one lens only, security:`;
    expect(prompt.slice(0, opening.length)).toBe(opening);
    expect(prompt).toContain('```diff\ndiff --git a/src/a.ts b/src/a.ts');
    expect(prompt).toContain('+export const parse = (s: string | null) => s.trim();');
    // The skeptic sees the claim and the same diff, so it checks the range rather than whatever
    // happens to be checked out.
    const skeptic = calls.prompt('verify/item/1/seat/0/verdict');
    expect(skeptic).toMatch(/^Try to refute the claim below\./u);
    expect(skeptic).toContain('"title": "Null dereference in parse"');
    expect(skeptic).toContain(`## Subject\n\nThe changes in ${range}:\n\n\`\`\`diff\ndiff --git`);
  });

  it('is complete when every lens and seat answers', async () => {
    const calls = harness({ 'review/lens/tests/read': { findings: [nullDeref] } });
    const result = await runWorkflow(codeReview, {
      ...runOptions(root),
      harness: calls,
      processRunner: runner,
      input: { range: `${base}..HEAD` },
    });
    expect(result.output).toEqual({ status: 'complete', findings: [nullDeref] });
  });
});

describe('std-vote', () => {
  let base: string;
  let runner: RecordingRunner;

  beforeEach(async () => {
    base = await repository();
    runner = new RecordingRunner();
  });

  /** A ballot reply: yes or no, with reasoning that names the seat. */
  const ballot = (yes: boolean, seat: number) => ({
    yes,
    reasoning: `Seat ${String(seat)} checked the callers of parse.`,
  });
  /** Replies for every seat of a three-seat vote; `no` seats vote no, `failed` seats throw. */
  const seats = (no: readonly number[] = [], failed: readonly number[] = []) =>
    Object.fromEntries(
      [0, 1, 2].map((seat) => [
        `vote/seat/${String(seat)}/ballot`,
        failed.includes(seat) ? new Error('voter crashed') : ballot(!no.includes(seat), seat),
      ]),
    );
  const ballots = [0, 1, 2].map((seat) => `vote/seat/${String(seat)}/ballot`);

  it('clears the change when every seat votes yes, over the diff stat and diff', async () => {
    const calls = harness(seats());
    const range = `${base}..HEAD`;
    const result = await replay(mergeVote, { range, seats: 3 }, calls, runner);
    expect(result.output).toEqual({
      outcome: 'yes',
      yes: 3,
      no: 0,
      missing: 0,
      seats: 3,
      reasons: [0, 1, 2].map((seat) => `yes: ${ballot(true, seat).reasoning}`),
      failures: 0,
      status: 'complete',
    });
    roundTrip(std.patterns.VoteResult, result.output);

    expect(runner.commands).toEqual([
      [
        'git',
        '-c',
        'core.quotePath=false',
        'diff',
        '--stat=10000,10000',
        '--stat-graph-width=40',
        '--no-color',
        '--no-ext-diff',
        '--no-relative',
        '--end-of-options',
        range,
        '--',
      ],
      ['git', 'diff', '--no-color', '--no-ext-diff', '--no-relative', range, '--'],
    ]);
    expect(Object.keys(result.steps).sort()).toEqual(
      ['diff', 'probe/tail', 'stat', ...ballots].sort(),
    );
    expect([...calls.ids()].sort()).toEqual(ballots);
    const prompt = calls.prompt('vote/seat/1/ballot');
    const opening = `Vote yes or no on this question: Is the change in ${range} safe to merge, breaking no existing caller or behavior?`;
    expect(prompt.slice(0, opening.length)).toBe(opening);
    expect(prompt).toContain('## Context\n\n## Files\n\n src/a.ts | 2 +-\n');
    expect(prompt).toContain('## Diff\n\n```diff\ndiff --git a/src/a.ts b/src/a.ts');
    expect(prompt).toContain('+export const parse = (s: string | null) => s.trim();');
    // Every seat is the read-only Skeptic, with its persona.
    for (const call of calls.calls)
      expect(call.options).toMatchObject({
        tools: ['Read', 'Grep', 'Glob'],
        model: std.roles.Skeptic.model,
        appendSystemPrompt: std.personas.Skeptic.appendSystemPrompt,
      });
  });

  it('does not clear the change when a single seat votes no', async () => {
    const calls = harness(seats([1]));
    const result = await runWorkflow(mergeVote, {
      ...runOptions(root),
      harness: calls,
      processRunner: runner,
      input: { range: `${base}..HEAD`, seats: 3 },
    });
    expect(result.output).toMatchObject({
      outcome: 'no',
      yes: 2,
      no: 1,
      missing: 0,
      status: 'complete',
    });
    expect(result.output?.reasons[1]).toBe(`no: ${ballot(false, 1).reasoning}`);
  });

  it('is undecided and degraded when a seat fails, without retrying it on resume', async () => {
    const calls = harness(seats([], [2]));
    const result = await replay(mergeVote, { range: `${base}..HEAD`, seats: 3 }, calls, runner);
    expect(result.output).toMatchObject({
      outcome: 'undecided',
      yes: 2,
      no: 0,
      missing: 1,
      failures: 1,
      status: 'degraded',
    });
    expect(calls.count('vote/seat/2/ballot')).toBe(1);
  });

  it('defaults to three seats', () => {
    expect(mergeVote.input.parse({ range: 'main..HEAD' })).toEqual({
      range: 'main..HEAD',
      seats: 3,
    });
  });

  it('refuses a range that Git would read as an option before running anything', async () => {
    const calls = harness(seats());
    await expect(
      runWorkflow(mergeVote, {
        ...runOptions(root),
        harness: calls,
        processRunner: runner,
        input: { range: '--output=leak.txt', seats: 3 },
      }),
    ).rejects.toThrow('Expected a Git revision or range such as main..HEAD');
    expect(runner.commands).toEqual([]);
    expect(calls.calls).toHaveLength(0);
    expect(await readdir(root)).not.toContain('leak.txt');
  });
});
