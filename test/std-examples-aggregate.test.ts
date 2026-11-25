// The std aggregate recipes end to end: std-changelog (one std.exec.log read over a real temporary
// repository, then mapReduce into release notes, returning the MapReduceResult) and
// std-plan-and-build (decompose a goal, then std.flow.waves running a Mechanic per task), against a
// scripted harness, checking their outputs, step IDs, team wiring, grants, failure handling and
// replay after a tail failure without new agent calls or commands.
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FixtureHarness,
  NodeProcessRunner,
  parseHarnessFixtures,
  runWorkflow,
  synthesizeOutput,
  type HarnessInvocation,
  type HarnessRequest,
  type ExecResult,
  type ProcessRunRequest,
  type ProcessRunner,
  type WorkflowDefinition,
} from '../src/index.js';
import * as std from '../src/std/index.js';
import { capabilityManifest } from '../src/workflow/runtime/profiles.js';
import changelog from '../examples/patterns/std-changelog.workflow.js';
import planAndBuild from '../examples/patterns/std-plan-and-build.workflow.js';
import {
  ScriptedHarness,
  makeRoot,
  promptOf,
  removeRoot,
  roundTrip,
  runOptions,
  tailFailure,
} from './std-harness.js';

const execute = promisify(execFile);
let root: string;
let repo: string;
let runner: RecordingRunner;

/** A real process runner that counts the commands it runs. */
class RecordingRunner implements ProcessRunner {
  public runs = 0;
  private readonly inner = new NodeProcessRunner();

  public run(request: ProcessRunRequest, invocation: HarnessInvocation): Promise<ExecResult> {
    this.runs += 1;
    return this.inner.run(request, invocation);
  }
}

beforeEach(async () => {
  root = await makeRoot('choir-std-examples-aggregate-');
  repo = join(root, 'repo');
  await mkdir(repo);
  runner = new RecordingRunner();
});
afterEach(async () => {
  await removeRoot(root);
});

/** A harness that answers `replies` by step ID and fills every other structured call. */
function scripted(
  replies: Readonly<Record<string, (request: HarnessRequest) => unknown>>,
): ScriptedHarness {
  return new ScriptedHarness((request) => {
    const reply = replies[request.stepId];
    if (reply !== undefined) {
      const value = reply(request);
      if (value instanceof Error) throw value;
      return value;
    }
    if (request.outputSchema === null) throw new Error(`Unscripted text call ${request.stepId}`);
    return synthesizeOutput(request.outputSchema, request.stepId);
  });
}

/** `runWorkflow` options in the temporary repository, with a real (counting) process runner. */
function options(harness: ScriptedHarness, runId = 'std') {
  return { ...runOptions(root, runId), cwd: repo, harness, processRunner: runner };
}

/**
 * Run `workflow` to an injected tail failure, then resume it twice: the resumes make no new agent
 * call and run no command, and record the same steps. Returns the first resume.
 */
async function replayAfterTail<I, O>(
  workflow: WorkflowDefinition<I, O>,
  input: I,
  harness: ScriptedHarness,
) {
  const wrapped = tailFailure(workflow);
  await expect(runWorkflow(wrapped, { ...options(harness), input })).rejects.toThrow(
    'Injected tail failure',
  );
  const calls = harness.calls.length;
  const commands = runner.runs;
  const resumed = await runWorkflow(wrapped, { ...options(harness), resume: true });
  expect(harness.calls).toHaveLength(calls);
  expect(runner.runs).toBe(commands);
  const again = await runWorkflow(wrapped, { ...options(harness), resume: true });
  expect(again.steps).toEqual(resumed.steps);
  return resumed;
}

it('asks for grants only on the write roles each recipe calls', () => {
  const required = (workflow: object) =>
    capabilityManifest(workflow, { requireGrants: true }).requiredGrants;
  expect(required(changelog)).toEqual([]);
  expect(required(planAndBuild)).toEqual(['Mechanic']);
});

