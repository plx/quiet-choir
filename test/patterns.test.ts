import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  assertCompleted,
  writeAnswer,
  FixtureHarness,
  parseHarnessFixtures,
  readRun,
  runWorkflow,
  z,
  type Harness,
  type HarnessInvocation,
  type HarnessRequest,
  type HarnessResponse,
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
import { ensureWorktree } from '../examples/patterns/worktree-helper.js';

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
    if (request.provider === 'codex') {
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
      { id: 'fast', provider: 'claude' as const, lens: 'clarity' },
      { id: 'slow', provider: 'codex' as const, lens: 'correctness' },
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
    request.provider === 'codex'
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

async function initRepo(): Promise<string> {
  const repo = join(root, 'repo');
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
  return repo;
}

it('worktree recipe keeps edits across failure/resume and helper refuses changed ownership', async () => {
  const repo = await initRepo(),
    worktreeRoot = join(root, 'worktrees');
  const harness = new Fake(async (request) => {
    await writeFile(join(request.cwd, 'result.txt'), request.options.prompt);
    return request.cwd;
  });
  const workflow = tailFailure(worktrees);
  const setup = { ...options(), cwd: repo, grants: ['editor'], harness };
  await expect(
    runWorkflow(workflow, {
      ...setup,
      input: { repo, root: worktreeRoot, items: ['first', 'second'] },
    }),
  ).rejects.toThrow('Injected tail failure');
  const result = await runWorkflow(workflow, { ...setup, resume: true });
  expect(harness.calls).toHaveLength(2);
  expect(new Set(result.output).size).toBe(2);
  expect((await execute('git', ['status', '--porcelain'], { cwd: repo })).stdout).toBe('');
  assertCompleted(result);
  const first = result.output[0];
  expect(first).toBeDefined();
  if (!first) throw new Error('Missing worktree result');
  const reuse = {
    repo,
    root: worktreeRoot,
    runId: 'pattern',
    item: 'first',
    signal: new AbortController().signal,
  };
  expect(await ensureWorktree(reuse)).toBe(first);
  expect(await readFile(join(first, 'result.txt'), 'utf8')).toBe('Implement: first');
  await execute('git', ['switch', '-c', 'unrelated-branch'], { cwd: first });
  await expect(ensureWorktree(reuse)).rejects.toThrow('Worktree registration changed');
  expect(await readFile(join(first, 'result.txt'), 'utf8')).toBe('Implement: first');
});

it('worktree recipe revalidates ownership before a resumed edit', async () => {
  const repo = await initRepo(),
    worktreeRoot = join(root, 'worktrees');
  const harness = new Fake(() => {
    throw new Error('Editor unavailable');
  });
  const setup = { ...options(), cwd: repo, grants: ['editor'], harness };
  await expect(
    runWorkflow(worktrees, { ...setup, input: { repo, root: worktreeRoot, items: ['first'] } }),
  ).rejects.toThrow('Editor unavailable');
  const edits = harness.count('items/first/edit');
  expect(edits).toBeGreaterThan(0);
  expect((await readRun(setup)).steps['items/first/worktree']?.status).toBe('completed');
  const target = await ensureWorktree({
    repo,
    root: worktreeRoot,
    runId: 'pattern',
    item: 'first',
    signal: new AbortController().signal,
  });
  await execute('git', ['switch', '-c', 'unrelated-branch'], { cwd: target });
  await expect(runWorkflow(worktrees, { ...setup, resume: true })).rejects.toThrow(
    'Worktree registration changed',
  );
  expect(harness.calls).toHaveLength(edits);
});

it('worktree recipe rejects a resume whose root now resolves to a different worktree', async () => {
  const repo = await initRepo();
  const realRoot = join(root, 'real-root'),
    otherRoot = join(root, 'other-root');
  await mkdir(realRoot, { recursive: true });
  await mkdir(otherRoot, { recursive: true });
  const worktreeRoot = join(root, 'worktrees-link');
  await symlink(realRoot, worktreeRoot);
  const harness = new Fake(() => {
    throw new Error('Editor unavailable');
  });
  const setup = { ...options(), cwd: repo, grants: ['editor'], harness };
  await expect(
    runWorkflow(worktrees, { ...setup, input: { repo, root: worktreeRoot, items: ['first'] } }),
  ).rejects.toThrow('Editor unavailable');
  const edits = harness.count('items/first/edit');
  expect(edits).toBeGreaterThan(0);
  expect((await readRun(setup)).steps['items/first/worktree']?.status).toBe('completed');
  await unlink(worktreeRoot);
  await symlink(otherRoot, worktreeRoot);
  await expect(runWorkflow(worktrees, { ...setup, resume: true })).rejects.toThrow(
    'Worktree moved from',
  );
  expect(harness.calls).toHaveLength(edits);
});

it('worktree helper gives the same run and item distinct branches under different roots', async () => {
  const repo = await initRepo();
  const signal = new AbortController().signal;
  const paths = [];
  for (const worktreeRoot of [join(root, 'roots/a'), join(root, 'roots/b')])
    paths.push(
      await ensureWorktree({ repo, root: worktreeRoot, runId: 'pattern', item: 'first', signal }),
    );
  const branches = await Promise.all(
    paths.map(async (cwd) =>
      (await execute('git', ['branch', '--show-current'], { cwd })).stdout.trim(),
    ),
  );
  expect(new Set(branches).size).toBe(2);
  expect(branches.every((branch) => branch.startsWith('quiet-choir-'))).toBe(true);
});

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
