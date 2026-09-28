import { FileRunStore } from '../src/workflow/runtime/run-store.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { ThresholdLogger } from '../src/application/execution.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import { formatRunSummary } from '../src/cli/inspection-view.js';
import assert from 'node:assert/strict';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineWorkflow,
  NodeProcessRunner,
  readRun,
  runWorkflow,
  type Harness,
  type WorktreeHandle,
  type ProcessRunner,
} from '../src/index.js';
import { WorktreeGit } from '../src/worktrees/git.js';
import { RunWorktrees } from '../src/workflow/runtime/worktrees.js';
import { testInvocation } from './harness-invocation.js';

// Every test drives dozens of real Git processes and fsynced checkpoints; under a loaded parallel
// coverage run they exceed the 5s default even though each finishes in about a second alone.
vi.setConfig({ testTimeout: 20_000 });

let directory: string, repo: string, stateDir: string, root: string;
const processRunner = new NodeProcessRunner();
const git = new WorktreeGit(processRunner),
  invocation = testInvocation();
const response = {
  text: 'done',
  sessionId: null,
  usage: { inputTokens: null, outputTokens: null, costUsd: null },
};
async function command(...args: string[]) {
  return git.text(repo, args, invocation);
}
async function commit(message: string) {
  await command('add', '--all');
  await command(
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@localhost',
    'commit',
    '-qm',
    message,
  );
  return command('rev-parse', 'HEAD');
}
function options(runId: string) {
  return { runId, cwd: repo, stateDir, processRunner, worktrees: { root } };
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'choir-worktrees-')));
  repo = join(directory, 'repo');
  stateDir = join(directory, 'runs');
  root = join(directory, 'caches');
  await mkdir(repo);
  await command('init', '-q');
  await writeFile(join(repo, 'file.txt'), 'base\n');
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
  await commit('baseline');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.each(['claude', 'codex'] as const)(
  'isolates %s retries on the pinned base after HEAD moves and replays without Git',
  async (provider) => {
    const base = await command('rev-parse', 'HEAD');
    const directories: string[] = [];
    let fail = true;
    const invoke = vi.fn<Harness['invoke']>(async (request) => {
      expect(request.options).not.toHaveProperty('isolation');
      directories.push(request.cwd);
      const record = await readRun({ stateDir, runId: 'fresh' });
      expect(record.steps['edit']?.worktree?.base).toBe(base);
      await appendFile(join(request.cwd, 'file.txt'), 'edit 1\n');
      if (fail) throw new Error('interrupted writer');
      await appendFile(join(request.cwd, 'file.txt'), 'edit 2\n');
      return response;
    });
    const harness: Harness = { invoke };
    const definition = defineWorkflow({
      version: '1',
      name: 'fresh',
      input: z.null(),
      output: z.string(),
      async run(ctx) {
        const result = await ctx[provider].text('edit', { prompt: 'edit', isolation: 'worktree' });
        if (!result.worktree?.commit) throw new Error('missing captured change');
        return result.worktree.commit;
      },
    });
    await expect(
      runWorkflow(definition, { ...options('fresh'), harness, input: null }),
    ).rejects.toThrow('interrupted writer');
    expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('base\n');
    await writeFile(join(repo, 'file.txt'), 'moved HEAD\n');
    await commit('move head');
    fail = false;
    const result = await runWorkflow(definition, { ...options('fresh'), harness, resume: true });
    expect(result.status).toBe('completed');
    expect(new Set(directories).size).toBe(2);
    expect(await command('show', `${String(result.output)}:file.txt`)).toBe('base\nedit 1\nedit 2');
    expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('moved HEAD\n');
    const change = result.steps['edit']?.worktree;
    expect(change?.files).toEqual([{ path: 'file.txt', status: 'modified' }]);
    assert(change?.ref);
    expect(await command('rev-parse', change.ref)).toBe(result.output);
    expect((await command('worktree', 'list', '--porcelain')).match(/^worktree /gmu)).toHaveLength(
      1,
    );
    const runGit = vi.fn<ProcessRunner['run']>(() => {
      throw new Error('unexpected Git');
    });
    const noGit: ProcessRunner = { run: runGit };
    const replay = await runWorkflow(definition, {
      ...options('fresh'),
      processRunner: noGit,
      harness,
      resume: true,
    });
    expect(replay.output).toBe(result.output);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(runGit).not.toHaveBeenCalled();
  },
);