describe('std-changelog', () => {
  async function git(...args: string[]): Promise<string> {
    const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
    const { stdout } = await execute('git', [...identity, '-c', 'commit.gpgSign=false', ...args], {
      cwd: repo,
    });
    return stdout;
  }
  /** Make one empty commit with `subject` and return its SHA. */
  async function commit(subject: string): Promise<string> {
    await git('commit', '--quiet', '--allow-empty', '-m', subject);
    return (await git('rev-parse', 'HEAD')).trim();
  }

  let base: string;
  beforeEach(async () => {
    await git('init', '--quiet');
    const hooks = join(root, 'empty-hooks');
    await mkdir(hooks);
    await git('config', '--local', 'core.hooksPath', hooks);
    base = await commit('Initial commit');
  });

  /** One change-log entry per commit the mapper's prompt lists (`- <sha>: <subject>`). */
  const entries = (request: HarnessRequest) => ({
    changes: promptOf(request)
      .split('\n')
      .filter((line) => /^- [0-9a-f]{40}: /u.test(line))
      .map((line) => ({
        kind: 'feature',
        summary: line.slice(44),
        shas: [line.slice(2, 42)],
        userVisible: true,
        migration: null,
      })),
  });

  it('lists the range, describes each commit by its subject and reduces to notes', async () => {
    const shas = [
      await commit('Add the --json flag'),
      await commit('Fix the parser'),
      await commit('Document export'),
    ];
    const first = shas[0] ?? '';
    const harness = scripted({
      [`notes/map/${first}/part`]: entries,
      'notes/reduce': () => '## Features\n\n- Add the --json flag',
    });
    const result = await replayAfterTail(changelog, { range: `${base}..HEAD` }, harness);
    expect(result.output).toMatchObject({
      result: '## Features\n\n- Add the --json flag',
      coverage: { covered: shas, missing: [] },
      chunks: 1,
      failedChunks: 0,
      failures: 0,
      status: 'complete',
    });
    expect(result.output?.parts).toHaveLength(1);
    expect(result.output?.parts[0]?.keys).toEqual(shas);
    expect(result.output?.parts[0]?.value.changes.map((change) => change.summary)).toEqual([
      'Add the --json flag',
      'Fix the parser',
      'Document export',
    ]);
    roundTrip(std.patterns.MapReduceResult(std.types.Changes), result.output);
    expect(harness.ids()).toEqual([`notes/map/${first}/part`, 'notes/reduce']);
    // One git log read lists the commits with their subjects.
    expect(Object.keys(result.steps)).toContain('commits');
    expect(Object.keys(result.steps)).not.toContain('subjects');
    expect(runner.runs).toBe(1);
    // Commits are listed oldest first, each once, as its SHA and subject.
    const map = harness.prompt(`notes/map/${first}/part`);
    expect(map).toContain(
      `- ${shas[0] ?? ''}: Add the --json flag\n- ${shas[1] ?? ''}: Fix the parser\n- ${shas[2] ?? ''}: Document export`,
    );
    expect(map).toContain(`Turn these commits from ${base}..HEAD into change-log entries`);
    const reduce = harness.prompt('notes/reduce');
    expect(reduce.startsWith('Write Markdown release notes')).toBe(true);
    expect(reduce).toContain('"summary": "Fix the parser"');
    // The mapper is the read-only Scribe and the reducer the tool-free Writer.
    const mapper = harness.calls.find((call) => call.stepId.endsWith('/part'));
    expect(mapper?.options).toMatchObject({ tools: ['Read', 'Grep', 'Glob'] });
    const reducer = harness.calls.find((call) => call.stepId === 'notes/reduce');
    expect(reducer?.options).toMatchObject({ tools: [] });
  });

  it('reports the commits of a failed chunk as missing and records nothing for an empty range', async () => {
    const shas: string[] = [];
    for (let n = 0; n < 22; n++) shas.push(await commit(`Change ${String(n)}`));
    const second = shas[20] ?? '';
    const harness = scripted({
      [`notes/map/${shas[0] ?? ''}/part`]: entries,
      [`notes/map/${second}/part`]: () => new Error('mapper crashed'),
      'notes/reduce': () => 'Partial notes',
    });
    const result = await replayAfterTail(changelog, { range: `${base}..HEAD` }, harness);
    expect(result.output).toMatchObject({
      result: 'Partial notes',
      coverage: { covered: shas.slice(0, 20), missing: shas.slice(20) },
      chunks: 2,
      failedChunks: 1,
      failures: 1,
      status: 'degraded',
    });
    expect(harness.count(`notes/map/${second}/part`)).toBe(1);
    expect(harness.prompt('notes/reduce')).toContain(
      `### Not covered\n\n- ${shas[20] ?? ''}\n- ${shas[21] ?? ''}`,
    );

    const idle = scripted({});
    const empty = await runWorkflow(changelog, {
      ...options(idle, 'empty'),
      input: { range: 'HEAD..HEAD' },
    });
    expect(empty.output).toEqual({
      result: '',
      parts: [],
      coverage: { covered: [], missing: [] },
      chunks: 0,
      failedChunks: 0,
      failures: 0,
      status: 'complete',
    });
    expect(idle.calls).toHaveLength(0);
  });
});

