import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  assertCompleted,
  ExecError,
  writeAnswer,
  FixtureHarness,
  HarnessError,
  NodeProcessRunner,
  parseHarnessFixtures,
  readRun,
  RunInterruptedError,
  runWorkflow,
  stepId,
  z,
  type ExecResult,
  type Harness,
  type ProcessRunRequest,
  type HarnessInvocation,
  type HarnessRequest,
  type HarnessResponse,
  type WorkflowClock,
  type WorkflowDefinition,
} from '../src/index.js';
import cross from '../examples/patterns/cross-harness.workflow.js';
import tolerant from '../examples/patterns/tolerant-panel.workflow.js';
import hunt from '../examples/patterns/loop-until-dry.workflow.js';
import pipeline from '../examples/patterns/per-item-pipeline.workflow.js';
import revise from '../examples/patterns/review-revise.workflow.js';
import helper from '../examples/patterns/reusable-helper.workflow.js';
import worktrees from '../examples/patterns/worktrees.workflow.js';
import polling from '../examples/patterns/polling.workflow.js';
import salvage from '../examples/patterns/salvage.workflow.js';
import latch from '../examples/patterns/latch.workflow.js';
import extraction from '../examples/patterns/work-then-extract.workflow.js';
import rehearse from '../examples/patterns/rehearse.workflow.js';
import humanReview from '../examples/patterns/human-review.workflow.js';

it('replays a human-reviewed plan and its answer after a tail failure', async () => {
  const harness = new Fake(() => 'The saved plan');
  const workflow = tailFailure(humanReview);
  const setup = { ...options(), harness };
  const waiting = await runWorkflow(workflow, {
    ...setup,
    input: { task: 'Review retries', revision: 'r1' },
  });
  expect(waiting.status).toBe('suspended');
  await writeAnswer({
    ...setup,
    stepId: 'approve/r1',
    value: { approved: true },
    by: 'human:fixture',
  });
  await expect(runWorkflow(workflow, { ...setup, resume: true })).rejects.toThrow(
    'Injected tail failure',
  );
  const result = await runWorkflow(workflow, { ...setup, resume: true });
  assertCompleted(result);
  expect(result.output).toEqual({ approved: true, plan: 'The saved plan' });
  expect(harness.calls).toHaveLength(1);
  expect(result.steps['approve/r1']?.attempts).toBe(1);
});

let root: string;
const execute = promisify(execFile);
const options = () => ({
  runId: 'pattern',
  cwd: root,
  stateDir: join(root, 'state'),
  fingerprint: 'patterns-v1',
  agentLimit: 4,
});
class Fake implements Harness {
  public readonly kind = 'pattern-fixture';
  public readonly calls: HarnessRequest[] = [];
  public constructor(
    private readonly reply: (
      request: HarnessRequest,
      invocation: HarnessInvocation,
    ) => string | Promise<string>,
  ) {}
  public async invoke(
    request: HarnessRequest,
    invocation: HarnessInvocation,
  ): Promise<HarnessResponse> {
    invocation.signal.throwIfAborted();
    this.calls.push(request);
    return {
      text: await this.reply(request, invocation),
      sessionId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
    };
  }
  public count(stepId: string): number {
    return this.calls.filter((call) => call.call.stepId === stepId).length;
  }
}
function tailFailure<I, O>(workflow: WorkflowDefinition<I, O>): WorkflowDefinition<I, O> {
  return {
    ...workflow,
    async run(ctx, input) {
      const output = await workflow.run(ctx, input);
      await ctx.step('probe/tail', {
        input: null,
        schema: z.null(),
        run({ attempt }) {
          if (attempt === 1) throw new Error('Injected tail failure');
          return null;
        },
      });
      return output;
    },
  };
}
async function replayAfterTail<I, O>(workflow: WorkflowDefinition<I, O>, input: I, harness: Fake) {
  const wrapped = tailFailure(workflow);
  await expect(runWorkflow(wrapped, { ...options(), input, harness })).rejects.toThrow(
    'Injected tail failure',
  );
  const count = harness.calls.length;
  const resumed = await runWorkflow(wrapped, { ...options(), resume: true, harness });
  expect(harness.calls).toHaveLength(count);
  const again = await runWorkflow(wrapped, { ...options(), resume: true, harness });
  expect(again.steps).toEqual(resumed.steps);
  return resumed;
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'choir-pattern-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('cross-harness fan-in drains a slow sibling and resumes only the failed reviewer', async () => {
  let siblingStarted!: () => void;
  const ready = new Promise<void>((resolve) => {
    siblingStarted = resolve;
  });
  const harness = new Fake(async (request, { signal }) => {
    if (request.harness === 'codex') {
      siblingStarted();
      await delay(20, undefined, { signal });
      return JSON.stringify({ approved: true, reason: 'slow saved review' });
    }
    await ready;
    if (request.call.attempt === 1) throw new Error('Reviewer unavailable');
    return JSON.stringify({ approved: false, reason: 'needs revision' });
  });
  const input = {
    topic: 'typed workflows',
    reviewers: [
      { id: 'fast', harness: 'claude' as const, lens: 'clarity' },
      { id: 'slow', harness: 'codex' as const, lens: 'correctness' },
    ],
  };
  await expect(runWorkflow(cross, { ...options(), input, harness })).rejects.toThrow(
    'Reviewer unavailable',
  );
  expect((await readRun(options())).steps['panel/slow/verdict']?.status).toBe('completed');
  const result = await runWorkflow(cross, { ...options(), resume: true, harness });
  assertCompleted(result);
  expect(result.output.map((value) => value.reason)).toEqual([
    'needs revision',
    'slow saved review',
  ]);
  expect(harness.count('panel/fast/verdict')).toBe(2);
  expect(harness.count('panel/slow/verdict')).toBe(1);
});

