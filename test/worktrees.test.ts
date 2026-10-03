import { FileRunStore } from '../src/workflow/runtime/run-store.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { ThresholdLogger } from '../src/application/execution.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import { formatRunSummary } from '../src/cli/inspection-view.js';
import assert from 'node:assert/strict';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ConfigurationError,
  defineWorkflow,
  NodeProcessRunner,
  readRun,
  runWorkflow,
  type Harness,
  type WorktreeHandle,
  type WorktreeLedger,
  type ProcessRunner,
  type RunOptions,
  type WorkflowContext,
} from '../src/index.js';
import { WorktreeGit } from '../src/worktrees/git.js';
import {
  RunWorktrees,
  cleanupAdminWait,
  defaultWorktreeRoot,
} from '../src/workflow/runtime/worktrees.js';
import { repairWorktreeRegistrations } from '../src/workflow/runtime/worktree-recovery.js';
import { cleanWorktrees } from '../src/workflow/runtime/worktree-clean.js';
import { testInvocation } from './harness-invocation.js';
import { holdAdminLock } from './worktree-admin-holder.js';

// Every test drives real Git processes. measured: 0.4-1.5 s per case on the CI legs, up to 1.3 s
// alone and 3.1 s in local full coverage runs on a loaded machine (dominated by Git processes).
vi.setConfig({ testTimeout: 10_000 });

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
      expect(request.options).toHaveProperty('isolation', 'restricted');
      expect(request.options).not.toHaveProperty('worktree');
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
        const result = await ctx[provider].text('edit', { prompt: 'edit', worktree: true });
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
      return (await ctx.codex.text('edit', { prompt: 'edit', worktree: true, cwd: 'packages/a' }))
        .output;
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
        async (item) => (await ctx.codex.text('edit', { prompt: item, worktree: true })).worktree,
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

it('keys worktree administration by the shared common Git directory across linked checkouts', async () => {
  const linked = join(directory, 'linked');
  await command('worktree', 'add', '--detach', linked, 'HEAD');
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
        // Widen the window so unserialized adds across the two checkouts would reliably overlap.
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
  function definition() {
    return defineWorkflow({
      version: '1',
      name: 'linked-admin',
      input: z.null(),
      output: z.null(),
      async run(ctx) {
        await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
        return null;
      },
    });
  }
  await Promise.all([
    runWorkflow(definition(), {
      runId: 'main-checkout',
      cwd: repo,
      stateDir,
      processRunner: runner,
      worktrees: { root: join(directory, 'caches-main') },
      input: null,
      harness,
    }),
    runWorkflow(definition(), {
      runId: 'linked-checkout',
      cwd: linked,
      stateDir,
      processRunner: runner,
      worktrees: { root: join(directory, 'caches-linked') },
      input: null,
      harness,
    }),
  ]);
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

it('composes inherited configuration with both legacy and explicit checkout selection', async () => {
  const received: string[] = [];
  const harness: Harness = {
    invoke: async (request) => {
      expect(request.options.isolation).toBe('inherit');
      expect(request.options).not.toHaveProperty('worktree');
      expect(request.cwd).not.toBe(repo);
      received.push(request.cwd);
      await appendFile(join(request.cwd, 'file.txt'), 'isolated\n');
      return response;
    },
  };
  const workflow = defineWorkflow({
    name: 'composed-isolation',
    version: '1',
    input: z.null(),
    output: z.null(),
    defaults: { isolation: 'inherit' },
    async run(ctx) {
      // Legacy spelling, kept to prove it still runs (#340).
      const first = await ctx.claude.text('shorthand', {
        prompt: '',
        isolation: 'worktree' as never,
      });
      const second = await ctx.codex.text('explicit', { prompt: '', worktree: true });
      expect(first.worktree?.commit).toBeTruthy();
      expect(second.worktree?.commit).toBeTruthy();
      return null;
    },
  });
  await runWorkflow(workflow, {
    ...options('composed-isolation'),
    grants: ['all'],
    harness,
    input: null,
  });
  expect(new Set(received).size).toBe(2);
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
      return (await ctx.claude.text('edit', { prompt: 'edit', worktree: true })).output;
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
        { concurrency: 1, onError: 'return' },
        async () =>
          ctx.claude.text('edit', {
            prompt: 'edit',
            worktree: true,
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
        { concurrency: 1, onError: 'return' },
        async () =>
          ctx.claude.text('edit', {
            prompt: 'edit',
            worktree: { base: 'no-such-branch' },
            onError: 'return',
            retry: { maxAttempts: 3, delayMs: 0 },
          }),
      );
      if (!result?.ok || !result.value.ok) throw new Error('isolated call did not complete');
      return result.value.value.worktree?.commit !== undefined;
    },
  });
  const missing: unknown = await runWorkflow(definition, {
    ...options('missing-base'),
    input: null,
    harness,
  }).catch((error: unknown) => error);
  expect(missing).toBeInstanceOf(Error);
  expect((missing as Error).cause).toBeInstanceOf(ConfigurationError);
  expect((missing as Error).message).toContain('cannot resolve base no-such-branch to a commit');
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
      return (await ctx.claude.text('edit', { prompt: 'edit', worktree: true })).output;
    },
  });
  const headless: unknown = await runWorkflow(definition, {
    ...options('no-head'),
    cwd: empty,
    input: null,
    harness,
  }).catch((error: unknown) => error);
  expect(headless).toBeInstanceOf(Error);
  expect((headless as Error).cause).toBeInstanceOf(ConfigurationError);
  expect((headless as Error).message).toContain(
    'cannot resolve base HEAD to a commit; the repository has no committed HEAD',
  );
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
      return (await ctx.codex.text('edit', { prompt: 'edit', worktree: true })).output;
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
          (name) => ctx.claude.text(name, { prompt: name, worktree: true }),
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
      const result = await ctx.codex.text('change', { prompt: 'edit', worktree: true });
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
      const one = await ctx.claude.text('one', { prompt: 'one', worktree: true });
      const two = await ctx.claude.text('two', { prompt: 'two', worktree: true });
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
      const result = await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
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
        worktree: handle,
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