it('maps monorepo cwd, warns about dirty source files, and snapshots only committed baseline plus edits', async () => {
  await mkdir(join(repo, 'packages', 'a'), { recursive: true });
  await writeFile(join(repo, 'packages', 'a', 'source'), 'tracked');
  await commit('package');
  await writeFile(join(repo, 'dirty'), 'uncommitted');
  let actual = '';
  const harness: Harness = {
    invoke: async (request) => {
      actual = request.cwd;
      expect(await readFile(join(request.cwd, 'source'), 'utf8')).toBe('tracked');
      await expect(readFile(join(request.cwd, '..', '..', 'dirty'))).rejects.toThrow();
      await writeFile(join(request.cwd, 'new'), 'new file');
      return response;
    },
  };
  const definition = defineWorkflow({
    version: '1',
    name: 'mono',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      return (
        await ctx.codex.text('edit', { prompt: 'edit', isolation: 'worktree', cwd: 'packages/a' })
      ).output;
    },
  });
  const run = await runWorkflow(definition, { ...options('mono'), input: null, harness });
  expect(actual.endsWith('/packages/a')).toBe(true);
  expect(actual.startsWith(root)).toBe(true);
  expect(run.worktreeWarnings).toEqual([expect.stringContaining('uncommitted')]);
  expect(run.steps['edit']?.worktree?.files).toEqual([{ path: 'packages/a/new', status: 'added' }]);
});

it('never overlaps worktree administration for concurrent isolated calls', async () => {
  let active = 0,
    overlap = 0;
  const administration = ({ command }: Parameters<ProcessRunner['run']>[0]) =>
    Array.isArray(command) &&
    command.includes('worktree') &&
    ['add', 'list', 'remove'].some((verb) => command.includes(verb));
  const runner: ProcessRunner = {
    async run(request, invocation) {
      if (!administration(request)) return processRunner.run(request, invocation);
      if (++active > 1) overlap++;
      try {
        // Widen the window so unserialized adds would reliably overlap.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return await processRunner.run(request, invocation);
      } finally {
        active--;
      }
    },
  };
  const harness: Harness = {
    invoke: async (request) => {
      await writeFile(join(request.cwd, `${request.call.stepId.replaceAll('/', '-')}.txt`), 'x');
      return response;
    },
  };
  const definition = defineWorkflow({
    version: '1',
    name: 'parallel',
    input: z.null(),
    output: z.number(),
    async run(ctx) {
      const changes = await ctx.map(
        'items',
        ['a', 'b', 'c'],
        { concurrency: 3 },
        async (item) =>
          (await ctx.codex.text('edit', { prompt: item, isolation: 'worktree' })).worktree,
      );
      const merged = await ctx.merge(
        'integrate',
        changes.flatMap((change) => (change ? [change] : [])),
      );
      return merged.conflicts.length;
    },
  });
  const result = await runWorkflow(definition, {
    ...options('parallel'),
    processRunner: runner,
    input: null,
    harness,
  });
  expect(result.output).toBe(0);
  expect(overlap).toBe(0);
});

it('serializes shared effects, resets failed attempts, retains ignored dependencies, and rebuilds missing caches', async () => {
  let handle: WorktreeHandle | undefined;
  let fail = true,
    running = 0,
    high = 0,
    setups = 0;
  const definition = defineWorkflow({
    version: '1',
    name: 'shared',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const shared = await ctx.worktree('cache');
      handle = shared;
      await Promise.all(
        ['one', 'two'].map((text) =>
          ctx.step(text, {
            input: text,
            worktree: shared,
            schema: z.null(),
            async run({ cwd }) {
              running++;
              high = Math.max(high, running);
              await appendFile(join(cwd, 'file.txt'), `${text}\n`);
              running--;
              return null;
            },
          }),
        ),
      );
      await ctx.step('broken', {
        input: null,
        worktree: shared,
        schema: z.null(),
        async run({ cwd }) {
          await appendFile(join(cwd, 'file.txt'), 'only once\n');
          await writeFile(join(cwd, 'garbage'), 'partial');
          if (fail) throw new Error('retry me');
          await rm(join(cwd, 'garbage'));
          return null;
        },
      });
      return (
        await ctx.exec(
          'test',
          [process.execPath, '-e', "process.stdout.write(require('fs').readFileSync('file.txt'))"],
          { worktree: handle },
        )
      ).stdout;
    },
  });
  const policy = {
    root,
    setup: async ({ path }: { path: string }) => {
      setups++;
      await mkdir(join(path, 'node_modules'), { recursive: true });
      await writeFile(join(path, 'node_modules', 'cached'), 'kept');
    },
  };
  await expect(
    runWorkflow(definition, { ...options('shared'), worktrees: policy, input: null }),
  ).rejects.toThrow('retry me');
  expect(high).toBe(1);
  assert(handle);
  expect(await readFile(join(handle.path, 'node_modules', 'cached'), 'utf8')).toBe('kept');
  await rm(handle.path, { recursive: true });
  fail = false;
  const resumed = await runWorkflow(definition, {
    ...options('shared'),
    worktrees: policy,
    resume: true,
  });
  expect(resumed.output).toBe('base\none\ntwo\nonly once\n');
  expect(resumed.steps['one']?.attempts).toBe(1);
  expect(resumed.steps['broken']?.attempts).toBe(2);
  expect(setups).toBe(6);
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('base\n');
  expect((await command('worktree', 'list', '--porcelain')).match(/^worktree /gmu)).toHaveLength(1);
});