it('tolerant panel freezes a failed vote even if the reviewer would heal on resume', async () => {
  let failedOnce = false;
  const harness = new Fake((request) => {
    if (request.call.stepId === 'panel/0/review' && !failedOnce) {
      failedOnce = true;
      throw new Error('Review failed');
    }
    return 'saved vote';
  });
  const result = await replayAfterTail(tolerant, { topic: 't', lenses: ['a', 'b', 'c'] }, harness);
  expect(result.output).toEqual({ quorum: true, answers: ['saved vote', 'saved vote'] });
  expect(harness.count('panel/0/review')).toBe(1);
  expect(result.maps?.['panel']?.status).toBe('completed');
});

it('loop until dry keeps the known-findings prompt stable across a middle-round failure', async () => {
  const harness = new Fake((request) => {
    if (request.call.stepId === 'hunt/1' && request.call.attempt === 1)
      throw new Error('Transient hunt failure');
    const findings =
      request.call.stepId === 'hunt/0'
        ? ['one', 'one']
        : request.call.stepId === 'hunt/1'
          ? ['one', 'two']
          : [];
    return JSON.stringify({ findings });
  });
  await expect(
    runWorkflow(hunt, { ...options(), input: { topic: 't', rounds: 5 }, harness }),
  ).rejects.toThrow('Transient hunt failure');
  const result = await runWorkflow(hunt, { ...options(), resume: true, harness });
  expect(result.output).toEqual(['one', 'two']);
  expect(harness.count('hunt/0')).toBe(1);
  expect(harness.count('hunt/1')).toBe(2);
  expect(
    harness.calls.filter((r) => r.call.stepId === 'hunt/1').map((r) => r.options.prompt),
  ).toEqual(['t; list new findings beyond ["one"].', 't; list new findings beyond ["one"].']);
  expect(harness.count('hunt/3')).toBe(0);
});

it('per-item pipeline resumes the failed stage and reuses sibling stages', async () => {
  const harness = new Fake((request) => {
    if (request.call.stepId === 'fix/0/implement' && request.call.attempt === 1)
      throw new Error('Temporary implementation failure');
    return request.call.stepId.endsWith('/check')
      ? JSON.stringify({ approved: true })
      : request.options.prompt;
  });
  await expect(
    runWorkflow(pipeline, { ...options(), input: { tasks: ['one', 'two'] }, harness }),
  ).rejects.toThrow('Temporary implementation failure');
  const result = await runWorkflow(pipeline, { ...options(), resume: true, harness });
  expect(result.output).toHaveLength(2);
  assertCompleted(result);
  expect(result.output.every((entry) => entry.approved)).toBe(true);
  expect(harness.count('fix/0/plan')).toBe(1);
  expect(harness.count('fix/0/implement')).toBe(2);
  expect(harness.count('fix/1/check')).toBe(1);
});