/** A runner that records each Git subcommand (the words after `-C cwd`) before running it. */
function spyRunner() {
  const commands: string[][] = [];
  const runner: ProcessRunner = {
    run: (request, invocation) => {
      const argv = Array.isArray(request.command) ? [...(request.command as string[])] : [];
      commands.push(argv.slice(argv.indexOf('-C') + 2));
      return processRunner.run(request, invocation);
    },
  };
  return { runner, commands };
}
type WorktreeEvent = Parameters<NonNullable<NonNullable<RunOptions['rehearsal']>['onWorktree']>>[0];
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

it('synthesizes isolated calls and their merge under dry-run with read-only rev-parse only', async () => {
  const head = await command('rev-parse', 'HEAD');
  const refs = await command('for-each-ref');
  const registered = await command('worktree', 'list', '--porcelain');
  const workflow = defineWorkflow({
    name: 'dry-worktree',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const [one, two] = await Promise.all(
        ['one', 'two'].map((id) => ctx.codex.text(id, { prompt: id, worktree: true })),
      );
      if (!one?.worktree || !two?.worktree) throw new Error('missing synthesized change');
      const merged = await ctx.merge('integrate', [one.worktree, two.worktree]);
      return JSON.stringify({ change: one.worktree, merged });
    },
  });
  for (const [runId, policy] of [
    ['explicit', { root }],
    ['default', {}],
  ] as const) {
    const spy = spyRunner();
    const cwds: string[] = [];
    const events: WorktreeEvent[] = [];
    const invoke = vi.fn<Harness['invoke']>((request) => {
      cwds.push(request.cwd);
      return Promise.resolve(response);
    });
    const run = await runWorkflow(workflow, {
      ...options(runId),
      worktrees: policy,
      input: null,
      rehearsal: { onWorktree: (event) => events.push(event) },
      harness: { kind: 'dry-run', invoke },
      processRunner: spy.runner,
    });
    expect(JSON.parse(run.output ?? 'null')).toEqual({
      change: { base: head, commit: null, ref: null, files: [] },
      merged: { commit: head, merged: [], conflicts: [] },
    });
    // Only rev-parse ran, and concurrent calls shared one repository and HEAD resolution.
    expect(spy.commands.every((args) => args[0] === 'rev-parse')).toBe(true);
    expect(spy.commands.filter((args) => args.includes('--show-toplevel'))).toHaveLength(1);
    expect(spy.commands.filter((args) => args.includes('HEAD^{commit}'))).toHaveLength(1);
    const cacheRoot = 'root' in policy ? root : defaultWorktreeRoot(repo);
    expect(cwds).toHaveLength(2);
    for (const cwd of cwds) {
      expect(cwd.startsWith(join(cacheRoot, `${runId}-dry-run`))).toBe(true);
      expect(await exists(cwd)).toBe(false);
    }
    expect(await exists(cacheRoot)).toBe(false);
    // The two isolated calls race; the merge is reported last.
    const order = (event: WorktreeEvent) => `${event.kind === 'merge' ? 'z' : 'a'}${event.stepId}`;
    expect(events.sort((a, b) => order(a).localeCompare(order(b)))).toEqual([
      ...['one', 'two'].map(
        (stepId): unknown =>
          expect.objectContaining({
            kind: 'isolation',
            stepId,
            attempt: 1,
            base: head,
            baseSource: 'resolved',
          }) as unknown,
      ),
      {
        kind: 'merge',
        stepId: 'integrate',
        attempt: 1,
        commit: head,
        inputs: 2,
        target: 'ref',
        baseSource: 'resolved',
      },
    ]);
    const record = await readRun({ stateDir, runId });
    expect(record.worktrees).toBeUndefined();
    const step = record.steps['one']?.worktree;
    expect(step).toEqual({
      base: head,
      path: expect.stringContaining(`${runId}-dry-run`) as unknown,
      handleId: null,
      commit: null,
      ref: null,
      files: [],
    });
    // The workflow cwd is the repository root, so the call runs at the attempt directory itself.
    expect(cwds).toContain(step?.path);
  }
  expect(await command('for-each-ref')).toBe(refs);
  expect(await command('worktree', 'list', '--porcelain')).toBe(registered);
});

it('uses a labelled placeholder base outside a Git working tree', async () => {
  const plain = join(directory, 'plain');
  await mkdir(plain);
  const spy = spyRunner();
  const events: WorktreeEvent[] = [];
  const cwds: string[] = [];
  const workflow = defineWorkflow({
    name: 'dry-plain',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const edit = await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
      if (!edit.worktree) throw new Error('missing synthesized change');
      return (await ctx.merge('integrate', [edit.worktree])).commit;
    },
  });
  const run = await runWorkflow(workflow, {
    runId: 'plain',
    cwd: plain,
    stateDir,
    input: null,
    rehearsal: { onWorktree: (event) => events.push(event) },
    harness: {
      kind: 'dry-run',
      invoke: (request) => {
        cwds.push(request.cwd);
        return Promise.resolve(response);
      },
    },
    processRunner: spy.runner,
  });
  const placeholder = '0'.repeat(40);
  expect(run.output).toBe(placeholder);
  expect(spy.commands).toEqual([['rev-parse', '--show-toplevel']]);
  expect(events).toEqual([
    expect.objectContaining({ kind: 'isolation', base: placeholder, baseSource: 'placeholder' }),
    expect.objectContaining({ kind: 'merge', commit: placeholder, baseSource: 'placeholder' }),
  ]);
  expect(cwds[0]?.startsWith(join(defaultWorktreeRoot(plain), 'plain-dry-run'))).toBe(true);
  expect(await exists(defaultWorktreeRoot(plain))).toBe(false);
});