it('does not advance a shared baseline when capture fails before effect completion', async () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebound to each manager with apply below.
  const prepare = RunWorktrees.prototype.prepare;
  let fail = true;
  vi.spyOn(RunWorktrees.prototype, 'prepare').mockImplementation(async function (
    this: RunWorktrees,
    ...args
  ) {
    const lease = await prepare.apply(this, args);
    return {
      ...lease,
      capture: async () => {
        const snapshot = await lease.capture();
        if (fail) {
          fail = false;
          throw new Error('interrupted after capture');
        }
        return snapshot;
      },
    };
  });
  const base = await command('rev-parse', 'HEAD');
  const workflow = defineWorkflow({
    name: 'capture-boundary',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const tree = await ctx.worktree('cache');
      await ctx.step('edit', {
        worktree: tree,
        input: null,
        schema: z.null(),
        async run({ cwd }) {
          await appendFile(join(cwd, 'file.txt'), 'once\n');
          return null;
        },
      });
      return (await ctx.merge('integrate', [tree])).commit;
    },
  });
  await expect(
    runWorkflow(workflow, { ...options('capture-boundary'), input: null }),
  ).rejects.toThrow('interrupted after capture');
  const failed = await readRun({ stateDir, runId: 'capture-boundary' });
  expect(Object.values(failed.worktrees?.handles ?? {}).map((entry) => entry.latest)).toEqual([
    base,
  ]);
  const resumed = await runWorkflow(workflow, { ...options('capture-boundary'), resume: true });
  expect(await command('show', `${String(resumed.output)}:file.txt`)).toBe('base\nonce');
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('base\n');
});

it('fails isolation outside a repository before invoking a harness', async () => {
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const harness: Harness = { invoke };
  const definition = defineWorkflow({
    version: '1',
    name: 'outside',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      return (await ctx.claude.text('edit', { prompt: 'edit', isolation: 'worktree' })).output;
    },
  });
  await expect(
    runWorkflow(definition, { ...options('outside'), cwd: dirname(repo), input: null, harness }),
  ).rejects.toThrow('requires a Git working tree');
  expect(invoke).not.toHaveBeenCalled();
});

it('keeps a missing repository a configuration failure that settled maps cannot journal or retry', async () => {
  const plain = join(directory, 'plain');
  await mkdir(plain);
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const harness: Harness = { invoke };
  const definition = defineWorkflow({
    version: '1',
    name: 'late-repo',
    input: z.null(),
    output: z.boolean(),
    async run(ctx) {
      const [result] = await ctx.map(
        'items',
        ['only'],
        { concurrency: 1, onError: 'settle' },
        async () =>
          ctx.claude.text('edit', {
            prompt: 'edit',
            isolation: 'worktree',
            onError: 'return',
            retry: { maxAttempts: 3, delayMs: 0 },
          }),
      );
      if (!result?.ok || !result.value.ok) throw new Error('isolated call did not complete');
      return result.value.value.worktree?.commit !== undefined;
    },
  });
  const setup = { ...options('late-repo'), cwd: plain, harness };
  await expect(runWorkflow(definition, { ...setup, input: null })).rejects.toThrow(
    'requires a Git working tree',
  );
  const failed = await readRun({ stateDir, runId: 'late-repo' });
  const steps = Object.values(failed.steps);
  expect(steps).toHaveLength(1);
  expect(steps[0]?.status).toBe('failed');
  expect(steps[0]?.attempts).toBe(1);
  expect(failed.maps?.['items']?.items[0]).toMatchObject({ status: 'running', outcome: null });
  expect(invoke).not.toHaveBeenCalled();
  await git.text(plain, ['init', '-q'], invocation);
  await writeFile(join(plain, 'file.txt'), 'base\n');
  await git.text(plain, ['add', '--all'], invocation);
  await git.text(
    plain,
    ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'baseline'],
    invocation,
  );
  const result = await runWorkflow(definition, { ...setup, resume: true });
  expect(result.status).toBe('completed');
  expect(result.output).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('treats an unresolvable isolation base as a configuration failure that settled maps cannot journal or retry', async () => {
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const harness: Harness = { invoke };
  const definition = defineWorkflow({
    version: '1',
    name: 'missing-base',
    input: z.null(),
    output: z.boolean(),
    async run(ctx) {
      const [result] = await ctx.map(
        'items',
        ['only'],
        { concurrency: 1, onError: 'settle' },
        async () =>
          ctx.claude.text('edit', {
            prompt: 'edit',
            isolation: { kind: 'worktree', base: 'no-such-branch' },
            onError: 'return',
            retry: { maxAttempts: 3, delayMs: 0 },
          }),
      );
      if (!result?.ok || !result.value.ok) throw new Error('isolated call did not complete');
      return result.value.value.worktree?.commit !== undefined;
    },
  });
  await expect(
    runWorkflow(definition, { ...options('missing-base'), input: null, harness }),
  ).rejects.toThrow('cannot resolve base no-such-branch to a commit');
  const failed = await readRun({ stateDir, runId: 'missing-base' });
  const steps = Object.values(failed.steps);
  expect(steps).toHaveLength(1);
  expect(steps[0]?.status).toBe('failed');
  expect(steps[0]?.attempts).toBe(1);
  expect(failed.maps?.['items']?.items[0]).toMatchObject({ status: 'running', outcome: null });
  expect(invoke).not.toHaveBeenCalled();
});

it('names a missing committed HEAD when no isolation base is given', async () => {
  const empty = join(directory, 'empty');
  await mkdir(empty);
  await git.text(empty, ['init', '-q'], invocation);
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const harness: Harness = { invoke };
  const definition = defineWorkflow({
    version: '1',
    name: 'no-head',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      return (await ctx.claude.text('edit', { prompt: 'edit', isolation: 'worktree' })).output;
    },
  });
  await expect(
    runWorkflow(definition, { ...options('no-head'), cwd: empty, input: null, harness }),
  ).rejects.toThrow('cannot resolve base HEAD to a commit; the repository has no committed HEAD');
  expect(invoke).not.toHaveBeenCalled();
});