it('bounded review/revise returns exhaustion as data and replays without new reviews', async () => {
  const harness = new Fake((request) =>
    request.harness === 'codex'
      ? JSON.stringify({ approved: false, feedback: 'Please clarify.' })
      : 'revised draft',
  );
  const result = await replayAfterTail(revise, { draft: 'initial', rounds: 2 }, harness);
  expect(result.output).toEqual({ approved: false, draft: 'revised draft' });
  expect(harness.calls.map((request) => request.call.stepId)).toEqual([
    'review/0',
    'revise/0',
    'review/1',
  ]);
});

it('reusable helper gives repeated leaf IDs distinct stable file scopes', async () => {
  const harness = new Fake((request) => request.options.prompt);
  const result = await replayAfterTail(helper, { paths: ['src/a.ts', 'src/b.ts'] }, harness);
  expect(result.output).toEqual([
    'Read and review this file: src/a.ts',
    'Read and review this file: src/b.ts',
  ]);
  const ids = harness.calls.map((request) => request.call.stepId);
  expect(new Set(ids).size).toBe(2);
  expect(ids.every((id) => id.endsWith('/review/verdict'))).toBe(true);
});

// measured: 0.7 s alone, 2.1 s in the full coverage run (dominated by real Git processes)
it('worktree recipe integrates pinned edits and replays without repeating writers', async () => {
  const repo = join(root, 'repo'),
    worktreeRoot = join(root, 'worktrees');
  await mkdir(repo);
  await execute('git', ['init', '--quiet'], { cwd: repo });
  const hooks = join(root, 'empty-hooks');
  await mkdir(hooks);
  await execute('git', ['config', '--local', 'core.hooksPath', hooks], { cwd: repo });
  await execute(
    'git',
    [
      '-c',
      'commit.gpgSign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'base',
    ],
    { cwd: repo },
  );
  const harness = new Fake(async (request) => {
    await writeFile(
      join(request.cwd, `${request.options.prompt.endsWith('first') ? 'first' : 'second'}.txt`),
      request.options.prompt,
    );
    return request.cwd;
  });
  const workflow = tailFailure(worktrees);
  const setup = {
    ...options(),
    cwd: repo,
    grants: ['editor'],
    harness,
    processRunner: new NodeProcessRunner(),
    worktrees: { root: worktreeRoot },
  };
  await expect(
    runWorkflow(workflow, {
      ...setup,
      input: { items: ['first', 'second'] },
    }),
  ).rejects.toThrow('Injected tail failure');
  const result = await runWorkflow(workflow, { ...setup, resume: true });
  expect(harness.calls).toHaveLength(2);
  assertCompleted(result);
  expect(result.output.conflicts).toEqual([]);
  expect(
    (await execute('git', ['show', `${result.output.commit}:first.txt`], { cwd: repo })).stdout,
  ).toBe('Implement: first');
  expect(
    (await execute('git', ['show', `${result.output.commit}:second.txt`], { cwd: repo })).stdout,
  ).toBe('Implement: second');
  expect((await execute('git', ['status', '--porcelain'], { cwd: repo })).stdout).toBe('');
  expect(
    (await execute('git', ['worktree', 'list', '--porcelain'], { cwd: repo })).stdout.match(
      /^worktree /gmu,
    ),
  ).toHaveLength(1);
}, 10_000);

it('polling resumes after cancellation with its original deadline and times out as data', async () => {
  const file = join(root, 'checks.txt');
  await writeFile(file, 'pending');
  const controller = new AbortController();
  const harness = new Fake(() => {
    throw new Error('Polling must not call agents');
  });
  await expect(
    runWorkflow(polling, {
      ...options(),
      input: { file, ms: 1 },
      harness,
      signal: controller.signal,
      onEvent(event) {
        if (event.type === 'step.waiting' && event.stepId === 'wait') controller.abort();
      },
    }),
  ).rejects.toThrow();
  const interrupted = await readRun(options());
  expect(interrupted.status).toBe('cancelled');
  const result = await runWorkflow(polling, { ...options(), resume: true, harness });
  expect(result.output).toBe('timeout');
  expect(result.steps['started-at']).toEqual(interrupted.steps['started-at']);
  expect(result.steps['wait']?.attempts).toBe(1);
  expect(harness.calls).toHaveLength(0);
});