it('reproduces the real configuration error for an unresolvable base under dry-run', async () => {
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const workflow = defineWorkflow({
    name: 'dry-base',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      return ctx.codex.value('edit', {
        prompt: 'edit',
        worktree: { base: 'missing-ref' },
      });
    },
  });
  const failure: unknown = await runWorkflow(workflow, {
    ...options('dry-base'),
    input: null,
    rehearsal: {},
    harness: { kind: 'dry-run', invoke },
  }).catch((error: unknown) => error);
  expect((failure as Error).cause).toBeInstanceOf(ConfigurationError);
  expect((failure as Error).message).toContain(
    'Worktree isolation cannot resolve base missing-ref to a commit.',
  );
  expect(invoke).not.toHaveBeenCalled();
  expect(await exists(root)).toBe(false);
});

it.each([
  ['a cache root inside the checkout', { worktrees: { root: 'caches' } }, {}, 'worktrees.root'],
  ['an isolated cwd outside the repository', {}, { cwd: '..' }, 'Isolated cwd must be inside'],
])(
  'reproduces the real configuration error for %s under dry-run',
  async (_name, run, call, text) => {
    const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
    const workflow = defineWorkflow({
      name: 'dry-config',
      version: '1',
      input: z.null(),
      output: z.string(),
      async run(ctx) {
        return ctx.codex.value('edit', { prompt: 'edit', worktree: true, ...call });
      },
    });
    const failure: unknown = await runWorkflow(workflow, {
      ...options('dry-config'),
      ...run,
      input: null,
      rehearsal: {},
      harness: { kind: 'dry-run', invoke },
    }).catch((error: unknown) => error);
    expect((failure as Error).cause).toBeInstanceOf(ConfigurationError);
    expect((failure as Error).message).toContain(text);
    expect(invoke).not.toHaveBeenCalled();
  },
);

it('merges into an existing branch target and reuses a recorded base under dry-run', async () => {
  const base = await command('rev-parse', 'HEAD');
  await command('branch', 'target');
  await writeFile(join(repo, 'file.txt'), 'moved\n');
  const moved = await commit('moved');
  await command('checkout', '-q', 'target');
  const events: WorktreeEvent[] = [];
  const workflow = defineWorkflow({
    name: 'dry-branch',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const edit = await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
      if (!edit.worktree) throw new Error('missing synthesized change');
      return (await ctx.merge('integrate', [edit.worktree], { target: { branch: 'master-x' } }))
        .commit;
    },
  });
  await command('branch', 'master-x', moved);
  // An interrupted real attempt recorded its base; a dry-run resume keeps it.
  let fail = true;
  const invoke = vi.fn<Harness['invoke']>(() =>
    fail ? Promise.reject(new Error('interrupted')) : Promise.resolve(response),
  );
  await expect(
    runWorkflow(workflow, { ...options('dry-branch'), input: null, harness: { invoke } }),
  ).rejects.toThrow('interrupted');
  expect((await readRun({ stateDir, runId: 'dry-branch' })).steps['edit']?.worktree?.base).toBe(
    base,
  );
  fail = false;
  const run = await runWorkflow(workflow, {
    ...options('dry-branch'),
    resume: true,
    rehearsal: { onWorktree: (event) => events.push(event) },
    harness: { kind: 'dry-run', invoke },
    allowHarnessChange: true,
  });
  expect(run.output).toBe(moved);
  expect(events).toEqual([
    expect.objectContaining({ kind: 'isolation', base, baseSource: 'recorded' }),
    expect.objectContaining({ kind: 'merge', commit: moved, target: 'branch' }),
  ]);
});