it('rejects a cache root symlinked into the checkout before creating directories or invoking agents', async () => {
  const linked = join(directory, 'linked');
  await symlink(repo, linked, 'dir');
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const workflow = defineWorkflow({
    version: '1',
    name: 'nested-root',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      return (await ctx.codex.text('edit', { prompt: 'edit', isolation: 'worktree' })).output;
    },
  });
  await expect(
    runWorkflow(workflow, {
      ...options('nested-root'),
      worktrees: { root: join(linked, 'missing', 'caches') },
      input: null,
      harness: { invoke },
    }),
  ).rejects.toThrow('worktrees.root must be outside the source checkout');
  expect(invoke).not.toHaveBeenCalled();
  await expect(realpath(join(repo, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await command('status', '--porcelain')).toBe('');
});

it.each(['rebase', 'merge', 'squash'] as const)(
  'integrates in input order with %s, reports conflicts, and replays without Git',
  async (strategy) => {
    const base = await command('rev-parse', 'HEAD');
    let releaseFirst!: () => void;
    const secondCompleted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const harness: Harness = {
      invoke: async (request) => {
        if (request.options.prompt === 'one') await secondCompleted;
        await writeFile(
          join(request.cwd, request.options.prompt === 'three' ? 'new' : 'file.txt'),
          request.options.prompt + '\n',
        );
        return response;
      },
    };
    const workflow = defineWorkflow({
      name: 'merge-order',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      async run(ctx) {
        const results = await ctx.map(
          'writers',
          ['one', 'two', 'three'],
          { concurrency: 3 },
          (name) => ctx.claude.text(name, { prompt: name, isolation: 'worktree' }),
        );
        return ctx.within('integration').merge(
          'result',
          results.map((result) => {
            assert(result.worktree);
            return result.worktree;
          }),
          { strategy },
        );
      },
    });
    const completed = await runWorkflow(workflow, {
      ...options('merge-order'),
      input: null,
      harness,
      onEvent: (event) => {
        if (event.type === 'step.completed' && event.stepId === 'writers/1/two') releaseFirst();
      },
    });
    const outcome = completed.steps['integration/result']?.merge?.result;
    assert(outcome);
    expect(outcome.merged).toEqual([
      completed.steps['writers/0/one']?.worktree?.commit,
      completed.steps['writers/2/three']?.worktree?.commit,
    ]);
    expect(outcome.conflicts).toEqual([
      { commit: completed.steps['writers/1/two']?.worktree?.commit, files: ['file.txt'] },
    ]);
    expect(await command('show', `${outcome.commit}:file.txt`)).toBe('one');
    expect(await command('show', `${outcome.commit}:new`)).toBe('three');
    expect(await command('rev-parse', 'HEAD')).toBe(base);
    expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('base\n');
    const parents = (await command('rev-list', '--parents', '-1', outcome.commit))
      .split(' ')
      .slice(1);
    expect(parents).toHaveLength(strategy === 'merge' ? 2 : 1);
    if (strategy === 'squash')
      expect(await command('rev-list', '--count', `${base}..${outcome.commit}`)).toBe('1');
    const replay = await runWorkflow(workflow, {
      ...options('merge-order'),
      resume: true,
      harness: {
        invoke: () => {
          throw new Error('unexpected agent');
        },
      },
      processRunner: {
        run: () => {
          throw new Error('unexpected Git');
        },
      },
    });
    expect(replay.output).toEqual(completed.output);
  },
);

it('merges the latest shared handle into an unoccupied branch without touching HEAD', async () => {
  const base = await command('rev-parse', 'HEAD');
  const workflow = defineWorkflow({
    name: 'branch',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const handle = await ctx.within('shared').worktree('cache');
      await ctx.step('edit', {
        worktree: handle,
        input: null,
        schema: z.null(),
        async run({ cwd }) {
          await writeFile(join(cwd, 'file.txt'), 'branch content\n');
          return null;
        },
      });
      return (await ctx.merge('publish', [handle], { target: { branch: 'integration/test' } }))
        .commit;
    },
  });
  const run = await runWorkflow(workflow, { ...options('branch'), input: null });
  expect(await command('rev-parse', 'HEAD')).toBe(base);
  expect(await command('rev-parse', 'refs/heads/integration/test')).toBe(run.output);
  expect(await command('show', 'integration/test:file.txt')).toBe('branch content');
});