it('polling tolerates a status file that is briefly missing between checks', async () => {
  const file = join(root, 'checks.txt');
  await writeFile(file, 'pending');
  const harness = new Fake(() => {
    throw new Error('Polling must not call agents');
  });
  const running = runWorkflow(polling, { ...options(), input: { file, ms: 60_000 }, harness });
  /** Wait until the live run's saved wait progress satisfies `ready`. */
  const progress = async (
    ready: (
      wait: NonNullable<Awaited<ReturnType<typeof readRun>>['steps'][string]['wait']>,
    ) => boolean,
  ): Promise<void> => {
    for (;;) {
      const wait = (await readRun(options()).catch(() => undefined))?.steps['wait']?.wait;
      if (wait && ready(wait)) return;
      await delay(5);
    }
  };
  await progress((wait) => wait.checks >= 1);
  // The producer deletes the file before rewriting it; a check in between sees ENOENT.
  await rm(file);
  await progress((wait) => wait.lastError !== undefined);
  await writeFile(file, 'success');
  const result = await running;
  expect(result.output).toBe('success');
  const step = result.steps['wait'];
  expect(step?.error).toBeNull();
  expect(step?.wait).not.toHaveProperty('lastError');
  expect(step?.wait?.note).toEqual({ state: 'pending' });
  expect(harness.calls).toHaveLength(0);
});

it('salvage forks two completed calls without mutating the source checkpoint', async () => {
  const harness = new Fake((request) => {
    if (request.call.runId === 'pattern' && request.call.stepId === 'answer/2')
      throw new Error('Third call unavailable');
    return request.options.prompt;
  });
  await expect(
    runWorkflow(salvage, { ...options(), input: { topics: ['a', 'b', 'c'] }, harness }),
  ).rejects.toThrow('Third call unavailable');
  const file = join(root, 'state/pattern/run.json'),
    before = await readFile(file, 'utf8');
  const result = await runWorkflow(salvage, {
    ...options(),
    runId: 'forked',
    forkFrom: { runId: 'pattern' },
    harness,
  });
  expect(result.output).toEqual(['a', 'b', 'c']);
  expect(
    harness.calls
      .filter((request) => request.call.runId === 'forked')
      .map((request) => request.call.stepId),
  ).toEqual(['answer/2']);
  expect(await readFile(file, 'utf8')).toBe(before);
  await runWorkflow(salvage, { ...options(), runId: 'forked', resume: true, harness });
  expect(harness.calls).toHaveLength(4);
});

it('latch preserves the fallback decision without repaying a healed primary', async () => {
  let primaryFailed = false;
  const harness = new Fake((request) => {
    if (request.call.stepId === 'primary' && !primaryFailed) {
      primaryFailed = true;
      throw new Error('Primary failed');
    }
    return request.call.stepId === 'primary' ? 'would heal' : 'fallback answer';
  });
  const result = await replayAfterTail(latch, { topic: 't' }, harness);
  expect(result.output).toEqual({ source: 'fallback', answer: 'fallback answer' });
  expect(harness.count('primary')).toBe(1);
  expect(result.steps['primary']?.status).toBe('settled-failed');
});

it('latch retries a transient overload before choosing the fallback', async () => {
  const harness = new Fake((request) => {
    if (request.call.stepId === 'primary' && request.call.attempt === 1)
      throw new HarnessError({
        harness: 'claude',
        kind: 'overloaded',
        exit: { code: 1, signal: null },
        failure: null,
        reason: 'overloaded',
        stderr: '',
        stdout: '',
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
      });
    return request.call.stepId === 'primary' ? 'primary answer' : 'fallback answer';
  });
  const result = await runWorkflow(latch, { ...options(), input: { topic: 't' }, harness });
  expect(result.output).toEqual({ source: 'primary', answer: 'primary answer' });
  expect(harness.count('primary')).toBe(2);
  expect(harness.count('fallback')).toBe(0);
});

it('work then extract retries only extraction after local schema rejection', async () => {
  const harness = new Fake((request) =>
    request.call.stepId === 'work'
      ? 'Expensive saved report'
      : JSON.stringify(
          request.call.attempt === 1
            ? { summary: 'bad', ready: 'not a boolean' }
            : { summary: 'ready', ready: true },
        ),
  );
  await expect(
    runWorkflow(extraction, {
      ...options(),
      input: { task: 'Read and summarize the project' },
      harness,
    }),
  ).rejects.toThrow();
  const result = await runWorkflow(extraction, { ...options(), resume: true, harness });
  expect(result.output).toEqual({ summary: 'ready', ready: true });
  expect(harness.count('work')).toBe(1);
  expect(harness.count('extract')).toBe(2);
});