it.each([
  ['ctx.worktree', (ctx: WorkflowContext) => ctx.worktree('cache')],
  [
    'exec on a handle',
    (ctx: WorkflowContext, handle: WorktreeHandle) =>
      ctx.exec('probe', ['true'], { worktree: handle }),
  ],
  [
    'a local step on a handle',
    (ctx: WorkflowContext, handle: WorktreeHandle) =>
      ctx.step('local', { input: null, schema: z.null(), worktree: handle, run: () => null }),
  ],
  [
    'an agent on a handle',
    (ctx: WorkflowContext, handle: WorktreeHandle) =>
      ctx.codex.text('edit', { prompt: 'edit', worktree: handle }),
  ],
  [
    'a merge of a captured commit',
    (ctx: WorkflowContext, handle: WorktreeHandle) =>
      ctx.merge('integrate', [
        { base: handle.base, commit: handle.base, ref: 'refs/x', files: [] },
      ]),
  ],
])('still refuses %s under dry-run before any Git', async (_name, body) => {
  const spy = spyRunner();
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const handle = { id: 'foreign', path: join(directory, 'handle'), base: 'a'.repeat(40) };
  const workflow = defineWorkflow({
    name: 'dry-refused',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await body(ctx, handle);
      return null;
    },
  });
  const failure: unknown = await runWorkflow(workflow, {
    ...options('dry-refused'),
    input: null,
    rehearsal: {},
    harness: { kind: 'dry-run', invoke },
    processRunner: spy.runner,
  }).catch((error: unknown) => error);
  expect((failure as Error).cause).toBeInstanceOf(ConfigurationError);
  expect((failure as Error).message).toContain(
    'Dry-run does not simulate this Git worktree effect',
  );
  expect((failure as Error).message).toContain('fixture harness in a temporary repository');
  expect(spy.commands).toEqual([]);
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
      return ctx.codex.value('edit', { prompt: 'edit', worktree: true });
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
        { concurrency: 1, onError: 'return' },
        async () =>
          ctx.claude.text('edit', {
            prompt: 'edit',
            worktree: true,
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
      return (await ctx.claude.text('edit', { prompt: 'edit', worktree: true })).output;
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
      return ctx.codex.value('edit', { prompt: 'edit', worktree: true });
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

it.each(['owned', 'different-owner'] as const)(
  'reconciles only an owned planned worktree with an interrupted empty commondir (%s)',
  async (ownership) => {
    let metadata = '',
      interrupted = false;
    const breakingRunner: ProcessRunner = {
      async run(request, invocation) {
        const result = await processRunner.run(request, invocation);
        if (
          !interrupted &&
          Array.isArray(request.command) &&
          request.command.includes('worktree') &&
          request.command.includes('add')
        ) {
          interrupted = true;
          const path = z.string().parse(request.command.at(-2));
          metadata = resolve(
            path,
            (await readFile(join(path, '.git'), 'utf8')).replace(/^gitdir: /u, '').trimEnd(),
          );
          await writeFile(join(metadata, 'commondir'), '');
          if (ownership === 'different-owner')
            await writeFile(
              join(metadata, 'gitdir'),
              join(directory, 'someone-else', '.git') + '\n',
            );
          throw new Error('fixture interrupted registration');
        }
        return result;
      },
    };
    const invoke = vi.fn<Harness['invoke']>(async (request) => {
      await writeFile(join(request.cwd, 'file.txt'), 'resumed edit\n');
      return response;
    });
    const workflow = defineWorkflow({
      name: 'planned-registration',
      version: '1',
      input: z.null(),
      output: z.string(),
      async run(ctx) {
        const result = await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
        assert(result.worktree?.commit);
        return result.worktree.commit;
      },
    });
    const settings = {
      ...options('planned-registration'),
      harness: { invoke },
      worktrees: { root, keep: 'all' as const },
    };
    await expect(
      runWorkflow(workflow, { ...settings, input: null, processRunner: breakingRunner }),
    ).rejects.toThrow('fixture interrupted registration');
    expect(invoke).not.toHaveBeenCalled();
    const failed = await readRun(settings);
    expect(Object.values(failed.worktrees?.caches ?? {}).map((cache) => cache.state)).toEqual([
      'planned',
    ]);
    if (ownership === 'different-owner') {
      const rejection: unknown = await runWorkflow(workflow, {
        ...settings,
        resume: true,
      }).catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).cause).toBeInstanceOf(ConfigurationError);
      expect((rejection as Error).message).toContain('different checkout owner');
      expect(await readFile(join(metadata, 'commondir'), 'utf8')).toBe('');
      expect(invoke).not.toHaveBeenCalled();
      return;
    }
    const resumed = await runWorkflow(workflow, { ...settings, resume: true });
    expect(await readFile(join(metadata, 'commondir'), 'utf8')).toBe('../..\n');
    expect(resumed.worktreeWarnings).toContainEqual(
      expect.stringContaining('Repaired interrupted Git worktree registration'),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(resumed.steps['edit']?.worktree?.path).not.toBe(failed.steps['edit']?.worktree?.path);
    expect(await command('show', `${String(resumed.output)}:file.txt`)).toBe('resumed edit');
    await runWorkflow(workflow, { ...settings, resume: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  },
);

it.each([
  {
    label: 'a missing commondir',
    corrupt: (metadata: string) => rm(join(metadata, 'commondir'), { force: true }),
    unchanged: async (metadata: string) => {
      await expect(readFile(join(metadata, 'commondir'), 'utf8')).rejects.toThrow();
    },
  },
  {
    label: "a 'junk' commondir",
    corrupt: (metadata: string) => writeFile(join(metadata, 'commondir'), 'junk'),
    unchanged: async (metadata: string) => {
      expect(await readFile(join(metadata, 'commondir'), 'utf8')).toBe('junk');
    },
  },
])(
  'rejects a resumed worktree registration with $label as an invalid commondir',
  async ({ corrupt, unchanged }) => {
    let metadata = '',
      interrupted = false;
    const breakingRunner: ProcessRunner = {
      async run(request, invocation) {
        const result = await processRunner.run(request, invocation);
        if (
          !interrupted &&
          Array.isArray(request.command) &&
          request.command.includes('worktree') &&
          request.command.includes('add')
        ) {
          interrupted = true;
          const path = z.string().parse(request.command.at(-2));
          metadata = resolve(
            path,
            (await readFile(join(path, '.git'), 'utf8')).replace(/^gitdir: /u, '').trimEnd(),
          );
          await corrupt(metadata);
          throw new Error('fixture interrupted registration');
        }
        return result;
      },
    };
    const invoke = vi.fn<Harness['invoke']>(async (request) => {
      await writeFile(join(request.cwd, 'file.txt'), 'resumed edit\n');
      return response;
    });
    const workflow = defineWorkflow({
      name: 'planned-registration-invalid-commondir',
      version: '1',
      input: z.null(),
      output: z.string(),
      async run(ctx) {
        const result = await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
        assert(result.worktree?.commit);
        return result.worktree.commit;
      },
    });
    const settings = {
      ...options('planned-registration-invalid-commondir'),
      harness: { invoke },
      worktrees: { root, keep: 'all' as const },
    };
    await expect(
      runWorkflow(workflow, { ...settings, input: null, processRunner: breakingRunner }),
    ).rejects.toThrow('fixture interrupted registration');
    expect(invoke).not.toHaveBeenCalled();
    const rejection: unknown = await runWorkflow(workflow, {
      ...settings,
      resume: true,
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).cause).toBeInstanceOf(ConfigurationError);
    expect((rejection as Error).message).toContain('invalid commondir');
    await unchanged(metadata);
    expect(invoke).not.toHaveBeenCalled();
  },
);

it.each([
  {
    label: 'a symlinked commondir',
    corrupt: async (metadata: string) => {
      const elsewhere = join(dirname(metadata), 'elsewhere-commondir');
      await writeFile(elsewhere, '../..\n');
      await rm(join(metadata, 'commondir'), { force: true });
      await symlink(elsewhere, join(metadata, 'commondir'));
    },
  },
  {
    label: 'an oversized gitdir backlink',
    corrupt: (metadata: string) => writeFile(join(metadata, 'gitdir'), '../..\n'.repeat(1000)),
  },
  {
    label: 'a non-UTF-8 gitdir backlink',
    corrupt: (metadata: string) =>
      writeFile(join(metadata, 'gitdir'), Buffer.from([0xff, 0xfe, 0xfd])),
  },
])('rejects a resumed worktree registration with $label as malformed', async ({ corrupt }) => {
  let interrupted = false;
  const breakingRunner: ProcessRunner = {
    async run(request, invocation) {
      const result = await processRunner.run(request, invocation);
      if (
        !interrupted &&
        Array.isArray(request.command) &&
        request.command.includes('worktree') &&
        request.command.includes('add')
      ) {
        interrupted = true;
        const path = z.string().parse(request.command.at(-2));
        const metadata = resolve(
          path,
          (await readFile(join(path, '.git'), 'utf8')).replace(/^gitdir: /u, '').trimEnd(),
        );
        await corrupt(metadata);
        throw new Error('fixture interrupted registration');
      }
      return result;
    },
  };
  const invoke = vi.fn<Harness['invoke']>(async (request) => {
    await writeFile(join(request.cwd, 'file.txt'), 'resumed edit\n');
    return response;
  });
  const workflow = defineWorkflow({
    name: 'planned-registration-malformed',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const result = await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
      assert(result.worktree?.commit);
      return result.worktree.commit;
    },
  });
  const settings = {
    ...options('planned-registration-malformed'),
    harness: { invoke },
    worktrees: { root, keep: 'all' as const },
  };
  await expect(
    runWorkflow(workflow, { ...settings, input: null, processRunner: breakingRunner }),
  ).rejects.toThrow('fixture interrupted registration');
  expect(invoke).not.toHaveBeenCalled();
  const rejection: unknown = await runWorkflow(workflow, {
    ...settings,
    resume: true,
  }).catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).cause).toBeInstanceOf(ConfigurationError);
  expect((rejection as Error).message).toContain('malformed');
  expect(invoke).not.toHaveBeenCalled();
});

it('surfaces an aborted signal from worktree registration recovery as cancellation, not a configuration error', async () => {
  // Exercising this precisely through a full interrupted `git worktree add` plus a real-time
  // abort would race the recovery's own fs reads. Driving the exported recovery function
  // directly against a synthetic, already-planned registration lets the abort be deterministic.
  const cachePath = join(root, 'owned-run-ns', 'leaf');
  const common = join(directory, 'common-repo');
  const metadata = join(common, 'worktrees', 'leaf');
  await mkdir(cachePath, { recursive: true });
  await mkdir(metadata, { recursive: true });
  await writeFile(join(cachePath, '.git'), `gitdir: ${metadata}\n`);
  await writeFile(join(metadata, 'gitdir'), `${join(cachePath, '.git')}\n`);
  await writeFile(join(metadata, 'commondir'), '');
  const ledger: WorktreeLedger = {
    namespace: 'ns',
    repo: repo,
    root,
    caches: {
      leaf: { path: cachePath, stepId: 'leaf', attempt: 1, state: 'planned', outcome: 'running' },
    },
    handles: {},
    refs: {},
  };
  const controller = new AbortController();
  controller.abort(new Error('recovery cancelled'));
  const rejection: unknown = await repairWorktreeRegistrations(
    ledger,
    'owned-run',
    common,
    controller.signal,
  ).catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toBe('recovery cancelled');
  expect(rejection).not.toBeInstanceOf(ConfigurationError);
});

it('throws ConfigurationError when a resumed worktree registration is missing its metadata directory', async () => {
  let interrupted = false;
  const breakingRunner: ProcessRunner = {
    async run(request, invocation) {
      const result = await processRunner.run(request, invocation);
      if (
        !interrupted &&
        Array.isArray(request.command) &&
        request.command.includes('worktree') &&
        request.command.includes('add')
      ) {
        interrupted = true;
        const path = z.string().parse(request.command.at(-2));
        const metadata = resolve(
          path,
          (await readFile(join(path, '.git'), 'utf8')).replace(/^gitdir: /u, '').trimEnd(),
        );
        // The checkout's `.git` pointer survives while Git's own metadata directory was only
        // partially created (or removed) before the interruption.
        await rm(metadata, { recursive: true, force: true });
        throw new Error('fixture interrupted registration');
      }
      return result;
    },
  };
  const invoke = vi.fn<Harness['invoke']>(async (request) => {
    await writeFile(join(request.cwd, 'file.txt'), 'resumed edit\n');
    return response;
  });
  const workflow = defineWorkflow({
    name: 'planned-registration-missing-metadata',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const result = await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
      assert(result.worktree?.commit);
      return result.worktree.commit;
    },
  });
  const settings = {
    ...options('planned-registration-missing-metadata'),
    harness: { invoke },
    worktrees: { root, keep: 'all' as const },
  };
  await expect(
    runWorkflow(workflow, { ...settings, input: null, processRunner: breakingRunner }),
  ).rejects.toThrow('fixture interrupted registration');
  expect(invoke).not.toHaveBeenCalled();
  const rejection: unknown = await runWorkflow(workflow, {
    ...settings,
    resume: true,
  }).catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).cause).toBeInstanceOf(ConfigurationError);
  expect((rejection as Error).message).toContain('metadata is missing');
  expect(invoke).not.toHaveBeenCalled();
});