it('refuses dirty checkout targets, then fast-forwards the explicit checkout on resume', async () => {
  const harness: Harness = {
    invoke: async (request) => {
      await writeFile(join(request.cwd, 'file.txt'), 'integrated\n');
      return response;
    },
  };
  const workflow = defineWorkflow({
    name: 'checkout',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const result = await ctx.codex.text('change', { prompt: 'edit', isolation: 'worktree' });
      assert(result.worktree);
      return (await ctx.merge('publish', [result.worktree], { target: 'checkout' })).commit;
    },
  });
  await writeFile(join(repo, 'file.txt'), 'keep dirty\n');
  await expect(
    runWorkflow(workflow, { ...options('checkout'), input: null, harness }),
  ).rejects.toThrow('checkout is dirty');
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('keep dirty\n');
  await writeFile(join(repo, 'file.txt'), 'base\n');
  const run = await runWorkflow(workflow, { ...options('checkout'), resume: true, harness });
  expect(await command('rev-parse', 'HEAD')).toBe(run.output);
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('integrated\n');
});

it('does not publish any integration result when onConflict is fail', async () => {
  const harness: Harness = {
    invoke: async (request) => {
      await writeFile(join(request.cwd, 'file.txt'), request.options.prompt);
      return response;
    },
  };
  const workflow = defineWorkflow({
    name: 'conflict',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    async run(ctx) {
      const one = await ctx.claude.text('one', { prompt: 'one', isolation: 'worktree' });
      const two = await ctx.claude.text('two', { prompt: 'two', isolation: 'worktree' });
      assert(one.worktree);
      assert(two.worktree);
      return ctx.merge('publish', [one.worktree, two.worktree], {
        onConflict: 'fail',
        target: { branch: 'fail-result' },
      });
    },
  });
  await expect(
    runWorkflow(workflow, { ...options('conflict'), input: null, harness }),
  ).rejects.toThrow('conflicts');
  const run = await readRun(options('conflict'));
  expect(run.steps['publish']?.merge?.result).toBeUndefined();
  await expect(command('rev-parse', '--verify', 'refs/heads/fail-result')).rejects.toThrow();
  expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('base\n');
});

it('reconciles publication after an interrupted result save without changing the pinned integration base', async () => {
  let interrupt = true,
    publications = 0;
  const runner: ProcessRunner = {
    run: async (request, invocation) => {
      const result = await processRunner.run(request, invocation);
      if (
        Array.isArray(request.command) &&
        request.command.includes('update-ref') &&
        request.command.includes('refs/heads/recovered')
      ) {
        publications++;
        if (interrupt) throw new Error('interrupted after ref publication');
      }
      return result;
    },
  };
  const workflow = defineWorkflow({
    name: 'publication',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const handle = await ctx.worktree('cache');
      await ctx.step('edit', {
        worktree: handle,
        input: null,
        schema: z.null(),
        async run({ cwd }) {
          await writeFile(join(cwd, 'file.txt'), 'recovered\n');
          return null;
        },
      });
      return (await ctx.merge('publish', [handle], { target: { branch: 'recovered' } })).commit;
    },
  });
  await expect(
    runWorkflow(workflow, { ...options('publication'), input: null, processRunner: runner }),
  ).rejects.toThrow('interrupted after ref publication');
  const failed = await readRun(options('publication'));
  const prepared = failed.steps['publish']?.merge;
  assert(prepared?.result);
  expect(await command('rev-parse', 'refs/heads/recovered')).toBe(prepared.result.commit);
  await writeFile(join(repo, 'later'), 'new HEAD');
  await commit('advance source');
  interrupt = false;
  const resumed = await runWorkflow(workflow, {
    ...options('publication'),
    resume: true,
    processRunner: runner,
  });
  expect(resumed.output).toBe(prepared.result.commit);
  expect(resumed.steps['publish']?.merge?.base).toBe(prepared.base);
  expect(publications).toBe(1);
});

it('refuses branch targets occupied in another worktree', async () => {
  const other = join(directory, 'other');
  await command('worktree', 'add', '-q', '-b', 'occupied', other);
  const workflow = defineWorkflow({
    name: 'occupied',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    async run(ctx) {
      return ctx.merge('publish', [], { target: { branch: 'occupied' } });
    },
  });
  await expect(runWorkflow(workflow, { ...options('occupied'), input: null })).rejects.toThrow(
    'checked out',
  );
  expect(await readFile(join(other, 'file.txt'), 'utf8')).toBe('base\n');
});