describe('std-plan-and-build', () => {
  const task = (id: string, dependsOn: string[] = []): std.types.Task => ({
    id,
    title: `Build ${id}`,
    description: `Implement ${id}.`,
    acceptance: [`${id} works`],
    dependsOn,
    size: 'S',
  });
  const tasks = [task('T1'), task('T2', ['T1']), task('T3'), task('T4', ['T2'])];
  const report = (id: string): std.types.WorkReport => ({
    status: 'done',
    summary: `Built ${id}.`,
    files: [`src/${id}.ts`],
    blockers: [],
    notes: [],
  });
  const goal = 'Add a --json flag to the export command.';

  it('plans, then runs each task once its dependencies are done', async () => {
    const harness = scripted({
      'plan/plan': () => ({ tasks }),
      'build/wave/0/T1/work': () => report('T1'),
      'build/wave/0/T3/work': () => report('T3'),
      'build/wave/1/T2/work': () => report('T2'),
      'build/wave/2/T4/work': () => report('T4'),
    });
    const result = await replayAfterTail(planAndBuild, { goal, maxTasks: 5 }, harness);
    expect(result.output).toEqual({
      status: 'complete',
      tasks,
      reports: [report('T1'), report('T2'), report('T3'), report('T4')],
    });
    // One task at a time: the calls run in wave order, and in task order within a wave.
    expect(harness.ids()).toEqual([
      'plan/plan',
      'build/wave/0/T1/work',
      'build/wave/0/T3/work',
      'build/wave/1/T2/work',
      'build/wave/2/T4/work',
    ]);
    expect(harness.prompt('plan/plan')).toContain('at most 5 tasks');
    expect(harness.prompt('plan/plan')).toContain(goal);
    const work = harness.prompt('build/wave/1/T2/work');
    expect(work).toBe(std.patterns.taskCall(task('T2', ['T1']), goal).prompt);
    expect(work).toContain(`### Goal\n\n${goal}`);
    const models = harness.calls.map((call) => (call.options as { model?: string }).model);
    expect(models).toEqual([
      std.roles.Planner.model,
      ...Array.from({ length: 4 }, () => std.roles.Mechanic.model),
    ]);
    expect(harness.calls[1]?.options).toMatchObject({ tools: std.roles.Mechanic.tools });
  });

  it('fails a task reported as not done, so its dependents are skipped', async () => {
    const blocked: std.types.WorkReport = {
      ...report('T1'),
      status: 'blocked',
      summary: 'The export command has no argument parser.',
    };
    const harness = scripted({
      'plan/plan': () => ({ tasks }),
      'build/wave/0/T1/work': () => blocked,
      'build/wave/0/T3/work': () => report('T3'),
    });
    const result = await replayAfterTail(planAndBuild, { goal, maxTasks: 8 }, harness);
    expect(result.output).toEqual({
      status: 'degraded',
      tasks,
      reports: [null, null, report('T3'), null],
    });
    expect(harness.ids()).toEqual(['plan/plan', 'build/wave/0/T1/work', 'build/wave/0/T3/work']);
    // Wave 0 runs T1 and T3; T1's failure is journaled with the report's summary.
    expect(result.maps?.['build/wave/0']?.items[0]?.outcome).toMatchObject({
      ok: false,
      error: { message: 'T1 is blocked: The export command has no argument parser.' },
    });
  });

  it('rehearses past the planner with the shipped fixture', async () => {
    const file = new URL('../examples/patterns/std-plan-and-build.fixtures.json', import.meta.url);
    const fixtures = parseHarnessFixtures(JSON.parse(await readFile(file, 'utf8')));
    const result = await runWorkflow(planAndBuild, {
      ...runOptions(root, 'fixture'),
      cwd: repo,
      harness: new FixtureHarness(fixtures),
      input: { goal },
    });
    expect(result.output).toMatchObject({ status: 'complete', tasks: [{ id: 'T1' }, {}, {}] });
    expect(Object.keys(result.steps).filter((id) => id.endsWith('/work'))).toEqual([
      'build/wave/0/T1/work',
      'build/wave/1/T2/work',
      'build/wave/1/T3/work',
    ]);
  });

  it('skips the dependents of a failed task and does not retry it on resume', async () => {
    const harness = scripted({
      'plan/plan': () => ({ tasks }),
      'build/wave/0/T1/work': () => new Error('mechanic crashed'),
      'build/wave/0/T3/work': () => report('T3'),
    });
    const result = await replayAfterTail(planAndBuild, { goal, maxTasks: 8 }, harness);
    expect(result.output).toEqual({
      status: 'degraded',
      tasks,
      reports: [null, null, report('T3'), null],
    });
    expect(harness.ids()).toEqual(['plan/plan', 'build/wave/0/T1/work', 'build/wave/0/T3/work']);
    expect(harness.count('build/wave/0/T1/work')).toBe(1);
  });

  it('defaults to at most eight tasks', () => {
    expect(planAndBuild.input.parse({ goal })).toEqual({ goal, maxTasks: 8 });
  });
});