it('keeps a resumed different-owner worktree registration a configuration failure that a retried, settled map cannot journal', async () => {
  // First interrupt and corrupt the planned registration exactly as the plain-call case does,
  // then resume with the *same* step wrapped in a retry policy under an onError: 'return' map.
  // Recovery runs in `ledger()` before the harness ever launches, so it must still surface as a
  // fatal ConfigurationError: never retried by the call's own policy, never journaled as the
  // map item's settled outcome.
  let metadata = '',
    interrupted = false;
  const breakingRunner: ProcessRunner = {
    async run(request, invocation) {
      const result = await processRunner.run(request, invocation);
      if (
        !interrupted &&
        Array.isArray(request.command) &&
        request.command.includes('worktree') &&
        request.command.includes('add')
      ) {
        interrupted = true;
        const path = z.string().parse(request.command.at(-2));
        metadata = resolve(
          path,
          (await readFile(join(path, '.git'), 'utf8')).replace(/^gitdir: /u, '').trimEnd(),
        );
        await writeFile(join(metadata, 'commondir'), '');
        await writeFile(join(metadata, 'gitdir'), join(directory, 'someone-else', '.git') + '\n');
        throw new Error('fixture interrupted registration');
      }
      return result;
    },
  };
  const invoke = vi.fn<Harness['invoke']>(async (request) => {
    await writeFile(join(request.cwd, 'file.txt'), 'resumed edit\n');
    return response;
  });
  const setup = defineWorkflow({
    name: 'planned-registration-settle',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const result = await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
      assert(result.worktree?.commit);
      return result.worktree.commit;
    },
  });
  const settled = defineWorkflow({
    name: 'planned-registration-settle',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const [result] = await ctx.map(
        'items',
        ['only'],
        { concurrency: 1, onError: 'return' },
        async () =>
          ctx.codex.text('edit', {
            prompt: 'edit',
            worktree: true,
            onError: 'return',
            retry: { maxAttempts: 3, delayMs: 0 },
          }),
      );
      if (!result?.ok || !result.value.ok) throw new Error('isolated call did not complete');
      assert(result.value.value.worktree?.commit);
      return result.value.value.worktree.commit;
    },
  });
  const settings = {
    ...options('planned-registration-settle'),
    harness: { invoke },
    worktrees: { root, keep: 'all' as const },
  };
  await expect(
    runWorkflow(setup, { ...settings, input: null, processRunner: breakingRunner }),
  ).rejects.toThrow('fixture interrupted registration');
  expect(invoke).not.toHaveBeenCalled();
  const failed = await readRun(settings);
  expect(Object.values(failed.worktrees?.caches ?? {}).map((cache) => cache.state)).toEqual([
    'planned',
  ]);

  const rejection: unknown = await runWorkflow(settled, { ...settings, resume: true }).catch(
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).cause).toBeInstanceOf(ConfigurationError);
  expect((rejection as Error).message).toContain('different checkout owner');
  expect(await readFile(join(metadata, 'commondir'), 'utf8')).toBe('');
  expect(invoke).not.toHaveBeenCalled();
  const resumedFailed = await readRun(settings);
  const step = resumedFailed.steps['items/0/edit'];
  expect(step?.status).toBe('failed');
  expect(step?.attempts).toBe(1);
  expect(resumedFailed.maps?.['items']?.items[0]).toMatchObject({
    status: 'running',
    outcome: null,
  });
});