it('inspects and cleans only owned caches, retaining pins unless refs is explicit', async () => {
  const workflow = defineWorkflow({
    name: 'clean',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      const handle = await ctx.worktree('cache');
      await ctx.step('edit', {
        worktree: handle,
        input: null,
        schema: z.null(),
        async run({ cwd }) {
          await writeFile(join(cwd, 'file.txt'), 'clean me');
          return null;
        },
      });
      return null;
    },
  });
  const run = await runWorkflow(workflow, {
    ...options('clean'),
    input: null,
    worktrees: { root, keep: 'all' },
  });
  const inspection = await inspectRun(options('clean'));
  expect(inspection.summary.steps.find((step) => step.id === 'edit')?.worktree).toMatchObject({
    base: run.steps['edit']?.worktree?.base,
    directoryState: 'present',
    files: [{ path: 'file.txt', status: 'modified' }],
  });
  expect(formatRunSummary(inspection.summary)).toContain('Worktree edit:');
  const refs = Object.keys(run.worktrees?.refs ?? {});
  expect(refs.length).toBeGreaterThan(0);
  const executor = new WorkflowExecutor({ logger: new ThresholdLogger('silent', () => undefined) });
  const first = await executor.execute({ kind: 'workflow.clean', runId: 'clean', stateDir });
  expect(first).toMatchObject({
    ok: true,
    directories: [expect.any(String)],
    refs: [],
    warnings: [],
  });
  for (const ref of refs)
    expect(await command('rev-parse', '--verify', ref)).toMatch(/^[a-f0-9]{40}$/u);
  expect(
    (await inspectRun(options('clean'))).summary.steps.find((step) => step.id === 'edit')?.worktree
      ?.directoryState,
  ).toBe('removed');
  const pinned = await executor.execute({
    kind: 'workflow.clean',
    runId: 'clean',
    stateDir,
    refs: true,
  });
  expect(pinned).toMatchObject({ ok: true, directories: [], refs, warnings: [] });
  expect(await command('for-each-ref', '--format=%(refname)', 'refs/quiet-choir')).toBe('');
  expect(
    await executor.execute({ kind: 'workflow.clean', runId: 'clean', stateDir, refs: true }),
  ).toMatchObject({ ok: true, directories: [], refs: [] });
});

it('clean refuses a live writer and refuses refs whose values have changed', async () => {
  const workflow = defineWorkflow({
    name: 'clean-guard',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.worktree('cache');
      return null;
    },
  });
  const run = await runWorkflow(workflow, { ...options('clean-guard'), input: null });
  const executor = new WorkflowExecutor({ logger: new ThresholdLogger('silent', () => undefined) });
  const owner = await new FileRunStore(stateDir).open('clean-guard');
  try {
    expect(
      await executor.execute({
        kind: 'workflow.clean',
        runId: 'clean-guard',
        stateDir,
        refs: true,
      }),
    ).toMatchObject({ ok: false, code: 'run.locked' });
  } finally {
    await owner.release();
  }
  const ref = Object.keys(run.worktrees?.refs ?? {})[0];
  assert(ref);
  await writeFile(join(repo, 'later'), 'later');
  const moved = await commit('move ref');
  await command('update-ref', ref, moved);
  const rejected = await executor.execute({
    kind: 'workflow.clean',
    runId: 'clean-guard',
    stateDir,
    refs: true,
  });
  assert(!rejected.ok);
  expect(rejected.message).toContain('changed');
  expect(await command('rev-parse', ref)).toBe(moved);
});

it('captures a validated agent result after cancellation without repeating that agent on resume', async () => {
  const controller = new AbortController();
  let calls = 0;
  const harness: Harness = {
    invoke: async (request) => {
      calls++;
      await writeFile(join(request.cwd, 'file.txt'), 'completed before abort\n');
      controller.abort(new Error('interrupt'));
      return response;
    },
  };
  const workflow = defineWorkflow({
    name: 'late-abort',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const result = await ctx.codex.text('edit', { prompt: 'edit', isolation: 'worktree' });
      assert(result.worktree?.commit);
      return result.worktree.commit;
    },
  });
  await expect(
    runWorkflow(workflow, {
      ...options('late-abort'),
      input: null,
      harness,
      signal: controller.signal,
    }),
  ).rejects.toThrow('interrupt');
  const interrupted = await readRun(options('late-abort'));
  expect(interrupted.steps['edit']?.status).toBe('completed');
  const resumed = await runWorkflow(workflow, { ...options('late-abort'), resume: true, harness });
  expect(calls).toBe(1);
  expect(await command('show', `${String(resumed.output)}:file.txt`)).toBe(
    'completed before abort',
  );
});

