// The std gate recipes run end to end in a temporary Git repository against a scripted harness:
// examples/patterns/std-release-gate.workflow.ts (gate over the std.exec.log commit list and the
// std.exec.diffStat of an input range, returning the GateResult) and
// examples/patterns/std-acceptance.workflow.ts (checklist of input std.types.Criteria against the
// diff of an input range, returning the ChecklistResult). Calls that matter are scripted by step
// ID; the rest get schema-valid filler from synthesizeOutput. Each run proves replay after a tail
// failure without new agent calls or commands.
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NodeProcessRunner,
  runWorkflow,
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
import { release } from '../src/std/lenses.js';
import type { Assessment, CriterionResult } from '../src/std/types.js';
import { capabilityManifest } from '../src/workflow/runtime/profiles.js';
import acceptance from '../examples/patterns/std-acceptance.workflow.js';
import releaseGate from '../examples/patterns/std-release-gate.workflow.js';
import {
  ScriptedHarness,
  makeRoot,
  removeRoot,
  roundTrip,
  runOptions,
  tailFailure,
} from './std-harness.js';

const execute = promisify(execFile);
let root: string;
let base: string;
let runner: RecordingRunner;

/** A real process runner that records each command it is asked to run. */
class RecordingRunner implements ProcessRunner {
  public readonly commands: Command[] = [];
  private readonly inner = new NodeProcessRunner();

  public run(request: ProcessRunRequest, invocation: HarnessInvocation): Promise<ExecResult> {
    this.commands.push(request.command);
    return this.inner.run(request, invocation);
  }
}

async function git(...args: string[]): Promise<string> {
  const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
  const { stdout } = await execute('git', [...identity, '-c', 'commit.gpgSign=false', ...args], {
    cwd: root,
  });
  return stdout;
}

async function commit(message: string): Promise<string> {
  await git('add', '--', 'src');
  await git('commit', '--quiet', '-m', message);
  return (await git('rev-parse', 'HEAD')).trim();
}

beforeEach(async () => {
  root = await makeRoot('choir-std-examples-gates-');
  await git('init', '--quiet');
  const hooks = join(root, 'empty-hooks');
  await mkdir(hooks);
  await git('config', '--local', 'core.hooksPath', hooks);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'flags.ts'), 'export const flags = {};\n');
  base = await commit('base');
  await writeFile(join(root, 'src', 'flags.ts'), 'export const flags = { verbose: false };\n');
  await commit('Add the verbose flag');
  await writeFile(join(root, 'src', 'parse.ts'), 'export const parse = (s: string) => s.trim();\n');
  await commit('Trim parsed input');
  runner = new RecordingRunner();
});
afterEach(async () => {
  await removeRoot(root);
});

/**
 * A harness that answers scripted step IDs from `replies` (an Error is thrown), rates every other
 * gate dimension `pass`, and fills any other structured call with synthesizeOutput.
 */
function harness(replies: Readonly<Record<string, unknown>>): ScriptedHarness {
  return new ScriptedHarness((request: HarnessRequest) => {
    const reply = replies[request.stepId];
    if (reply instanceof Error) throw reply;
    if (reply !== undefined) return reply;
    if (request.stepId.endsWith('/assess'))
      return { status: 'pass', summary: 'Checked.', evidence: ['src/flags.ts:1'] };
    if (request.outputSchema === null) throw new Error(`Unexpected text call ${request.stepId}`);
    return synthesizeOutput(request.outputSchema, request.stepId);
  });
}

/**
 * Run `workflow` to an injected tail failure, then resume it twice: the resumes make no new agent
 * call and run no command, and record the same steps.
 */