it('serializes sibling Git registrations while retaining concurrent isolated effects', async () => {
  let active = 0,
    maximum = 0;
  const observing: ProcessRunner = {
    async run(request, invocation) {
      const adding =
        Array.isArray(request.command) &&
        request.command.includes('worktree') &&
        request.command.includes('add');
      if (!adding) return processRunner.run(request, invocation);
      maximum = Math.max(maximum, ++active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await processRunner.run(request, invocation);
      } finally {
        active--;
      }
    },
  };
  const workflow = defineWorkflow({
    name: 'concurrent-registration',
    version: '1',
    input: z.null(),
    output: z.array(z.string()),
    run: (ctx) =>
      ctx.map('items', ['a', 'b'], { concurrency: 2 }, (item) =>
        ctx.codex.value('edit', { prompt: item, worktree: true }),
      ),
  });
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const result = await runWorkflow(workflow, {
    ...options('concurrent-registration'),
    input: null,
    processRunner: observing,
    harness: { invoke },
  });
  expect(result.output).toEqual(['done', 'done']);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(maximum).toBe(1);
});

/** A finished run with one kept cache for `workflow clean` to remove. */
async function runWithCache(runId: string): Promise<string> {
  const workflow = defineWorkflow({
    name: runId,
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.worktree('cache');
      return null;
    },
  });
  const run = await runWorkflow(workflow, {
    ...options(runId),
    input: null,
    worktrees: { root, keep: 'all' },
  });
  const [cache] = Object.values(run.worktrees?.caches ?? {});
  assert(cache);
  return cache.path;
}

/** Forwards to real Git, timestamping each worktree administration command as it starts. */
function timestampingRunner(started: { verb: string; at: number }[]): ProcessRunner {
  return {
    run(request, invocation) {
      const command: readonly string[] = 'shell' in request.command ? [] : request.command;
      const at = command.indexOf('worktree');
      const verb = at < 0 ? undefined : command[at + 1];
      if (verb !== undefined) started.push({ verb, at: Date.now() });
      return processRunner.run(request, invocation);
    },
  };
}

it('clean waits for another process holding the repository administration lock', async () => {
  const path = await runWithCache('clean-waits');
  const holder = holdAdminLock(await realpath(join(repo, '.git')), 300);
  await holder.held;
  const started: { verb: string; at: number }[] = [];
  const result = await cleanWorktrees(
    { runId: 'clean-waits', stateDir },
    timestampingRunner(started),
  );
  const released = await holder.released;
  expect(result).toMatchObject({ directories: [path], warnings: [] });
  expect(started.map(({ verb }) => verb)).toEqual(['list', 'remove']);
  for (const { at } of started) expect(at).toBeGreaterThanOrEqual(released);
  expect((await holder.exited).code).toBe(0);
});