it('never advances a shared snapshot for a rejected structured response and preserves ignored dependencies on reset', async () => {
  const harness: Harness = {
    invoke: async (request, call) => {
      await writeFile(join(request.cwd, 'file.txt'), 'invalid attempt');
      await mkdir(join(request.cwd, 'node_modules'), { recursive: true });
      await writeFile(join(request.cwd, 'node_modules', 'cached'), 'kept');
      await git.run(request.cwd, ['init', '-q', 'nested'], call);
      await writeFile(join(request.cwd, 'nested', 'partial'), 'discard me');
      return { ...response, text: 'not JSON' };
    },
  };
  const workflow = defineWorkflow({
    name: 'invalid',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const handle = await ctx.worktree('cache');
      const bad = await ctx.codex.object('bad', {
        prompt: 'edit',
        isolation: handle,
        schema: z.object({ ok: z.boolean() }),
        onError: 'return',
      });
      expect(bad.ok).toBe(false);
      return ctx.step('read', {
        input: null,
        worktree: handle,
        schema: z.string(),
        async run({ cwd }) {
          expect(await readFile(join(cwd, 'node_modules', 'cached'), 'utf8')).toBe('kept');
          await expect(readFile(join(cwd, 'nested', 'partial'))).rejects.toThrow();
          return readFile(join(cwd, 'file.txt'), 'utf8');
        },
      });
    },
  });
  const result = await runWorkflow(workflow, { ...options('invalid'), input: null, harness });
  expect(result.output).toBe('base\n');
  expect(result.steps['bad']?.worktree?.commit).toBeNull();
  expect(result.steps['read']?.worktree?.commit).toBeNull();
});

it('explains dry-run isolation before invoking Git or the agent', async () => {
  const runGit = vi.fn<ProcessRunner['run']>(() => {
    throw new Error('unexpected Git');
  });
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const workflow = defineWorkflow({
    name: 'dry-worktree',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      return ctx.codex.value('edit', { prompt: 'edit', isolation: 'worktree' });
    },
  });
  await expect(
    runWorkflow(workflow, {
      ...options('dry-worktree'),
      input: null,
      rehearsal: {},
      harness: { kind: 'dry-run', invoke },
      processRunner: { run: runGit },
    }),
  ).rejects.toThrow('fixture harness in a temporary repository');
  expect(runGit).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it('snapshots a local step handle before asynchronous preparation', async () => {
  const workflow = defineWorkflow({
    name: 'mutable-handle',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const handle = await ctx.worktree('cache');
      const mutable = { ...handle };
      const result = ctx.step('write', {
        input: null,
        schema: z.string(),
        worktree: mutable,
        async run({ cwd }) {
          await writeFile(join(cwd, 'created'), 'saved');
          return cwd;
        },
      });
      mutable.path = join(directory, 'unexpected');
      return result;
    },
  });
  const run = await runWorkflow(workflow, { ...options('mutable-handle'), input: null });
  expect(run.output).toBe(run.steps['write']?.worktree?.path);
  expect(run.steps['write']?.worktree?.files).toEqual([{ path: 'created', status: 'added' }]);
});

it('checks the Git version before any agent invocation', async () => {
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const runner: ProcessRunner = {
    run: (request, invocation) =>
      Array.isArray(request.command) && request.command.includes('--version')
        ? Promise.resolve({
            code: 0,
            signal: null,
            stdout: 'git version 2.37.0\n',
            stderr: '',
            durationMs: 0,
            truncated: false,
          })
        : processRunner.run(request, invocation),
  };
  const workflow = defineWorkflow({
    name: 'old-git',
    version: '1',
    input: z.null(),
    output: z.string(),
    run(ctx) {
      return ctx.codex.value('edit', { prompt: 'edit', isolation: 'worktree' });
    },
  });
  await expect(
    runWorkflow(workflow, {
      ...options('old-git'),
      input: null,
      processRunner: runner,
      harness: { invoke },
    }),
  ).rejects.toThrow('Git 2.38 or newer');
  expect(invoke).not.toHaveBeenCalled();
});

it('treats a failed Git version probe as a configuration error that settled maps cannot journal or retry', async () => {
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const runner: ProcessRunner = {
    run: (request, invocation) =>
      Array.isArray(request.command) && request.command.includes('--version')
        ? Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
        : processRunner.run(request, invocation),
  };
  const workflow = defineWorkflow({
    version: '1',
    name: 'missing-git',
    input: z.null(),
    output: z.boolean(),
    async run(ctx) {
      const [result] = await ctx.map(
        'items',
        ['only'],
        { concurrency: 1, onError: 'settle' },
        async () =>
          ctx.claude.text('edit', {
            prompt: 'edit',
            isolation: 'worktree',
            onError: 'return',
            retry: { maxAttempts: 3, delayMs: 0 },
          }),
      );
      if (!result?.ok || !result.value.ok) throw new Error('isolated call did not complete');
      return result.value.value.worktree?.commit !== undefined;
    },
  });
  await expect(
    runWorkflow(workflow, {
      ...options('missing-git'),
      input: null,
      processRunner: runner,
      harness: { invoke },
    }),
  ).rejects.toThrow('executable Git 2.38 or newer');
  const failed = await readRun({ stateDir, runId: 'missing-git' });
  const steps = Object.values(failed.steps);
  expect(steps).toHaveLength(1);
  expect(steps[0]?.status).toBe('failed');
  expect(steps[0]?.attempts).toBe(1);
  expect(failed.maps?.['items']?.items[0]).toMatchObject({ status: 'running', outcome: null });
  expect(invoke).not.toHaveBeenCalled();
});