async function replay<I, O>(
  workflow: WorkflowDefinition<I, O>,
  input: I,
  calls: ScriptedHarness,
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

it('needs no grant: both recipes call only read-only roles', () => {
  const required = (workflow: object) =>
    capabilityManifest(workflow, { requireGrants: true }).requiredGrants;
  expect(required(releaseGate)).toEqual([]);
  expect(required(acceptance)).toEqual([]);
});

describe('std-release-gate', () => {
  const blocker: Assessment = {
    status: 'blocker',
    summary: 'parse.ts trims input without tests.',
    evidence: ['src/parse.ts:1'],
  };

  it('gates the range on its commits and diff stat, and a confirmed blocker is no-go', async () => {
    const calls = harness({
      'gate/dimension/tests/assess': blocker,
      'gate/dimension/docs/assess': { ...blocker, status: 'concern', summary: 'No changelog.' },
      'gate/blocker/tests/seat/0/verdict': { refuted: false, reasoning: 'No test covers it.' },
      'gate/blocker/tests/seat/1/verdict': { refuted: false, reasoning: 'Confirmed.' },
      'gate/blocker/tests/seat/2/verdict': new Error('skeptic crashed'),
    });
    const range = `${base}..HEAD`;
    const result = await replay(releaseGate, { range, seats: 3 }, calls);
    expect(result.output).toMatchObject({
      decision: 'no-go',
      blockers: ['tests'],
      concerns: ['docs'],
      reasons: [
        'tests (blocker): parse.ts trims input without tests.',
        'docs (concern): No changelog.',
      ],
      failedVotes: 1,
      failures: 1,
      status: 'degraded',
    });
    expect(result.output?.assessments.map((dimension) => dimension.key)).toEqual(
      release.map((lens) => lens.key),
    );
    roundTrip(std.patterns.GateResult, result.output);

    expect(runner.commands).toEqual([
      [
        'git',
        '-c',
        'core.abbrev=auto',
        'log',
        '-z',
        '--reverse',
        '--no-color',
        '--no-show-signature',
        '--encoding=UTF-8',
        '--format=%H%x00%h%x00%an%x00%aI%x00%s',
        '--end-of-options',
        range,
        '--',
      ],
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
    ]);
    expect(Object.keys(result.steps)).toEqual(expect.arrayContaining(['commits', 'stat']));
    expect(
      calls
        .ids()
        .filter((id) => id.endsWith('/assess'))
        .sort(),
    ).toEqual(release.map((lens) => `gate/dimension/${lens.key}/assess`).sort());
    expect(
      calls
        .ids()
        .filter((id) => id.startsWith('gate/blocker/'))
        .sort(),
    ).toEqual([0, 1, 2].map((seat) => `gate/blocker/tests/seat/${String(seat)}/verdict`));
    expect(calls.count('gate/blocker/tests/seat/2/verdict')).toBe(1);
    const prompt = calls.prompt('gate/dimension/security/assess');
    const opening = `Assess whether the release ${range} is ready to ship. Assess one dimension only, security:`;
    expect(prompt.slice(0, opening.length)).toBe(opening);
    // The commits oldest first, each with its short ID, author and day; then the diff stat.
    expect(prompt).toMatch(
      /## Commits\n\n- `[0-9a-f]{7,}` Add the verbose flag \(Fixture, \d{4}-\d{2}-\d{2}\)\n- `[0-9a-f]{7,}` Trim parsed input \(Fixture, \d{4}-\d{2}-\d{2}\)\n\n## Diff stat\n\n/u,
    );
    expect(prompt).toMatch(
      /## Diff stat\n\n src\/flags\.ts \| 2 \+-\n src\/parse\.ts \| 1 \+\n 2 files changed/u,
    );
    // The assessor is the read-only Reviewer and each challenging seat the Skeptic.
    const options = (id: string) => calls.calls.find((call) => call.stepId === id)?.options;
    expect(options('gate/dimension/tests/assess')).toMatchObject({
      tools: ['Read', 'Grep', 'Glob'],
      model: std.roles.Reviewer.model,
    });
    expect(options('gate/blocker/tests/seat/0/verdict')).toMatchObject({
      tools: ['Read', 'Grep', 'Glob'],
      model: std.roles.Skeptic.model,
    });
  });

  it('goes when every dimension passes, with one default seat and no blocker panel', async () => {
    const calls = harness({});
    const result = await runWorkflow(releaseGate, {
      ...runOptions(root),
      harness: calls,
      processRunner: runner,
      input: { range: `${base}..HEAD` },
    });
    expect(result.output).toMatchObject({
      decision: 'go',
      blockers: [],
      reasons: [],
      failures: 0,
      status: 'complete',
    });
    expect(calls.ids()).toHaveLength(release.length);
  });

  it('refuses a range that Git would read as an option before running anything', async () => {
    const calls = harness({});
    await expect(
      runWorkflow(releaseGate, {
        ...runOptions(root),
        harness: calls,
        processRunner: runner,
        input: { range: '--output=leak.txt' },
      }),
    ).rejects.toThrow('Expected a Git revision or range such as main..HEAD');
    expect(runner.commands).toEqual([]);
    expect(calls.calls).toHaveLength(0);
    expect(await readdir(root)).not.toContain('leak.txt');
  });
});

describe('std-acceptance', () => {
  const pass: CriterionResult = { status: 'pass', evidence: 'src/flags.ts:1 adds verbose.' };
  const fail: CriterionResult = { status: 'fail', evidence: 'No docs mention verbose.' };

  it('checks every criterion against the range diff and is not done when one fails', async () => {
    const calls = harness({
      'acceptance/criterion/C1/check': pass,
      'acceptance/criterion/C2/check': fail,
      'acceptance/criterion/parse/check': pass,
    });
    const range = `${base}..HEAD`;
    const criteria = [
      'A verbose flag exists and defaults to false.',
      'The verbose flag is documented.',
      { id: 'parse', criterion: 'Parsed input is trimmed.', how: 'Read src/parse.ts.' },
    ];
    const result = await replay(acceptance, { range, criteria }, calls);
    expect(result.output).toEqual({
      verdict: 'not-done',
      results: [
        { criterion: { id: 'C1', criterion: criteria[0], how: '' }, result: pass },
        { criterion: { id: 'C2', criterion: criteria[1], how: '' }, result: fail },
        { criterion: criteria[2], result: pass },
      ],
      counts: { pass: 2, fail: 1, partial: 0, unverifiable: 0 },
      failures: 0,
      status: 'complete',
    });
    roundTrip(std.patterns.ChecklistResult, result.output);

    expect(runner.commands).toEqual([
      ['git', 'diff', '--no-color', '--no-ext-diff', '--no-relative', range, '--'],
    ]);
    expect(calls.ids().sort()).toEqual(
      ['C1', 'C2', 'parse'].map((id) => `acceptance/criterion/${id}/check`).sort(),
    );
    const prompt = calls.prompt('acceptance/criterion/parse/check');
    expect(prompt).toMatch(
      /^Check whether acceptance criterion parse holds for the target below: Parsed input is trimmed\./u,
    );
    expect(prompt).toContain(`## Context\n\nThe change in ${range}, as git diff shows it:`);
    expect(prompt).toContain('+export const parse = (s: string) => s.trim();');
    expect(prompt).toContain('- Check it this way: Read src/parse.ts.');
    // Every checker is the read-only Reviewer.
    for (const call of calls.calls)
      expect(call.options).toMatchObject({
        tools: ['Read', 'Grep', 'Glob'],
        model: std.roles.Reviewer.model,
      });
  });

  it('is unverified when a checker fails, without retrying it on resume', async () => {
    const calls = harness({
      'acceptance/criterion/C1/check': pass,
      'acceptance/criterion/C2/check': new Error('checker crashed'),
    });
    const input = { range: `${base}..HEAD`, criteria: ['Has a flag.', 'Has docs.'] };
    const result = await replay(acceptance, input, calls);
    expect(result.output).toMatchObject({
      verdict: 'unverified',
      counts: { pass: 1, fail: 0, partial: 0, unverifiable: 0 },
      failures: 1,
      status: 'degraded',
    });
    expect(result.output?.results[1]?.result).toBeNull();
    expect(calls.count('acceptance/criterion/C2/check')).toBe(1);
  });

  it('takes criteria through std.types.Criteria, refusing an empty list or a blank one', () => {
    const range = 'main..HEAD';
    expect(() => acceptance.input.parse({ range, criteria: [] })).toThrow();
    expect(() => acceptance.input.parse({ range, criteria: ['  '] })).toThrow();
    expect(acceptance.input.parse({ range, criteria: ['Has a flag.'] })).toEqual({
      range,
      criteria: ['Has a flag.'],
    });
  });
});