it('clean recovers the administration lock of a holder killed while it waits', async () => {
  const path = await runWithCache('clean-recovers');
  const common = await realpath(join(repo, '.git'));
  const holder = holdAdminLock(common, 'forever');
  await holder.held;
  const started: { verb: string; at: number }[] = [];
  const cleaning = cleanWorktrees(
    { runId: 'clean-recovers', stateDir },
    timestampingRunner(started),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const killed = Date.now();
  holder.child.kill('SIGKILL');
  expect((await holder.exited).signal).toBe('SIGKILL');
  expect(await cleaning).toMatchObject({ directories: [path], warnings: [] });
  expect(started.map(({ verb }) => verb)).toEqual(['list', 'remove']);
  for (const { at } of started) expect(at).toBeGreaterThanOrEqual(killed);
  expect(await readdir(join(common, 'quiet-choir'))).toEqual([]);
});

it('clean warns instead of hanging when another process holds the administration lock too long', async () => {
  const path = await runWithCache('clean-bounded');
  const common = await realpath(join(repo, '.git'));
  const holder = holdAdminLock(common, 'forever');
  await holder.held;
  const original = cleanupAdminWait.ms;
  cleanupAdminWait.ms = 200;
  try {
    const started: { verb: string; at: number }[] = [];
    const result = await cleanWorktrees(
      { runId: 'clean-bounded', stateDir },
      timestampingRunner(started),
    );
    expect(result.directories).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(
      `Timed out waiting for the worktree administration lock at ${join(common, 'quiet-choir', 'worktree-admin.lock')}`,
    );
    expect(started.map(({ verb }) => verb)).not.toContain('remove');
  } finally {
    cleanupAdminWait.ms = original;
    holder.child.kill('SIGKILL');
    await holder.exited;
  }
  expect(await readdir(path).then(() => true)).toBe(true);
});

it('invokes definition setup for per-call attempts and handle create and prepare, with RunOptions overriding field by field', async () => {
  const calls: string[] = [];
  const definitionSetup = vi.fn(({ stepId }: { stepId: string }) => {
    calls.push(`definition:${stepId}`);
  });
  const workflow = defineWorkflow({
    name: 'definition-policy',
    version: '1',
    input: z.null(),
    output: z.null(),
    worktrees: { keep: 'all', setup: definitionSetup },
    async run(ctx) {
      await ctx.claude.text('agent', { prompt: 'edit', worktree: true });
      const handle = await ctx.worktree('cache');
      await ctx.step('handle-step', {
        input: null,
        worktree: handle,
        schema: z.null(),
        run: () => null,
      });
      return null;
    },
  });
  const harness: Harness = { invoke: () => Promise.resolve(response) };
  const defined = await runWorkflow(workflow, { ...options('defined'), harness, input: null });
  expect(calls).toEqual(['definition:agent', 'definition:cache', 'definition:handle-step']);
  // keep: 'all' from the definition retains every cache after completion.
  for (const cache of Object.values(defined.worktrees?.caches ?? {}))
    expect((await lstat(cache.path)).isDirectory()).toBe(true);

  calls.length = 0;
  const overridden = await runWorkflow(workflow, {
    ...options('overridden'),
    harness,
    input: null,
    worktrees: {
      root,
      setup: ({ stepId }) => {
        calls.push(`option:${stepId}`);
      },
    },
  });
  expect(calls).toEqual(['option:agent', 'option:cache', 'option:handle-step']);
  // The option replaced setup only; the definition's keep: 'all' still applies.
  const caches = Object.values(overridden.worktrees?.caches ?? {});
  expect(caches.length).toBeGreaterThan(0);
  for (const cache of caches) expect(cache.state).toBe('ready');
});

it('excludes a setup-created node_modules symlink from capture across a resume before the merge', async () => {
  const base = await command('rev-parse', 'HEAD');
  const deps = join(directory, 'deps');
  await mkdir(deps);
  let failTail = true;
  const harness: Harness = {
    invoke: async (request) => {
      await writeFile(join(request.cwd, 'a.ts'), 'export const a = 1;\n');
      return response;
    },
  };
  const workflow = defineWorkflow({
    name: 'setup-symlink',
    version: '1',
    input: z.null(),
    output: z.string(),
    worktrees: {
      setup: async ({ path }) => {
        await symlink(deps, join(path, 'node_modules'));
      },
    },
    async run(ctx) {
      const call = await ctx.claude.text('agent', { prompt: 'edit', worktree: true });
      assert(call.worktree);
      const handle = await ctx.worktree('cache');
      await ctx.step('first', {
        input: null,
        worktree: handle,
        schema: z.null(),
        run: async ({ cwd }) => {
          await writeFile(join(cwd, 'h1.txt'), 'one\n');
          return null;
        },
      });
      await ctx.step('gate', {
        input: null,
        schema: z.null(),
        run: () => {
          if (failTail) throw new Error('gate');
          return null;
        },
      });
      // Prepared again after the resume: reset, clean, then setup recreates the link.
      await ctx.step('second', {
        input: null,
        worktree: handle,
        schema: z.null(),
        run: async ({ cwd }) => {
          await writeFile(join(cwd, 'h2.txt'), 'two\n');
          return null;
        },
      });
      return (
        await ctx.merge('integrate', [call.worktree, handle], {
          target: { branch: 'ticket-42' },
          strategy: 'squash',
        })
      ).commit;
    },
  });
  await expect(
    runWorkflow(workflow, { ...options('symlink'), harness, input: null }),
  ).rejects.toThrow('gate');
  const saved = await readRun({ stateDir, runId: 'symlink' });
  expect(saved.steps['agent']?.worktree?.files).toEqual([{ path: 'a.ts', status: 'added' }]);
  expect(saved.steps['first']?.worktree?.files).toEqual([{ path: 'h1.txt', status: 'added' }]);
  const agentPath = saved.steps['agent']?.worktree?.path;
  const handlePath = saved.steps['first']?.worktree?.path;
  assert(agentPath && handlePath);
  const caches = Object.values(saved.worktrees?.caches ?? {});
  expect(caches.find((cache) => cache.path === agentPath)?.setupPaths).toEqual(['node_modules']);
  expect(caches.find((cache) => cache.path === handlePath)?.setupPaths).toEqual(['node_modules']);
  failTail = false;
  const resumed = await runWorkflow(workflow, { ...options('symlink'), harness, resume: true });
  expect(resumed.steps['agent']?.attempts).toBe(1);
  expect(resumed.steps['second']?.worktree?.files).toEqual([
    { path: 'h1.txt', status: 'added' },
    { path: 'h2.txt', status: 'added' },
  ]);
  expect(await command('rev-parse', 'refs/heads/ticket-42')).toBe(resumed.output);
  expect((await command('diff', '--name-only', base, 'ticket-42')).split('\n')).toEqual([
    'a.ts',
    'h1.txt',
    'h2.txt',
  ]);
  expect(resumed.warnings ?? []).toEqual([]);
});

it('honours captureExclude globs and still captures agent files elsewhere', async () => {
  const harness: Harness = {
    invoke: async (request) => {
      await writeFile(join(request.cwd, 'debug.log'), 'noise\n');
      await mkdir(join(request.cwd, 'tmp'), { recursive: true });
      await writeFile(join(request.cwd, 'tmp', 'x'), 'scratch\n');
      await mkdir(join(request.cwd, 'src'), { recursive: true });
      await writeFile(join(request.cwd, 'src', 'b.ts'), 'export {};\n');
      await writeFile(join(request.cwd, 'src', 'nested.log'), 'noise\n');
      return response;
    },
  };
  const workflow = defineWorkflow({
    name: 'capture-exclude',
    version: '1',
    input: z.null(),
    output: z.null(),
    worktrees: { captureExclude: ['**/*.log', 'tmp/**'] },
    async run(ctx) {
      await ctx.claude.text('agent', { prompt: 'edit', worktree: true });
      return null;
    },
  });
  const run = await runWorkflow(workflow, { ...options('exclude'), harness, input: null });
  expect(run.steps['agent']?.worktree?.files).toEqual([{ path: 'src/b.ts', status: 'added' }]);
});

it('warns about captured symlinks that point outside the repository, but not setup or in-tree links', async () => {
  const harness: Harness = {
    invoke: async (request) => {
      await symlink('/tmp/elsewhere', join(request.cwd, 'link'));
      await symlink('../../outside', join(request.cwd, 'rel'));
      await symlink('file.txt', join(request.cwd, 'inside'));
      return response;
    },
  };
  const workflow = defineWorkflow({
    name: 'symlink-warning',
    version: '1',
    input: z.null(),
    output: z.null(),
    worktrees: {
      setup: async ({ path }) => {
        await symlink('/tmp', join(path, 'node_modules'));
      },
    },
    async run(ctx) {
      await ctx.claude.text('agent', { prompt: 'edit', worktree: true });
      return null;
    },
  });
  const run = await runWorkflow(workflow, { ...options('links'), harness, input: null });
  expect(run.steps['agent']?.worktree?.files.map(({ path }) => path)).toEqual([
    'inside',
    'link',
    'rel',
  ]);
  const expected = [
    'Step agent captured symlink link -> /tmp/elsewhere, which points outside the repository; create it from worktrees.setup or list it in worktrees.captureExclude to keep it out of the snapshot.',
    'Step agent captured symlink rel -> ../../outside, which points outside the repository; create it from worktrees.setup or list it in worktrees.captureExclude to keep it out of the snapshot.',
  ];
  expect(run.warnings).toEqual(expected);
  expect((await inspectRun(options('links'))).summary.warnings).toEqual(expected);
});

it('warns when a resume asks for a different root than the one the run pinned', async () => {
  const workflow = defineWorkflow({
    name: 'pinned-root',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      const handle = await ctx.worktree('cache');
      await ctx.step('tail', {
        input: null,
        worktree: handle,
        schema: z.null(),
        run: ({ attempt }) => {
          if (attempt === 1) throw new Error('tail');
          return null;
        },
      });
      return null;
    },
  });
  await expect(runWorkflow(workflow, { ...options('pinned'), input: null })).rejects.toThrow(
    'tail',
  );
  const elsewhere = join(directory, 'elsewhere');
  const resumed = await runWorkflow(workflow, {
    ...options('pinned'),
    worktrees: { root: elsewhere },
    resume: true,
  });
  const pinned = await realpath(root);
  expect(resumed.worktrees?.root).toBe(pinned);
  expect(resumed.warnings).toEqual([
    `worktrees.root ${elsewhere} differs from the cache root ${pinned} this run pinned on first use; the run keeps using ${pinned}.`,
  ]);
});