it('propagates cancellation during the Git version probe instead of a configuration error', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const runner: ProcessRunner = {
    run: (request, invocation) =>
      Array.isArray(request.command) && request.command.includes('--version')
        ? new Promise((_, reject) => {
            started();
            invocation.signal.addEventListener(
              'abort',
              () => {
                reject(invocation.signal.reason as Error);
              },
              { once: true },
            );
          })
        : processRunner.run(request, invocation),
  };
  const workflow = defineWorkflow({
    name: 'cancelled-probe',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      return (await ctx.claude.text('edit', { prompt: 'edit', isolation: 'worktree' })).output;
    },
  });
  const promise = runWorkflow(workflow, {
    ...options('cancelled-probe'),
    input: null,
    processRunner: runner,
    harness: { invoke },
    signal: controller.signal,
  });
  const rejected = expect(promise).rejects.toThrow('probe cancelled');
  await probeStarted;
  controller.abort(new Error('probe cancelled'));
  await rejected;
  expect(invoke).not.toHaveBeenCalled();
});

it('keeps committed results when cache cleanup fails and reports repeated cleanup warnings', async () => {
  let calls = 0;
  const harness: Harness = {
    invoke: async (request) => {
      calls++;
      await writeFile(join(request.cwd, 'file.txt'), 'saved');
      return response;
    },
  };
  const runner: ProcessRunner = {
    run: (request, invocation) => {
      if (
        Array.isArray(request.command) &&
        request.command.includes('worktree') &&
        request.command.includes('remove')
      )
        throw new Error('cache temporarily busy');
      return processRunner.run(request, invocation);
    },
  };
  const workflow = defineWorkflow({
    name: 'cleanup-warning',
    version: '1',
    input: z.null(),
    output: z.string(),
    run(ctx) {
      return ctx.codex.value('edit', { prompt: 'edit', isolation: 'worktree' });
    },
  });
  const run = await runWorkflow(workflow, {
    ...options('cleanup-warning'),
    input: null,
    harness,
    processRunner: runner,
  });
  expect(run.status).toBe('completed');
  expect(run.warnings?.some((warning) => warning.includes('cache temporarily busy'))).toBe(true);
  const executor = new WorkflowExecutor({
    logger: new ThresholdLogger('silent', () => undefined),
    processRunner: runner,
  });
  for (let n = 0; n < 2; n++) {
    const cleanup = await executor.execute({
      kind: 'workflow.clean',
      runId: 'cleanup-warning',
      stateDir,
    });
    assert(cleanup.ok && cleanup.kind === 'workflow.clean.result');
    expect(cleanup.warnings).toHaveLength(1);
    expect(cleanup.warnings[0]).toContain('cache temporarily busy');
  }
  await runWorkflow(workflow, { ...options('cleanup-warning'), resume: true, harness });
  expect(calls).toBe(1);
  const clean = await new WorkflowExecutor({
    logger: new ThresholdLogger('silent', () => undefined),
  }).execute({ kind: 'workflow.clean', runId: 'cleanup-warning', stateDir });
  expect(clean).toMatchObject({ ok: true, warnings: [] });
  expect((await command('worktree', 'list', '--porcelain')).match(/^worktree /gmu)).toHaveLength(1);
});

it('cancels queued shared work without starting its callback and commits a valid in-flight result', async () => {
  const controller = new AbortController();
  let entered!: () => void, release!: () => void, queued!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finishFirst = new Promise<void>((resolve) => {
    release = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    queued = resolve;
  });
  let secondCalls = 0;
  const workflow = defineWorkflow({
    name: 'queue',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      const handle = await ctx.worktree('cache');
      await Promise.all([
        ctx.step('first', {
          input: null,
          worktree: handle,
          schema: z.null(),
          async run({ cwd }) {
            entered();
            await finishFirst;
            await writeFile(join(cwd, 'file.txt'), 'first committed');
            return null;
          },
        }),
        ctx.step('second', {
          input: null,
          worktree: handle,
          schema: z.null(),
          run() {
            secondCalls++;
            return null;
          },
        }),
      ]);
      return null;
    },
  });
  const promise = runWorkflow(workflow, {
    ...options('queue'),
    input: null,
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'step.started' && event.stepId === 'second') queued();
    },
  });
  const rejected = expect(promise).rejects.toThrow();
  await Promise.all([firstEntered, secondStarted]);
  controller.abort(new Error('cancel queued'));
  release();
  await rejected;
  const record = await readRun(options('queue'));
  expect(secondCalls).toBe(0);
  expect(record.steps['first']?.status).toBe('completed');
  expect(record.steps['second']?.status).toBe('cancelled');
});