it('rehearses and resumes actual fixture data with no native harness', async () => {
  const fixtures = parseHarnessFixtures(
    JSON.parse(
      await readFile(
        new URL('../examples/patterns/rehearse.fixtures.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const fixture = new FixtureHarness(fixtures);
  let calls = 0;
  const harness: Harness = {
    kind: fixture.kind,
    invoke(request, invocation) {
      calls++;
      return fixture.invoke(request, invocation);
    },
  };
  const workflow = tailFailure(rehearse);
  await expect(
    runWorkflow(workflow, { ...options(), input: { topic: 't' }, harness }),
  ).rejects.toThrow('Injected tail failure');
  const result = await runWorkflow(workflow, { ...options(), resume: true, harness });
  expect(result.output).toEqual({ approved: true });
  expect(calls).toBe(2);
});

it('polling observes readiness without creating one checkpointed step per poll', async () => {
  const file = join(root, 'checks.txt');
  await writeFile(file, 'pending');
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const harness = new Fake(() => {
    throw new Error('Polling must not call agents');
  });
  const running = runWorkflow(polling, {
    ...options(),
    input: { file, ms: 10000 },
    harness,
    onEvent(event) {
      if (event.type === 'step.waiting' && event.stepId === 'wait') started();
    },
  });
  await ready;
  await delay(120);
  await writeFile(`${file}.next`, 'success');
  await rename(`${file}.next`, file);
  const result = await running;
  expect(result.output).toBe('success');
  expect(Object.keys(result.steps)).toEqual(['started-at', 'wait']);
  const resumed = await runWorkflow(polling, { ...options(), resume: true, harness });
  expect(resumed.steps).toEqual(result.steps);
});

it('bounded review/revise exits immediately when approved', async () => {
  const harness = new Fake(() => JSON.stringify({ approved: true, feedback: 'Ready' }));
  const result = await replayAfterTail(revise, { draft: 'initial', rounds: 5 }, harness);
  expect(result.output).toEqual({ approved: true, draft: 'initial' });
  expect(harness.calls).toHaveLength(1);
});

it('replays durable command verdicts and gh JSON snapshots after a tail failure', async () => {
  const verdict = (await import('../examples/patterns/command-verdict.workflow.js')).default;
  const github = (await import('../examples/patterns/github-snapshot.workflow.js')).default;
  // Recorded gh responses (test/fixtures/github), chosen by the read each argv performs.
  const recorded = (argv: readonly string[]): string => {
    const query = argv.find((arg) => arg.startsWith('query=')) ?? '';
    const file = !query
      ? 'code-scanning-alerts.json'
      : query.includes('viewer {')
        ? 'repo-info.json'
        : query.includes('reviewThreads(')
          ? 'review-threads.json'
          : query.includes('pullRequests(')
            ? 'pr-list.json'
            : query.includes('issue(number')
              ? 'issue-view-comments.json'
              : 'pr-view.json';
    return readFileSync(new URL(`./fixtures/github/${file}`, import.meta.url), 'utf8');
  };
  for (const [name, workflow, input, live] of [
    ['verdict', verdict, { argv: ['fake', 'test'] }, 1],
    ['github', github, { repo: 'enterprise.test/owner/repo', pr: 329 }, 6],
  ] as const) {
    const argvs: (readonly string[])[] = [];
    const wrapped = tailFailure(workflow as WorkflowDefinition<unknown, unknown>);
    const setup = {
      ...options(),
      runId: name,
      input,
      processRunner: {
        run: (request: ProcessRunRequest) => {
          const argv = request.command as readonly string[];
          argvs.push(argv);
          return Promise.resolve({
            code: request.schema ? 0 : 1,
            signal: null,
            stdout: request.schema ? recorded(argv) : '',
            stderr: '',
            truncated: false,
            durationMs: 1,
          });
        },
      },
    };
    await expect(runWorkflow(wrapped, setup)).rejects.toThrow('Injected tail failure');
    expect(argvs).toHaveLength(live);
    const resumed = await runWorkflow(wrapped, { ...setup, resume: true });
    expect(resumed.output).toEqual(
      name === 'verdict'
        ? { green: false, code: 1 }
        : {
            head: '9fd831de10de270b1f355f7f7e0c56e2c36ca864',
            ci: 'success',
            scanning: 'ok: 4 alerts',
            issue: 'Add a static durability lint (QC001-QC006) to workflow validate and execute',
            unresolved: 0,
            stacked: [329],
          },
    );
    // The resume replays every completed read: no gh runs again.
    expect(argvs).toHaveLength(live);
    if (name === 'github')
      for (const argv of argvs)
        expect(argv.slice(0, 4)).toEqual(['gh', 'api', '--hostname', 'enterprise.test']);
  }
});

it('settles a command-verdict timeout and replays it without running the command again', async () => {
  const verdict = (await import('../examples/patterns/command-verdict.workflow.js')).default;
  let calls = 0;
  const setup = {
    ...options(),
    runId: 'verdict-timeout',
    input: { argv: ['fake', 'test'] as [string, ...string[]] },
    processRunner: {
      run: () => {
        calls++;
        return Promise.reject(
          new ExecError('Command timed out.', 'timeout', {
            code: null,
            signal: 'SIGTERM',
            stdout: 'partial',
            stderr: '',
            truncated: false,
            durationMs: 1,
          }),
        );
      },
    },
  };
  const wrapped = tailFailure(verdict);
  await expect(runWorkflow(wrapped, setup)).rejects.toThrow('Injected tail failure');
  expect((await readRun(setup)).steps['prove']?.settledError).toMatchObject({
    kind: 'timeout',
    code: null,
    signal: 'SIGTERM',
    stdoutTail: 'partial',
  });
  const resumed = await runWorkflow(wrapped, { ...setup, resume: true });
  expect(resumed.output).toEqual({ green: false, code: null });
  expect(calls).toBe(1);
});

it('replays file publication and mutation-guard recipes without repeating mutations', async () => {
  const update = (await import('../examples/patterns/file-update.workflow.js')).default;
  const guard = (await import('../examples/patterns/guard-mutation.workflow.js')).default;
  const { NodeProcessRunner } = await import('../src/index.js');
  await execute('git', ['init', '-q'], { cwd: root });
  const file = join(root, 'file');
  await writeFile(file, 'baseline\r\n');
  const updateSetup = { ...options(), input: { file, prefix: 'new\r\n' } };
  const wrappedUpdate = tailFailure(update);
  await expect(runWorkflow(wrappedUpdate, updateSetup)).rejects.toThrow('Injected tail failure');
  await runWorkflow(wrappedUpdate, { ...updateSetup, resume: true });
  expect(await readFile(file, 'utf8')).toBe('new\r\nbaseline\r\n');
  const wrappedGuard = tailFailure(guard);
  const guardSetup = {
    ...options(),
    runId: 'guard',
    input: {
      file,
      argv: [
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync('file','mutation');process.exitCode=1;",
      ],
    },
    processRunner: new NodeProcessRunner(),
  };
  await expect(runWorkflow(wrappedGuard, guardSetup)).rejects.toThrow('Injected tail failure');
  const resumed = await runWorkflow(wrappedGuard, { ...guardSetup, resume: true });
  expect(resumed.output).toBe(1);
  expect(await readFile(file, 'utf8')).toBe('new\r\nbaseline\r\n');
});

// ---------------------------------------------------------------------------------------------
// GitHub recipes over recorded gh responses (test/fixtures/github), answered in process by the
// step or wait ID each command runs under; nothing reaches github.com.

const recordedGh = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/github/${file}`, import.meta.url), 'utf8'));
const answered = (stdout: unknown): Promise<ExecResult> =>
  Promise.resolve({
    code: 0,
    signal: null,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr: '',
    truncated: false,
    durationMs: 1,
  });
/** A cancellable real-time sleep for a clock moved ahead of the wall clock. */
const realSleep: WorkflowClock['sleep'] = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Clock cancelled'));
      },
      { once: true },
    );
  });

interface RecordedPr {
  data: {
    repository: {
      pullRequest: {
        number: number;
        headRefOid: string;
        commits: {
          nodes: {
            commit: {
              statusCheckRollup: {
                contexts: { nodes: { name: string; status: string; conclusion: string | null }[] };
              };
            };
          }[];
        };
      };
    };
  };
}
/** The recorded pull request (#329) projected to what `pr.head` reads, at `sha`, with "Tests". */
function prHeadAt(sha: string, tests: 'pending' | 'failure' | 'success'): unknown {
  const pr = (recordedGh('pr-view.json') as RecordedPr).data.repository.pullRequest;
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup.contexts.nodes ?? [];
  const nodes = [
    ...contexts,
    {
      __typename: 'CheckRun',
      name: 'Tests',
      status: tests === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: tests === 'pending' ? null : tests.toUpperCase(),
      detailsUrl: 'https://github.com/octo-org/quiet-choir/actions/runs/37078499704/job/1',
      checkSuite: { workflowRun: { databaseId: 37078499704 } },
    },
  ];
  const rollup = { state: 'PENDING', contexts: { pageInfo: { hasNextPage: false }, nodes } };
  return {
    data: {
      repository: {
        pullRequest: {
          number: pr.number,
          state: 'OPEN',
          headRefOid: sha,
          commits: { nodes: [{ commit: { oid: sha, statusCheckRollup: rollup } }] },
        },
      },
    },
  };
}

it('CI gate suspends on a pending check, fixes and pushes once under SHA-keyed IDs, and replays', async () => {
  const gate = (await import('../examples/patterns/ci-gate.workflow.js')).default;
  const first = (recordedGh('pr-view.json') as RecordedPr).data.repository.pullRequest.headRefOid;
  const second = '5b4b02c0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70';
  const [ciFirst, ciSecond] = [stepId('ci', first), stepId('ci', second)];
  const log: string[] = [];
  const checks = new Map<string, number>();
  const processRunner = {
    run: (request: ProcessRunRequest, { stepId: id }: HarnessInvocation) => {
      log.push(id);
      if (id === 'head') return answered(recordedGh('pr-view.json'));
      if (id === stepId('push', first)) {
        const shell = (request.command as { shell?: string }).shell;
        expect(shell).toContain('git push');
        // Hook output must not reach stdout: only the final rev-parse line is the SHA.
        expect(shell).toMatch(/git push\) >&2 && git rev-parse HEAD$/u);
        return answered(`${second}\n`);
      }
      const n = (checks.get(id) ?? 0) + 1;
      checks.set(id, n);
      if (id === ciFirst) return answered(prHeadAt(first, n === 1 ? 'pending' : 'failure'));
      if (id === ciSecond) return answered(prHeadAt(second, 'success'));
      return Promise.reject(new Error(`Unexpected command ${JSON.stringify(request.command)}`));
    },
  };
  const harness = new Fake(() => 'Fixed the failing test.');
  const workflow = tailFailure(gate);
  const setup = {
    ...options(),
    runId: 'ci-gate',
    input: { repo: 'octo-org/quiet-choir', pr: 329, rounds: 2 },
    processRunner,
    harness,
    grants: ['write'],
  };
  // The first check sees "Tests" pending; the next check is 30 s away, so the run suspends.
  const suspended = await runWorkflow(workflow, setup);
  expect(suspended.status).toBe('suspended');
  expect(log).toEqual(['head', ciFirst]);
  expect(harness.calls).toHaveLength(0);
  // A resume with the clock past nextCheckAt: failure, one fix, one push, then success.
  const clock: WorkflowClock = { now: () => Date.now() + 60_000, sleep: realSleep };
  await expect(runWorkflow(workflow, { ...setup, resume: true, clock })).rejects.toThrow(
    'Injected tail failure',
  );
  expect(log).toEqual(['head', ciFirst, ciFirst, stepId('push', first), ciSecond]);
  expect(harness.calls).toHaveLength(1);
  expect(harness.calls[0]?.call.stepId).toBe(stepId('fix', first));
  expect(JSON.stringify(harness.calls[0]?.options)).toContain(`CI failed on ${first}: Tests.`);
  // The final resume replays the head read, both waits, the fix and the push.
  const result = await runWorkflow(workflow, { ...setup, resume: true });
  assertCompleted(result);
  expect(result.output).toEqual({ status: 'success', sha: second, fixes: 1 });
  expect(log).toHaveLength(5);
  expect(harness.calls).toHaveLength(1);
  expect(Object.keys(result.steps).sort()).toEqual(
    ['head', ciFirst, stepId('fix', first), stepId('push', first), ciSecond, 'probe/tail'].sort(),
  );
  expect(result.steps[ciFirst]?.wait?.checks).toBe(2);
  expect(result.steps[ciSecond]?.wait?.checks).toBe(1);
});

interface RecordedEpic {
  data: { repository: { issue: { subIssues: { nodes: { number: number; state: string }[] } } } };
}
/** A fake gh for the ticket loop: snapshots by ID, the issue with comments, and the close step. */
function ticketGh(closed: readonly number[] = []) {
  const log: string[] = [];
  const epic = (after: boolean) => {
    const raw = recordedGh('epic-snapshot.json') as RecordedEpic;
    for (const item of raw.data.repository.issue.subIssues.nodes)
      if (after && closed.includes(item.number)) item.state = 'CLOSED';
    return raw;
  };
  const processRunner = {
    run: (request: ProcessRunRequest, { stepId: id }: HarnessInvocation) => {
      const argv = request.command as readonly string[];
      const number = Number(argv.find((arg) => arg.startsWith('number='))?.slice(7));
      const patch = argv.includes('PATCH');
      log.push(id === 'close' ? `close ${patch ? 'PATCH' : 'state'}` : id);
      if (id === 'before' || id === 'after') return answered(epic(id === 'after'));
      if (id === 'issue') {
        const pages = recordedGh('issue-view-comments.json') as {
          data: { repository: { issue: Record<string, unknown> } };
        }[];
        for (const page of pages) Object.assign(page.data.repository.issue, { number });
        return answered(pages);
      }
      if (id === 'close' && patch) return answered({ number: 163 });
      if (id === 'close')
        return answered({
          data: { repository: { issue: { number, state: 'OPEN', stateReason: null } } },
        });
      return Promise.reject(new Error(`Unexpected command ${JSON.stringify(argv)}`));
    },
  };
  return { log, processRunner };
}

it('ticket loop resumes after an interruption without repeating its reads or the implement call', async () => {
  const loop = (await import('../examples/patterns/ticket-loop.workflow.js')).default;
  const { log, processRunner } = ticketGh([163]);
  const harness = new Fake(() => 'Implemented.');
  const controller = new AbortController();
  const setup = {
    ...options(),
    runId: 'ticket-163',
    input: { repo: 'octo-org/quiet-choir', epic: 99, ticket: 163 },
    processRunner,
    harness,
    grants: ['write'],
  };
  // Interrupt once the implement call completes, as a worker shutting down would.
  await expect(
    runWorkflow(loop, {
      ...setup,
      signal: controller.signal,
      onEvent(event) {
        if (event.type === 'step.completed' && event.stepId === 'implement')
          controller.abort(new RunInterruptedError('Worker shutting down.'));
      },
    }),
  ).rejects.toThrow();
  const interrupted = await readRun(setup);
  expect(interrupted.status).toBe('suspended');
  expect(log).toEqual(['before', 'issue']);
  expect(harness.calls).toHaveLength(1);
  expect(JSON.stringify(harness.calls[0]?.options)).toContain('Implement #163: ');
  // The resume replays the snapshot, the issue read and the implement call.
  const result = await runWorkflow(loop, { ...setup, resume: true });
  assertCompleted(result);
  expect(result.output).toEqual({ status: 'closed', next: 164 });
  expect(log).toEqual(['before', 'issue', 'close state', 'close PATCH', 'after']);
  expect(harness.calls).toHaveLength(1);
  // A further resume makes no calls at all.
  const again = await runWorkflow(loop, { ...setup, resume: true });
  expect(again.output).toEqual(result.output);
  expect(log).toHaveLength(5);
  expect(harness.calls).toHaveLength(1);
});

it('ticket loop skips a ticket that is no longer the pick and returns the next one', async () => {
  const loop = (await import('../examples/patterns/ticket-loop.workflow.js')).default;
  const { log, processRunner } = ticketGh();
  const harness = new Fake(() => {
    throw new Error('A skipped ticket must not call an agent');
  });
  const result = await runWorkflow(loop, {
    ...options(),
    runId: 'ticket-164',
    input: { repo: 'octo-org/quiet-choir', epic: 99, ticket: 164 },
    processRunner,
    harness,
  });
  assertCompleted(result);
  expect(result.output).toEqual({ status: 'skipped', next: 163 });
  expect(log).toEqual(['before']);
  expect(harness.calls).toHaveLength(0);
});