it('keeps definition-level worktree policy out of step identity across resumes', async () => {
  let fail = true;
  const harness: Harness = { invoke: () => Promise.resolve(response) };
  const define = (worktrees: { keep: 'all' | 'none'; captureExclude: string[] }) =>
    defineWorkflow({
      name: 'policy-identity',
      version: '1',
      input: z.null(),
      output: z.null(),
      worktrees,
      async run(ctx) {
        await ctx.claude.text('agent', { prompt: 'edit', worktree: true });
        await ctx.step('tail', {
          input: null,
          schema: z.null(),
          run: () => {
            if (fail) throw new Error('tail');
            return null;
          },
        });
        return null;
      },
    });
  await expect(
    runWorkflow(define({ keep: 'all', captureExclude: [] }), {
      ...options('identity'),
      harness,
      input: null,
    }),
  ).rejects.toThrow('tail');
  const before = (await readRun({ stateDir, runId: 'identity' })).steps['agent']?.fingerprint;
  fail = false;
  const resumed = await runWorkflow(define({ keep: 'none', captureExclude: ['*.log'] }), {
    ...options('identity'),
    harness: {
      invoke: () => {
        throw new Error('unexpected agent');
      },
    },
    resume: true,
  });
  expect(resumed.status).toBe('completed');
  expect(resumed.steps['agent']?.attempts).toBe(1);
  expect(resumed.steps['agent']?.fingerprint).toBe(before);
  expect(resumed.codeChanges ?? []).toEqual([]);
  // keep: 'none' from the changed definition removed the retained cache.
  for (const cache of Object.values(resumed.worktrees?.caches ?? {}))
    expect(cache.state).toBe('removed');
});
