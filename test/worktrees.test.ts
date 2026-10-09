import { FileRunStore } from '../src/workflow/runtime/run-store.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { ThresholdLogger } from '../src/application/execution.js';
import { inspectRun, runFailureKind } from '../src/workflow/loader/inspection.js';
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
  utimes,
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
  type WorktreeChange,
  type WorktreeHandle,
  type WorktreeLedger,
  type ProcessRunner,
  type RunOptions,
  type WorkflowContext,
  type WorkflowEvent,
  type MergeOptions,
  type MergeResult,
  type Settled,
  ReplaySkippedError,
  StepIdentityChangedError,
} from '../src/index.js';
import { findAcceptedReplayDivergence } from '../src/workflow/runtime/run-errors.js';
import { isAcceptedReplayRefusal } from '../src/workflow/runtime/accepted-replay-preflight.js';
import { WorktreeGit } from '../src/worktrees/git.js';
import {
  RunWorktrees,
  cleanupAdminWait,
  defaultWorktreeRoot,
  queueAdministration,
  uncommittedSourceWarning,
} from '../src/workflow/runtime/worktrees.js';
import { worktreeAdminLockPath } from '../src/workflow/runtime/worktree-admin-lock.js';
import { repairWorktreeRegistrations } from '../src/workflow/runtime/worktree-recovery.js';
import { cleanWorktrees } from '../src/workflow/runtime/worktree-clean.js';
import { rehearsalState } from '../src/workflow/loader/rehearsal.js';
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
  const replayed = await runWorkflow(definition, {
    ...options('mono'),
    input: null,
    harness,
    resume: true,
  });
  expect(replayed.warnings).toEqual(run.warnings);
  expect(run.steps['edit']?.worktree?.files).toEqual([{ path: 'packages/a/new', status: 'added' }]);
});

// Three isolated calls and a merge serialize every worktree add/list/remove behind the admin lock,
// so Git process latency under load adds up. measured: 1.6 s alone, 3.2 s worst of three full
// coverage runs, 4.4 s with a CPU hog on every core, 0.7-1.6 s on the CI legs (#245 saw 10.5 s at
// load average 15-20).
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
}, 15_000);

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

// Pre-#340 spellings still run and fingerprint like their replacements, so a checkpoint recorded
// with one resumes after the source migrates; #126 refuses acceptCodeChange if identities diverge.
it.each([
  ['isolation worktree', () => ({ isolation: 'worktree' }), () => ({ worktree: true })],
  [
    'isolation kind with a branch base',
    () => ({ isolation: { kind: 'worktree', base: 'feature' } }),
    () => ({ worktree: { base: 'feature' } }),
  ],
  [
    'isolation kind with a commit base',
    (base: string) => ({ isolation: { kind: 'worktree', base: { commit: base } } }),
    (base: string) => ({ worktree: { base: { commit: base } } }),
  ],
  ['worktree true', () => ({ worktree: true }), () => ({ worktree: true })],
] as const)(
  'resumes a checkpoint recorded with %s after migrating to the worktree spelling',
  async (_name, recorded, migrated) => {
    const base = await command('rev-parse', 'HEAD');
    await command('branch', 'feature');
    const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
    const definition = (selection: object, fail: boolean) =>
      defineWorkflow({
        name: 'migrated-selection',
        version: '1',
        input: z.null(),
        output: z.string(),
        async run(ctx) {
          const result = await ctx.claude.text('edit', { prompt: 'edit', ...selection });
          if (fail) throw new Error('tail failure');
          return result.output;
        },
      });
    const run = { ...options('migrated'), harness: { invoke }, input: null };
    await expect(
      runWorkflow(definition(recorded(base), true), { ...run, fingerprint: 'code-1' }),
    ).rejects.toThrow('tail failure');
    const before = (await readRun({ stateDir, runId: 'migrated' })).steps['edit'];
    expect(before?.worktree?.base).toBe(base);
    // Moving HEAD and the branch proves the resume reuses the recorded base.
    await writeFile(join(repo, 'file.txt'), 'moved\n');
    await command('branch', '-f', 'feature', await commit('move head'));
    const result = await runWorkflow(definition(migrated(base), false), {
      ...run,
      resume: true,
      fingerprint: 'code-2',
      acceptCodeChange: true,
    });
    expect(result.status).toBe('completed');
    expect(invoke).toHaveBeenCalledTimes(1);
    const after = (await readRun({ stateDir, runId: 'migrated' })).steps['edit'];
    expect(after?.fingerprint).toBe(before?.fingerprint);
    expect(after?.worktree?.base).toBe(base);
  },
);

it('refuses a worktree together with a legacy worktree isolation before invoking a harness', async () => {
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const handle = { id: 'h-1', path: join(root, 'h-1'), base: await command('rev-parse', 'HEAD') };
  for (const [index, isolation] of ['worktree', handle].entries()) {
    const definition = defineWorkflow({
      name: 'both-selections',
      version: '1',
      input: z.null(),
      output: z.string(),
      async run(ctx) {
        return (
          await ctx.claude.text('edit', {
            prompt: 'edit',
            worktree: true,
            isolation: isolation as never,
          })
        ).output;
      },
    });
    await expect(
      runWorkflow(definition, {
        ...options(`both-${String(index)}`),
        harness: { invoke },
        input: null,
      }),
    ).rejects.toThrow(
      'Choose worktree or a legacy worktree isolation value, not both; use worktree: true | { base } | handle.',
    );
  }
  expect(invoke).not.toHaveBeenCalled();
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

it('settles a failing merge with onError return and replays it without touching Git', async () => {
  const harness: Harness = {
    invoke: async (request) => {
      await writeFile(join(request.cwd, 'file.txt'), request.options.prompt);
      return response;
    },
  };
  let tail = true;
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
      const changes = [one.worktree, two.worktree];
      const failed = await ctx.merge('publish', changes, {
        onConflict: 'fail',
        target: { branch: 'fail-result' },
        onError: 'return',
      });
      // The default onConflict: 'report' result is the same data in either error mode.
      const reported = await ctx.merge('report', changes, {
        target: { branch: 'report-return' },
        onError: 'return',
      });
      const thrown = await ctx.merge('report-throw', changes, {
        target: { branch: 'report-throw' },
      });
      if (tail) throw new Error('tail');
      return { failed, reported, thrown };
    },
  });
  await expect(
    runWorkflow(workflow, { ...options('settled-merge'), input: null, harness }),
  ).rejects.toThrow('tail');
  const first = await readRun(options('settled-merge'));
  const step = first.steps['publish'];
  expect(step?.status).toBe('settled-failed');
  expect(step?.settledError?.message).toContain('conflicts');
  expect(step?.merge?.result).toBeUndefined();
  await expect(command('rev-parse', '--verify', 'refs/heads/fail-result')).rejects.toThrow();
  const refs = await command('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  // A live merge would now see a moved source branch; the settled outcome must replay instead.
  await writeFile(join(repo, 'later'), 'new HEAD');
  await commit('advance source');
  const head = await command('rev-parse', 'HEAD');
  const commands: string[][] = [];
  const recording: ProcessRunner = {
    run: (request, invocation) => {
      commands.push('shell' in request.command ? [request.command.shell] : [...request.command]);
      return processRunner.run(request, invocation);
    },
  };
  const started: string[] = [];
  tail = false;
  const resumed = await runWorkflow(workflow, {
    ...options('settled-merge'),
    processRunner: recording,
    resume: true,
    harness,
    onEvent: (event) => {
      if (event.type === 'step.started') started.push(event.stepId);
    },
  });
  const output = resumed.output as unknown as {
    failed: Settled<MergeResult>;
    reported: Settled<MergeResult>;
    thrown: MergeResult;
  };
  expect(output.failed).toEqual({ ok: false, error: step?.settledError });
  assert(output.reported.ok);
  expect(output.reported.value.conflicts).toEqual(output.thrown.conflicts);
  expect(output.reported.value.conflicts).toHaveLength(1);
  expect(output.reported.value.merged).toEqual(output.thrown.merged);
  expect(started).toEqual([]);
  expect(resumed.steps['publish']?.attempts).toBe(step?.attempts);
  // The resume runs no Git command through the run's process runner at all.
  expect(commands).toEqual([]);
  expect(await command('rev-parse', 'HEAD')).toBe(head);
  expect(
    (await command('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'))
      .split('\n')
      .filter(
        (line) => !line.startsWith('refs/heads/main ') && !line.startsWith('refs/heads/master '),
      ),
  ).toEqual(
    refs
      .split('\n')
      .filter(
        (line) => !line.startsWith('refs/heads/main ') && !line.startsWith('refs/heads/master '),
      ),
  );
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
/**
 * The read-only listing that detects a partial clone, which a dry-run runs once before its first
 * `status` read or merge preview over captured commits.
 */
const partialCloneListing = [
  'config',
  '--name-only',
  '--get-regexp',
  '^(extensions\\.partialclone|remote\\..*\\.promisor)$',
];
/**
 * The reads besides rev-parse that a dry-run without a ledger makes first, as the real ledger's
 * initialization does: the Git version and the source checkout's status (#312), which the
 * partial-clone listing precedes.
 */
const ledgerReads = [
  ['--version'],
  partialCloneListing,
  ['status', '--porcelain', '--untracked-files=normal', '--no-renames'],
];
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

it('synthesizes isolated calls and their merge under dry-run with read-only Git reads only', async () => {
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
    // Besides rev-parse, only the real ledger's version and status reads ran (#312), once: concurrent
    // calls shared them, and one repository and HEAD resolution.
    expect(spy.commands.filter((args) => args[0] !== 'rev-parse')).toEqual(ledgerReads);
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
        merged: [],
        conflicts: [],
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
  ['ctx.worktree', 'cache', 'worktree', (ctx: WorkflowContext) => ctx.worktree('cache')],
  [
    'exec on a handle',
    'probe',
    'exec',
    (ctx: WorkflowContext, handle: WorktreeHandle) =>
      ctx.exec('probe', ['true'], { worktree: handle }),
  ],
  [
    'a local step on a handle',
    'local',
    'step',
    (ctx: WorkflowContext, handle: WorktreeHandle) =>
      ctx.step('local', { input: null, schema: z.null(), worktree: handle, run: () => null }),
  ],
  [
    'an agent on a handle',
    'edit',
    'codex',
    (ctx: WorkflowContext, handle: WorktreeHandle) =>
      ctx.codex.text('edit', { prompt: 'edit', worktree: handle }),
  ],
] as const)(
  'still refuses %s under dry-run before any Git',
  async (_name, stepId, effect, body) => {
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
    const events: WorkflowEvent[] = [];
    const failure: unknown = await runWorkflow(workflow, {
      ...options('dry-refused'),
      input: null,
      rehearsal: {},
      harness: { kind: 'dry-run', invoke },
      processRunner: spy.runner,
      onEvent: (event) => {
        events.push(event);
      },
    }).catch((error: unknown) => error);
    expect((failure as Error).cause).toBeInstanceOf(ConfigurationError);
    expect((failure as Error).message).toContain(
      'Dry-run does not simulate this Git worktree effect',
    );
    expect((failure as Error).message).toContain('fixture harness in a temporary repository');
    expect(spy.commands).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    // The refusal comes before any attempt, so the root cause, not an attempt, carries its kind (#311).
    const saved = await readRun({ stateDir, runId: 'dry-refused' });
    expect(saved.steps[stepId]?.attemptHistory ?? []).toEqual([]);
    expect(saved.rootCause).toMatchObject({ stepId, errorKind: 'configuration', effect });
    expect(events.filter((event) => event.type === 'run.failed')).toEqual([
      expect.objectContaining({ stepId, errorKind: 'configuration' }),
    ]);
    const { summary } = await inspectRun(options('dry-refused'));
    expect(runFailureKind(summary)).toEqual({ errorKind: 'configuration', retryable: false });
  },
);

/** Loose and packed object counts, which any object written into the repository changes. */
async function objectCounts(): Promise<string> {
  return (await command('count-objects', '-v'))
    .split('\n')
    .filter((line) => /^(?:count|size|in-pack|packs|size-pack):/u.test(line))
    .join('\n');
}
/** Everything a merge preview must leave alone: objects, refs, registered worktrees and caches. */
async function repositoryState(): Promise<Record<string, unknown>> {
  return { ...(await gitState()), objects: await objectCounts() };
}
const quarantinePrefix = 'quiet-choir-rehearsal-objects-';
/** Point os.tmpdir() at a fresh directory, so a test sees the rehearsal's quarantine directories. */
async function temporaryParent(): Promise<() => Promise<string[]>> {
  const parent = join(directory, 'tmp');
  await mkdir(parent);
  vi.stubEnv('TMPDIR', parent);
  return async () => (await readdir(parent)).filter((name) => name.startsWith(quarantinePrefix));
}
/**
 * A runner that records each Git subcommand and the object directory it was pointed at; `version`,
 * when given, answers `git --version` in place of the installed Git.
 */
function objectSpy(version?: string) {
  const commands: { args: string[]; objects: string | undefined }[] = [];
  const runner: ProcessRunner = {
    run: (request, invocation) => {
      const argv = Array.isArray(request.command) ? [...(request.command as string[])] : [];
      const args = argv.slice(argv.indexOf('-C') + 2);
      commands.push({ args, objects: request.env['GIT_OBJECT_DIRECTORY'] });
      if (version !== undefined && args.length === 1 && args[0] === '--version')
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: `${version}\n`,
          stderr: '',
          truncated: false,
          durationMs: 0,
        });
      return processRunner.run(request, invocation);
    },
  };
  return { runner, commands };
}
/** A disposable copy of a run's checkpoint, as the CLI's dry-run resume makes. */
async function copyRun(runId: string): Promise<string> {
  const copy = await rehearsalState(runId, stateDir, true);
  copies.push(copy.dispose);
  return copy.stateDir;
}
const copies: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dispose of copies.splice(0)) await dispose();
});
/**
 * Isolated edits (each appends its step ID to file.txt), then, unless `gate.stop` is set, a merge of
 * them with `gate.options`; the output is the merge result.
 */
function capturedMerge(name: string, edits: readonly string[], gate: PreviewGate) {
  return defineWorkflow({
    name,
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const changes = [];
      for (const edit of edits) {
        const result = await ctx.codex.text(edit, { prompt: edit, worktree: true });
        if (!result.worktree?.commit) throw new Error('missing captured change');
        changes.push(result.worktree);
      }
      if (gate.stop) throw new Error('stopped before the merge');
      return JSON.stringify(await ctx.merge('integrate', changes, gate.options));
    },
  });
}
interface PreviewGate {
  stop: boolean;
  options: MergeOptions;
}
/** Dry-run options for a resume or fork in `state`, reporting merge events into `events`. */
function dryRun(runId: string, state: string, events: WorktreeEvent[], runner: ProcessRunner) {
  return {
    ...options(runId),
    stateDir: state,
    rehearsal: { onWorktree: (event: WorktreeEvent) => events.push(event) },
    harness: {
      kind: 'dry-run',
      invoke: () => Promise.reject(new Error('a replayed call was invoked')),
    } satisfies Harness,
    allowHarnessChange: true,
    processRunner: runner,
  };
}

it('previews a merge of a captured commit in a dry-run resume like the real resume, writing nothing', async () => {
  const author = { name: 'Preview', email: 'preview@localhost' };
  const gate: PreviewGate = {
    stop: true,
    options: { commit: { message: 'Preview merge', author } },
  };
  const workflow = capturedMerge('preview', ['edit'], gate);
  const harness = editingHarness();
  await expect(
    runWorkflow(workflow, { ...options('preview'), harness, input: null }),
  ).rejects.toThrow('stopped before the merge');
  const edit = (await readRun({ stateDir, runId: 'preview' })).steps['edit']?.worktree?.commit;
  assert(edit);
  const copy = await copyRun('preview');
  const before = await repositoryState();
  const quarantines = await temporaryParent();
  const spy = objectSpy();
  const events: WorktreeEvent[] = [];
  gate.stop = false;
  // A frozen clock gives the preview and the real merge the same attempt start, hence commit date.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-02T03:04:05.678Z') });
  const dry = await runWorkflow(workflow, {
    ...dryRun('preview', copy, events, spy.runner),
    resume: true,
  });
  const preview = JSON.parse(dry.output ?? 'null') as MergeResult;
  expect(preview).toMatchObject({ merged: [edit], conflicts: [] });
  expect(events).toEqual([
    expect.objectContaining({
      kind: 'merge',
      stepId: 'integrate',
      commit: preview.commit,
      merged: [edit],
      conflicts: [],
      baseSource: 'resolved',
    }),
  ]);
  // Only the partial-clone and merge-driver listings, the merge.renormalize read and the quarantined
  // commands ran (no --version outside a partial clone), and every object computation used the
  // quarantine.
  expect([...new Set(spy.commands.map(({ args }) => args[0]))].sort()).toEqual([
    'commit-tree',
    'config',
    'merge-tree',
    'rev-parse',
  ]);
  expect(spy.commands.filter(({ args }) => args[0] === 'config')).toEqual([
    { args: partialCloneListing, objects: undefined },
    {
      args: ['config', '--name-only', '--get-regexp', '^merge\\..*\\.driver$'],
      objects: undefined,
    },
    { args: ['config', '--type=bool', '--get', 'merge.renormalize'], objects: undefined },
  ]);
  for (const { args, objects } of spy.commands)
    if (args[0] !== 'rev-parse' && args[0] !== 'config')
      expect(objects?.includes(quarantinePrefix)).toBe(true);
  expect(await repositoryState()).toEqual(before);
  expect(await quarantines()).toEqual([]);
  expect(await command('cat-file', '-t', edit)).toBe('commit');
  const real = await runWorkflow(workflow, { ...options('preview'), harness, resume: true });
  vi.useRealTimers();
  // The same computation: a real resume at the same instant creates the identical commit.
  expect(JSON.parse(real.output ?? 'null')).toEqual(preview);
  expect(await command('show', `${preview.commit}:file.txt`)).toBe('base\nedit');
  expect(await command('log', '-1', '--format=%s|%an|%cn', preview.commit)).toBe(
    'Preview merge|Preview|Preview',
  );
  expect(harness.invoke).toHaveBeenCalledTimes(1);
});

it('previews a merge of a completed isolated step reused by a dry-run fork', async () => {
  const gate: PreviewGate = { stop: true, options: {} };
  const workflow = capturedMerge('fork-preview', ['edit'], gate);
  await expect(
    runWorkflow(workflow, { ...options('source'), harness: editingHarness(), input: null }),
  ).rejects.toThrow('stopped before the merge');
  const edit = (await readRun({ stateDir, runId: 'source' })).steps['edit']?.worktree?.commit;
  assert(edit);
  const target = join(directory, 'fork-state');
  const before = await repositoryState();
  const quarantines = await temporaryParent();
  const events: WorktreeEvent[] = [];
  gate.stop = false;
  const dry = await runWorkflow(workflow, {
    ...dryRun('fork', target, events, processRunner),
    forkFrom: { runId: 'source', stateDir },
    input: null,
  });
  expect(dry.steps['edit']?.reusedFrom).toBeDefined();
  const preview = JSON.parse(dry.output ?? 'null') as MergeResult;
  expect(preview).toMatchObject({ merged: [edit], conflicts: [] });
  expect(preview.commit).not.toBe(await command('rev-parse', 'HEAD'));
  expect(events).toEqual([
    expect.objectContaining({ kind: 'merge', merged: [edit], conflicts: [] }),
  ]);
  expect(await repositoryState()).toEqual(before);
  expect(await quarantines()).toEqual([]);
  // The preview's commit was discarded with the quarantine.
  const gone = await git.run(repo, ['cat-file', '-e', `${preview.commit}^{commit}`], invocation, {
    codes: [0, 1, 128],
  });
  expect(gone.code).not.toBe(0);
});

it('keeps a preview commit resolvable by later rehearsal steps', async () => {
  let stop = true;
  const workflow = defineWorkflow({
    name: 'stacked',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const edit = await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
      if (!edit.worktree?.commit) throw new Error('missing captured change');
      if (stop) throw new Error('stopped before the merge');
      const merged = await ctx.merge('integrate', [edit.worktree]);
      const review = await ctx.codex.text('review', {
        prompt: 'review',
        worktree: { base: { commit: merged.commit } },
      });
      if (!review.worktree) throw new Error('missing synthesized change');
      const again = await ctx.merge('again', [review.worktree]);
      return JSON.stringify({ merged, review: review.worktree.base, again });
    },
  });
  await expect(
    runWorkflow(workflow, { ...options('stacked'), harness: editingHarness(), input: null }),
  ).rejects.toThrow('stopped before the merge');
  const copy = await copyRun('stacked');
  const before = await repositoryState();
  stop = false;
  const events: WorktreeEvent[] = [];
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const run = await runWorkflow(workflow, {
    ...dryRun('stacked', copy, events, processRunner),
    harness: { kind: 'dry-run', invoke },
    resume: true,
  });
  const output = JSON.parse(run.output ?? 'null') as {
    merged: MergeResult;
    review: string;
    again: MergeResult;
  };
  expect(output.review).toBe(output.merged.commit);
  // An unchanged change based on the preview passes the real input check (its base resolves) and
  // integrates nothing onto the target's current commit.
  const head = await command('rev-parse', 'HEAD');
  expect(output.again).toEqual({ commit: head, merged: [], conflicts: [] });
  expect(events).toEqual([
    expect.objectContaining({ kind: 'merge', stepId: 'integrate' }),
    expect.objectContaining({
      kind: 'isolation',
      stepId: 'review',
      base: output.merged.commit,
      baseSource: 'resolved',
    }),
    expect.objectContaining({ kind: 'merge', stepId: 'again', commit: head }),
  ]);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(await repositoryState()).toEqual(before);
});

it('previews a merge of a replayed ctx.worktree handle from the copied ledger', async () => {
  let stop = true;
  const workflow = defineWorkflow({
    name: 'handle-preview',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const handle = await ctx.worktree('cache');
      await ctx.codex.text('edit', { prompt: 'edit', worktree: handle });
      if (stop) throw new Error('stopped before the merge');
      // A git-config author is resolved with `git var`, which the quarantine also runs.
      return JSON.stringify(
        await ctx.merge('integrate', [handle], {
          commit: { message: 'Handle merge', author: 'git-config' },
        }),
      );
    },
  });
  await command('config', 'user.name', 'Configured');
  await command('config', 'user.email', 'configured@localhost');
  const harness = editingHarness();
  await expect(
    runWorkflow(workflow, { ...options('handle-preview'), harness, input: null }),
  ).rejects.toThrow('stopped before the merge');
  const ledger = (await readRun({ stateDir, runId: 'handle-preview' })).worktrees;
  const latest = Object.values(ledger?.handles ?? {})[0]?.latest;
  assert(latest);
  const copy = await copyRun('handle-preview');
  const before = await repositoryState();
  const quarantines = await temporaryParent();
  stop = false;
  const events: WorktreeEvent[] = [];
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-02T03:04:05.678Z') });
  const dry = await runWorkflow(workflow, {
    ...dryRun('handle-preview', copy, events, processRunner),
    resume: true,
  });
  const preview = JSON.parse(dry.output ?? 'null') as MergeResult;
  expect(preview).toMatchObject({ merged: [latest], conflicts: [] });
  expect(events).toEqual([expect.objectContaining({ kind: 'merge', merged: [latest] })]);
  expect(await repositoryState()).toEqual(before);
  expect(await quarantines()).toEqual([]);
  const real = await runWorkflow(workflow, { ...options('handle-preview'), harness, resume: true });
  vi.useRealTimers();
  expect(JSON.parse(real.output ?? 'null')).toEqual(preview);
  expect(await command('log', '-1', '--format=%s|%an', preview.commit)).toBe(
    'Handle merge|Configured',
  );
});

it.each(['rebase', 'merge', 'squash'] as const)(
  'reports conflicting captured commits like the real %s merge, and fails like it',
  async (strategy) => {
    const gate: PreviewGate = { stop: true, options: { strategy } };
    const workflow = capturedMerge('conflicts', ['one', 'two'], gate);
    const harness = editingHarness();
    await expect(
      runWorkflow(workflow, { ...options('conflicts'), harness, input: null }),
    ).rejects.toThrow('stopped before the merge');
    const steps = (await readRun({ stateDir, runId: 'conflicts' })).steps;
    const [one, two] = ['one', 'two'].map((id) => steps[id]?.worktree?.commit);
    assert(one && two);
    const [report, fail, realFail] = [
      await copyRun('conflicts'),
      await copyRun('conflicts'),
      await copyRun('conflicts'),
    ];
    const before = await repositoryState();
    const quarantines = await temporaryParent();
    gate.stop = false;
    const events: WorktreeEvent[] = [];
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-02T03:04:05.678Z') });
    const dry = await runWorkflow(workflow, {
      ...dryRun('conflicts', report, events, processRunner),
      resume: true,
    });
    const preview = JSON.parse(dry.output ?? 'null') as MergeResult;
    expect(preview).toMatchObject({
      merged: [one],
      conflicts: [{ commit: two, files: ['file.txt'] }],
    });
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'merge',
        merged: [one],
        conflicts: [{ commit: two, files: ['file.txt'] }],
      }),
    ]);
    gate.options = { strategy, onConflict: 'fail' };
    const message = `Merge input ${two} conflicts: file.txt`;
    await expect(
      runWorkflow(workflow, { ...dryRun('conflicts', fail, [], processRunner), resume: true }),
    ).rejects.toThrow(message);
    // Neither preview wrote into the repository, and both quarantines are gone, failure included.
    expect(await repositoryState()).toEqual(before);
    expect(await quarantines()).toEqual([]);
    await expect(
      runWorkflow(workflow, { ...options('conflicts'), stateDir: realFail, harness, resume: true }),
    ).rejects.toThrow(message);
    gate.options = { strategy };
    const real = await runWorkflow(workflow, { ...options('conflicts'), harness, resume: true });
    vi.useRealTimers();
    expect(JSON.parse(real.output ?? 'null')).toEqual(preview);
  },
  // Five runs over real Git. measured: 1.6-1.9 s alone (dominated by Git processes).
  20_000,
);

it('refuses to preview a merge while a custom merge driver is configured, before Git runs it', async () => {
  const gate: PreviewGate = { stop: true, options: {} };
  const workflow = capturedMerge('driver', ['edit'], gate);
  await expect(
    runWorkflow(workflow, { ...options('driver'), harness: editingHarness(), input: null }),
  ).rejects.toThrow('stopped before the merge');
  const copy = await copyRun('driver');
  // A driver that leaves a sentinel wherever merge-tree would run it, selected for every path.
  const sentinel = join(directory, 'driver-ran');
  await command('config', 'merge.sentinel.driver', `touch '${sentinel}'; false`);
  await writeFile(join(repo, '.git', 'info', 'attributes'), '* merge=sentinel\n');
  const before = await repositoryState();
  const quarantines = await temporaryParent();
  const spy = objectSpy();
  gate.stop = false;
  const failure: unknown = await runWorkflow(workflow, {
    ...dryRun('driver', copy, [], spy.runner),
    resume: true,
  }).catch((error: unknown) => error);
  expect((failure as Error).message).toContain(
    'Dry-run cannot preview a merge of captured commits while custom merge drivers are configured (merge.sentinel.driver)',
  );
  expect((failure as Error).cause).toBeInstanceOf(ConfigurationError);
  expect(spy.commands.map(({ args }) => args[0]).filter((name) => name !== 'rev-parse')).toEqual([
    'config',
    'config',
  ]);
  expect(await exists(sentinel)).toBe(false);
  expect(await repositoryState()).toEqual(before);
  expect(await quarantines()).toEqual([]);
});

it('refuses to preview a merge while merge.renormalize would run a configured filter', async () => {
  const gate: PreviewGate = { stop: true, options: {} };
  const workflow = capturedMerge('filter', ['edit'], gate);
  await expect(
    runWorkflow(workflow, { ...options('filter'), harness: editingHarness(), input: null }),
  ).rejects.toThrow('stopped before the merge');
  const copy = await copyRun('filter');
  // HEAD moves on, so the preview needs a content merge of file.txt, which renormalizes.
  await writeFile(join(repo, 'file.txt'), 'top\nbase\n');
  await commit('top');
  // A clean filter that leaves a sentinel wherever merge-tree would renormalize through it.
  const sentinel = join(directory, 'filter-ran');
  await command('config', 'merge.renormalize', 'true');
  await command('config', 'filter.sentinel.clean', `touch '${sentinel}'; cat`);
  await writeFile(join(repo, '.git', 'info', 'attributes'), '* filter=sentinel\n');
  const before = await repositoryState();
  const quarantines = await temporaryParent();
  const spy = objectSpy();
  gate.stop = false;
  const failure: unknown = await runWorkflow(workflow, {
    ...dryRun('filter', copy, [], spy.runner),
    resume: true,
  }).catch((error: unknown) => error);
  // The machine's own Git configuration may add filters (CI runners configure git-lfs), which the
  // refusal also lists, so match the prefix and the sentinel filter apart.
  expect((failure as Error).message).toContain(
    'Dry-run cannot preview a merge of captured commits while merge.renormalize is set and filters are configured (',
  );
  expect((failure as Error).message).toMatch(/\bfilter\.sentinel\.clean\b/);
  expect((failure as Error).cause).toBeInstanceOf(ConfigurationError);
  expect(spy.commands.map(({ args }) => args[0]).filter((name) => name !== 'rev-parse')).toEqual([
    'config',
    'config',
    'config',
    'config',
  ]);
  expect(await exists(sentinel)).toBe(false);
  expect(await repositoryState()).toEqual(before);
  expect(await quarantines()).toEqual([]);
});

it('refuses to preview a merge in a partial clone on Git older than 2.44, before any lookup', async () => {
  const gate: PreviewGate = { stop: true, options: {} };
  const workflow = capturedMerge('partial', ['edit'], gate);
  await expect(
    runWorkflow(workflow, { ...options('partial'), harness: editingHarness(), input: null }),
  ).rejects.toThrow('stopped before the merge');
  const edit = (await readRun({ stateDir, runId: 'partial' })).steps['edit']?.worktree?.commit;
  assert(edit);
  // A promisor remote makes the repository a partial clone; GIT_NO_LAZY_FETCH keeps 2.44+ from it.
  await command('config', 'remote.origin.promisor', 'true');
  const before = await repositoryState();
  const quarantines = await temporaryParent();
  const old = objectSpy('git version 2.43.0 (Apple Git-146)');
  gate.stop = false;
  const failure: unknown = await runWorkflow(workflow, {
    ...dryRun('partial', await copyRun('partial'), [], old.runner),
    resume: true,
  }).catch((error: unknown) => error);
  expect((failure as Error).message).toContain(
    'Dry-run cannot preview a merge of captured commits in a partial clone with git version 2.43.0 (Apple Git-146): merge previews in a partial clone need Git 2.44 or later',
  );
  expect((failure as Error).cause).toBeInstanceOf(ConfigurationError);
  // Only the partial-clone listing and the version read ran, before anything looked up the commit.
  expect(old.commands.map(({ args }) => args).filter((args) => args[0] !== 'rev-parse')).toEqual([
    partialCloneListing,
    ['--version'],
  ]);
  expect(old.commands.some(({ args }) => args.includes(`${edit}^{commit}`))).toBe(false);
  expect(await repositoryState()).toEqual(before);
  expect(await quarantines()).toEqual([]);
  // Git 2.44 honors GIT_NO_LAZY_FETCH, so the same partial clone previews the merge.
  const current = objectSpy('git version 2.44.0');
  const dry = await runWorkflow(workflow, {
    ...dryRun('partial', await copyRun('partial'), [], current.runner),
    resume: true,
  });
  expect(JSON.parse(dry.output ?? 'null')).toMatchObject({ merged: [edit], conflicts: [] });
  expect(current.commands.filter(({ args }) => args[0] === '--version')).toHaveLength(1);
  expect(await repositoryState()).toEqual(before);
  expect(await quarantines()).toEqual([]);
});

it.each([
  ['a branch', { branch: 'feature' }],
  ['the checkout', 'checkout'],
] as const)(
  'builds a preview into %s on the earlier preview into it, as the real merges do',
  async (_name, target) => {
    let stop = true;
    const workflow = defineWorkflow({
      name: 'chained',
      version: '1',
      input: z.null(),
      output: z.string(),
      async run(ctx) {
        const changes = [];
        for (const edit of ['one', 'two']) {
          const result = await ctx.codex.text(edit, { prompt: edit, worktree: true });
          if (!result.worktree?.commit) throw new Error('missing captured change');
          changes.push(result.worktree);
        }
        if (stop) throw new Error('stopped before the merge');
        const first = await ctx.merge('first', changes.slice(0, 1), { target });
        // `two` also appends to file.txt, so it conflicts with `one` once `one` is on the target.
        const second = await ctx.merge('second', changes.slice(1), { target });
        return JSON.stringify({ first, second });
      },
    });
    const harness = editingHarness();
    await expect(
      runWorkflow(workflow, { ...options('chained'), harness, input: null }),
    ).rejects.toThrow('stopped before the merge');
    const steps = (await readRun({ stateDir, runId: 'chained' })).steps;
    const [one, two] = ['one', 'two'].map((id) => steps[id]?.worktree?.commit);
    assert(one && two);
    const copy = await copyRun('chained');
    const before = await repositoryState();
    const quarantines = await temporaryParent();
    stop = false;
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-02T03:04:05.678Z') });
    const dry = await runWorkflow(workflow, {
      ...dryRun('chained', copy, [], processRunner),
      resume: true,
    });
    const preview = JSON.parse(dry.output ?? 'null') as { first: MergeResult; second: MergeResult };
    expect(preview.first).toMatchObject({ merged: [one], conflicts: [] });
    expect(preview.second).toEqual({
      commit: preview.first.commit,
      merged: [],
      conflicts: [{ commit: two, files: ['file.txt'] }],
    });
    // No ref moved: the previewed tip lived only in the rehearsal.
    expect(await repositoryState()).toEqual(before);
    expect(await quarantines()).toEqual([]);
    const real = await runWorkflow(workflow, { ...options('chained'), harness, resume: true });
    vi.useRealTimers();
    expect(JSON.parse(real.output ?? 'null')).toEqual(preview);
  },
  // Three runs over real Git, like the conflict cases above.
  20_000,
);

it('does not chain previews into ref targets, which move no ref', async () => {
  let stop = true;
  const workflow = defineWorkflow({
    name: 'unchained',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const changes = [];
      for (const edit of ['one', 'two']) {
        const result = await ctx.codex.text(edit, { prompt: edit, worktree: true });
        if (!result.worktree?.commit) throw new Error('missing captured change');
        changes.push(result.worktree);
      }
      if (stop) throw new Error('stopped before the merge');
      const first = await ctx.merge('first', changes.slice(0, 1), { target: 'ref' });
      const second = await ctx.merge('second', changes.slice(1), { target: 'ref' });
      return JSON.stringify({ first, second });
    },
  });
  const harness = editingHarness();
  await expect(
    runWorkflow(workflow, { ...options('unchained'), harness, input: null }),
  ).rejects.toThrow('stopped before the merge');
  const steps = (await readRun({ stateDir, runId: 'unchained' })).steps;
  const [one, two] = ['one', 'two'].map((id) => steps[id]?.worktree?.commit);
  assert(one && two);
  const copy = await copyRun('unchained');
  stop = false;
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-02T03:04:05.678Z') });
  const dry = await runWorkflow(workflow, {
    ...dryRun('unchained', copy, [], processRunner),
    resume: true,
  });
  const preview = JSON.parse(dry.output ?? 'null') as { first: MergeResult; second: MergeResult };
  // Each ref merge integrates onto HEAD, so neither sees the other.
  expect(preview.first).toMatchObject({ merged: [one], conflicts: [] });
  expect(preview.second).toMatchObject({ merged: [two], conflicts: [] });
  const real = await runWorkflow(workflow, { ...options('unchained'), harness, resume: true });
  vi.useRealTimers();
  expect(JSON.parse(real.output ?? 'null')).toEqual(preview);
});

/**
 * Two isolated edits `one` and `two` (both append to file.txt, so they conflict once either is on a
 * target), then, once `gate.stop` is cleared, `body` with their captured changes.
 */
function previewParity(
  name: string,
  gate: { stop: boolean },
  body: (ctx: WorkflowContext, changes: [WorktreeChange, WorktreeChange]) => Promise<unknown>,
) {
  return defineWorkflow({
    name,
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const capture = async (edit: string) => {
        const result = await ctx.codex.text(edit, { prompt: edit, worktree: true });
        if (!result.worktree?.commit) throw new Error('missing captured change');
        return result.worktree;
      };
      const changes: [WorktreeChange, WorktreeChange] = [
        await capture('one'),
        await capture('two'),
      ];
      if (gate.stop) throw new Error('stopped before the merge');
      return JSON.stringify(await body(ctx, changes));
    },
  });
}
/**
 * Run `workflow` until its gate, then a dry-run resume and a real resume at the same instant, and
 * return both outputs and the captured commits, checking that the dry-run changed nothing.
 */
async function dryAndReal(
  runId: string,
  workflow: ReturnType<typeof previewParity>,
  gate: { stop: boolean },
) {
  const harness = editingHarness();
  await expect(runWorkflow(workflow, { ...options(runId), harness, input: null })).rejects.toThrow(
    'stopped before the merge',
  );
  const steps = (await readRun({ stateDir, runId })).steps;
  const [one, two] = ['one', 'two'].map((id) => steps[id]?.worktree?.commit);
  assert(one && two);
  const copy = await copyRun(runId);
  const before = await repositoryState();
  const quarantines = await temporaryParent();
  gate.stop = false;
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-02T03:04:05.678Z') });
  const dry = await runWorkflow(workflow, {
    ...dryRun(runId, copy, [], processRunner),
    harness: { kind: 'dry-run', invoke: () => Promise.resolve(response) },
    resume: true,
  });
  expect(await repositoryState()).toEqual(before);
  expect(await quarantines()).toEqual([]);
  const real = await runWorkflow(workflow, { ...options(runId), harness, resume: true });
  vi.useRealTimers();
  return {
    dry: JSON.parse(dry.output ?? 'null') as unknown,
    real: JSON.parse(real.output ?? 'null') as unknown,
    one,
    two,
  };
}

it('chains concurrent previews into one branch in call order, as the real merges do', async () => {
  const gate = { stop: true };
  const workflow = previewParity('concurrent', gate, (ctx, [one, two]) =>
    Promise.all([
      ctx.merge('first', [one], { target: { branch: 'feature' } }),
      ctx.merge('second', [two], { target: { branch: 'feature' } }),
    ]),
  );
  const { dry, real, one, two } = await dryAndReal('concurrent', workflow, gate);
  const [first, second] = dry as MergeResult[];
  expect(first).toMatchObject({ merged: [one], conflicts: [] });
  expect(second).toEqual({
    commit: first?.commit,
    merged: [],
    conflicts: [{ commit: two, files: ['file.txt'] }],
  });
  expect(real).toEqual(dry);
}, 20_000);

it.each([
  ['HEAD after a checkout preview', 'checkout', true],
  ['a branch after a preview into it', { branch: 'feature' }, { base: 'feature' }],
] as const)(
  'bases a fresh isolation on %s, as the real run does',
  async (_name, target, worktree) => {
    const gate = { stop: true };
    const workflow = previewParity('isolation-base', gate, async (ctx, [one]) => {
      const merged = await ctx.merge('integrate', [one], { target });
      const after = await ctx.codex.text('after', { prompt: 'after', worktree });
      return { merged, base: after.worktree?.base };
    });
    const { dry, real, one } = await dryAndReal('isolation-base', workflow, gate);
    const preview = dry as { merged: MergeResult; base: string };
    expect(preview.merged).toMatchObject({ merged: [one], conflicts: [] });
    expect(preview.base).toBe(preview.merged.commit);
    expect(real).toEqual(dry);
  },
  20_000,
);

it('records a no-op preview into a missing branch as its tip, as the real merge creates it', async () => {
  const gate = { stop: true };
  const workflow = previewParity('noop-branch', gate, async (ctx, [one, two]) => {
    // The no-op creates feature at the original HEAD, before the checkout merge moves HEAD on.
    const noop = await ctx.merge('noop', [{ ...one, commit: null, ref: null, files: [] }], {
      target: { branch: 'feature' },
    });
    const checkout = await ctx.merge('checkout', [one], { target: 'checkout' });
    const feature = await ctx.merge('feature', [two], { target: { branch: 'feature' } });
    return { noop, checkout, feature };
  });
  const { dry, real, one, two } = await dryAndReal('noop-branch', workflow, gate);
  const preview = dry as Record<'noop' | 'checkout' | 'feature', MergeResult>;
  expect(preview.checkout).toMatchObject({ merged: [one], conflicts: [] });
  // feature still holds the original HEAD, so two merges cleanly there.
  expect(preview.feature).toMatchObject({ merged: [two], conflicts: [] });
  expect(real).toEqual(dry);
}, 20_000);

it('fails a preview over a commit missing from the repository like the real merge', async () => {
  const head = await command('rev-parse', 'HEAD');
  const spy = spyRunner();
  const workflow = defineWorkflow({
    name: 'missing',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.merge('integrate', [{ base: head, commit: 'b'.repeat(40), ref: null, files: [] }]);
      return null;
    },
  });
  const quarantines = await temporaryParent();
  await expect(
    runWorkflow(workflow, {
      ...options('missing'),
      input: null,
      rehearsal: {},
      harness: { kind: 'dry-run', invoke: () => Promise.resolve(response) },
      processRunner: spy.runner,
    }),
  ).rejects.toThrow('Merge input commit is unavailable in this repository.');
  // The ledger's status read already ran the partial-clone listing, which the preview reuses.
  expect(spy.commands.filter((args) => args[0] !== 'rev-parse')).toEqual(ledgerReads);
  expect(await quarantines()).toEqual([]);
});

it.each([
  [
    'a captured commit without a repository',
    { base: 'a'.repeat(40), commit: 'b'.repeat(40), ref: null, files: [] },
    'Dry-run needs the Git repository to preview a merge',
  ],
  [
    'a foreign worktree handle',
    { id: 'foreign', path: '/nowhere/handle', base: 'a'.repeat(40) },
    'Worktree handle does not belong to this run; create it with ctx.worktree.',
  ],
])('fails a dry-run merge of %s with a configuration error', async (_name, input, text) => {
  // A runner that answers nothing, as a synthesizing runner does: no repository resolves.
  const run = vi.fn<ProcessRunner['run']>(() =>
    Promise.resolve({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 0,
    }),
  );
  const workflow = defineWorkflow({
    name: 'no-repository',
    version: '1',
    input: z.null(),
    output: z.null(),
    async run(ctx) {
      await ctx.merge('integrate', [input]);
      return null;
    },
  });
  const failure: unknown = await runWorkflow(workflow, {
    ...options('no-repository'),
    input: null,
    rehearsal: {},
    harness: { kind: 'dry-run', invoke: () => Promise.resolve(response) },
    processRunner: { run },
  }).catch((error: unknown) => error);
  expect((failure as Error).message).toContain(text);
  expect((failure as Error).cause).toBeInstanceOf(ConfigurationError);
  // The handle check is pure; the repository lookup is the only command either case issues.
  expect(run.mock.calls.length).toBeLessThanOrEqual(1);
});

/** A run's failure as a parity check compares it: its class, message and cause's class. */
async function failureOf(
  run: Promise<unknown>,
): Promise<{ type: string; message: string; cause: string | undefined }> {
  const error: unknown = await run.then(
    () => {
      throw new Error('the run completed');
    },
    (rejection: unknown) => rejection,
  );
  assert(error instanceof Error);
  const cause: unknown = error.cause;
  return {
    type: error.constructor.name,
    message: error.message,
    cause: cause instanceof Error ? cause.constructor.name : undefined,
  };
}
/** The source checkout's index bytes and modification time, which a refreshing status rewrites. */
async function indexState(): Promise<{ bytes: string; mtime: number }> {
  const index = join(repo, '.git', 'index');
  return {
    bytes: (await readFile(index)).toString('base64'),
    mtime: (await lstat(index)).mtimeMs,
  };
}
/** Fresh dry-run options in a separate state directory, so the real run can reuse the run ID. */
function freshDryRun(runId: string, runner: ProcessRunner) {
  return {
    ...options(runId),
    stateDir: join(directory, 'dry-state'),
    input: null,
    rehearsal: {},
    harness: { kind: 'dry-run', invoke: () => Promise.resolve(response) } satisfies Harness,
    processRunner: runner,
  };
}
const checkRef = (ref: string) => ['check-ref-format', ref];
const listWorktrees = ['worktree', 'list', '--porcelain', '-z'];
const status = ['status', '--porcelain', '--untracked-files=normal', '--no-renames'];

it.each([
  {
    name: 'an invalid branch name',
    setup: () => Promise.resolve({ branch: 'bad..name' }),
    text: 'Git check-ref-format failed',
    reads: () => [checkRef('refs/heads/bad..name')],
  },
  {
    name: 'a branch checked out in another worktree',
    setup: async () => {
      await command('worktree', 'add', '-q', '-b', 'occupied', join(directory, 'other'));
      return { branch: 'occupied' };
    },
    text: 'Merge target refs/heads/occupied is checked out',
    reads: () => [checkRef('refs/heads/occupied'), listWorktrees],
  },
  {
    name: 'the checked-out branch as a branch target',
    setup: async () => ({ branch: await command('branch', '--show-current') }),
    text: "is checked out; use target: 'checkout' explicitly",
    reads: (branch: string) => [checkRef(`refs/heads/${branch}`), listWorktrees],
  },
  {
    name: 'a symbolic-ref branch',
    setup: async () => {
      const current = await command('branch', '--show-current');
      await command('symbolic-ref', 'refs/heads/alias', `refs/heads/${current}`);
      return { branch: 'alias' };
    },
    text: 'Merge branch target cannot be a symbolic ref.',
    reads: () => [
      checkRef('refs/heads/alias'),
      listWorktrees,
      ['symbolic-ref', '-q', 'refs/heads/alias'],
    ],
  },
  {
    name: "a dirty 'checkout' target",
    setup: async () => {
      await writeFile(join(repo, 'file.txt'), 'dirty\n');
      // Stale stat data on an unchanged tracked file: a status that may lock would refresh the index.
      await utimes(join(repo, '.gitignore'), new Date(2001, 0, 1), new Date(2001, 0, 1));
      return 'checkout' as const;
    },
    text: 'Merge target checkout is dirty',
    reads: () => [status],
  },
])(
  'fails a dry-run merge into $name with the real error, writing nothing',
  async ({ setup, text, reads }) => {
    const target = await setup();
    const workflow = defineWorkflow({
      name: 'target-check',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      async run(ctx) {
        return ctx.merge('publish', [], { target });
      },
    });
    const before = await repositoryState();
    const index = await indexState();
    const spy = spyRunner();
    const dry = await failureOf(runWorkflow(workflow, freshDryRun('target-check', spy.runner)));
    // Only allowlisted reads ran (besides rev-parse), and nothing changed: no ref, object, worktree,
    // cache, index refresh or administration lock file.
    expect(spy.commands.filter((args) => args[0] !== 'rev-parse')).toEqual([
      ...ledgerReads,
      ...reads(typeof target === 'object' ? target.branch : ''),
    ]);
    expect(await repositoryState()).toEqual(before);
    expect(await indexState()).toEqual(index);
    expect(await exists(worktreeAdminLockPath(join(repo, '.git')))).toBe(false);
    const real = await failureOf(
      runWorkflow(workflow, { ...options('target-check'), input: null }),
    );
    expect(dry).toEqual(real);
    expect(dry.message).toContain(text);
  },
);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it.each(['a delayed check-ref-format', 'a blocked administration queue'] as const)(
  'cancels a dry-run merge waiting on %s when its map scope aborts, as the real run does',
  async (blocked) => {
    const queue = blocked === 'a blocked administration queue';
    let reached = deferred();
    const workflow = defineWorkflow({
      name: 'scoped-check',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      async run(ctx) {
        return ctx.map('items', [0, 1], { concurrency: 2, cancelSiblings: true }, (index) =>
          index === 0
            ? ctx.step('failure', {
                input: null,
                schema: z.null(),
                run: async () => {
                  await reached.promise;
                  // Give the merge time to queue behind the held administration entry.
                  if (queue) await new Promise((resolve) => setTimeout(resolve, 200));
                  throw new Error('root failure');
                },
              })
            : ctx.merge('publish', [], { target: { branch: 'feature' } }),
        );
      },
    });
    /** Reaches the merge's check-ref-format; a delayed one waits for its scope or two seconds. */
    const runner: ProcessRunner = {
      run: async (request, call) => {
        const argv = Array.isArray(request.command) ? [...(request.command as string[])] : [];
        if (argv[argv.indexOf('-C') + 2] !== 'check-ref-format')
          return processRunner.run(request, call);
        if (queue) {
          const result = await processRunner.run(request, call);
          reached.resolve();
          return result;
        }
        reached.resolve();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 2_000);
          call.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(call.signal.reason as Error);
            },
            { once: true },
          );
        });
        return processRunner.run(request, call);
      },
    };
    /** Runs `start` while this process's administration queue entry is held, if `queue` is set. */
    async function held<T>(start: () => Promise<T>): Promise<T> {
      if (!queue) return start();
      const release = deferred();
      const holder = queueAdministration(
        await realpath(join(repo, '.git')),
        new AbortController().signal,
        () => release.promise,
      );
      // A merge that ignored its scope would wait here until this releases it.
      const timer = setTimeout(release.resolve, 2_000);
      try {
        return await start();
      } finally {
        clearTimeout(timer);
        release.resolve();
        await holder;
      }
    }
    const dryOptions = freshDryRun('scoped-check', runner);
    const dry = await held(() => failureOf(runWorkflow(workflow, dryOptions)));
    const dryRecord = await readRun({ stateDir: dryOptions.stateDir, runId: 'scoped-check' });
    reached = deferred();
    const real = await held(() =>
      failureOf(
        runWorkflow(workflow, { ...options('scoped-check'), input: null, processRunner: runner }),
      ),
    );
    const realRecord = await readRun({ stateDir, runId: 'scoped-check' });
    expect(dry).toEqual(real);
    for (const record of [dryRecord, realRecord]) {
      expect(record.steps['items/0/failure']?.status).toBe('failed');
      expect(record.steps['items/1/publish']).toMatchObject({
        status: 'cancelled',
        cancelledBy: 'items/0/failure',
      });
    }
  },
  // Two runs over real Git, one of which may wait out the two-second fallback when it regresses.
  20_000,
);

const afterQuarantine: [string, () => Promise<NonNullable<MergeOptions['target']>>, string][] = [
  ['an invalid branch', () => Promise.resolve({ branch: 'bad..name' }), 'check-ref-format failed'],
  [
    "a dirty 'checkout' target",
    async () => {
      await writeFile(join(repo, 'file.txt'), 'dirty\n');
      return 'checkout';
    },
    'Merge target checkout is dirty',
  ],
];
it.each(afterQuarantine)(
  'fails a dry-run merge into %s after a captured-commit preview, as the real resume does',
  async (_name, setup, text) => {
    let target: NonNullable<MergeOptions['target']> = 'ref';
    const gate = { stop: true };
    const workflow = previewParity('after-quarantine', gate, async (ctx, [one]) => {
      // The first preview creates the quarantine, whose driver refuses the target checks.
      await ctx.merge('first', [one], { target: 'ref' });
      return ctx.merge('second', [], { target });
    });
    const harness = editingHarness();
    await expect(
      runWorkflow(workflow, { ...options('after-quarantine'), harness, input: null }),
    ).rejects.toThrow('stopped before the merge');
    const copy = await copyRun('after-quarantine');
    target = await setup();
    gate.stop = false;
    const before = await repositoryState();
    const quarantines = await temporaryParent();
    const spy = objectSpy();
    const events: WorktreeEvent[] = [];
    const dry = await failureOf(
      runWorkflow(workflow, {
        ...dryRun('after-quarantine', copy, events, spy.runner),
        resume: true,
      }),
    );
    expect(events).toEqual([expect.objectContaining({ kind: 'merge', stepId: 'first' })]);
    // The quarantine existed, yet the target checks ran through the read-only driver.
    expect(spy.commands.some(({ objects }) => objects?.includes(quarantinePrefix))).toBe(true);
    const checks = spy.commands.filter(
      ({ args }) => args[0] === 'check-ref-format' || args[0] === 'status',
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.objects).toBeUndefined();
    expect(await repositoryState()).toEqual(before);
    expect(await quarantines()).toEqual([]);
    const real = await failureOf(
      runWorkflow(workflow, { ...options('after-quarantine'), harness, resume: true }),
    );
    expect(dry).toEqual(real);
    expect(dry.message).toContain(text);
  },
  // Three runs over real Git, like the conflict cases above.
  20_000,
);

it.each([
  [
    'an isolated call',
    (ctx: WorkflowContext) => ctx.codex.text('edit', { prompt: 'edit', worktree: true }),
  ],
  ['a merge', (ctx: WorkflowContext) => ctx.merge('publish', [])],
] as const)(
  'refuses Git older than 2.38 for %s under dry-run like the real run',
  async (_name, body) => {
    const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
    const workflow = defineWorkflow({
      name: 'old-git',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      async run(ctx) {
        return body(ctx);
      },
    });
    const before = await repositoryState();
    const dry = await failureOf(
      runWorkflow(workflow, {
        ...freshDryRun('old-git', objectSpy('git version 2.37.1').runner),
        harness: { kind: 'dry-run', invoke },
      }),
    );
    expect(await repositoryState()).toEqual(before);
    expect(await exists(worktreeAdminLockPath(join(repo, '.git')))).toBe(false);
    const real = await failureOf(
      runWorkflow(workflow, {
        ...options('old-git'),
        input: null,
        harness: { invoke },
        processRunner: objectSpy('git version 2.37.1').runner,
      }),
    );
    expect(dry).toEqual(real);
    expect(dry.cause).toBe('ConfigurationError');
    expect(dry.message).toContain(
      'Worktree isolation requires Git 2.38 or newer; found git version 2.37.1.',
    );
    expect(invoke).not.toHaveBeenCalled();
  },
);

it('skips the ledger checks on a dry-run resume with a copied ledger, as the real recovery does', async () => {
  const gate: PreviewGate = { stop: true, options: {} };
  const workflow = capturedMerge('recovered', ['edit'], gate);
  const harness = editingHarness();
  await expect(
    runWorkflow(workflow, { ...options('recovered'), harness, input: null }),
  ).rejects.toThrow('stopped before the merge');
  const copy = await copyRun('recovered');
  // Neither an old Git nor a dirty source checkout matters once the ledger exists.
  await writeFile(join(repo, 'untracked.txt'), 'untracked\n');
  gate.stop = false;
  const old = objectSpy('git version 2.37.1');
  const dry = await runWorkflow(workflow, {
    ...dryRun('recovered', copy, [], old.runner),
    resume: true,
  });
  expect(
    old.commands
      .map(({ args }) => args)
      .filter((args) => args[0] === '--version' || args[0] === 'status'),
  ).toEqual([]);
  expect(dry.worktreeWarnings ?? []).not.toContain(uncommittedSourceWarning);
  const real = await runWorkflow(workflow, {
    ...options('recovered'),
    harness,
    resume: true,
    processRunner: objectSpy('git version 2.37.1').runner,
  });
  expect(real.worktreeWarnings ?? []).not.toContain(uncommittedSourceWarning);
});

it.each([
  [
    'an isolated call',
    (ctx: WorkflowContext) => ctx.codex.text('edit', { prompt: 'edit', worktree: true }),
  ],
  ['a merge', (ctx: WorkflowContext) => ctx.merge('publish', [])],
] as const)(
  'records the real uncommitted-changes warning for %s under dry-run, and none when clean',
  async (_name, body) => {
    const workflow = defineWorkflow({
      name: 'dirty-source',
      version: '1',
      input: z.null(),
      output: z.null(),
      async run(ctx) {
        await body(ctx);
        return null;
      },
    });
    const clean = await runWorkflow(workflow, freshDryRun('clean', processRunner));
    expect(clean.worktreeWarnings ?? []).not.toContain(uncommittedSourceWarning);
    await writeFile(join(repo, 'untracked.txt'), 'untracked\n');
    const before = await repositoryState();
    const index = await indexState();
    const dry = await runWorkflow(workflow, freshDryRun('dirty', processRunner));
    expect(dry.worktreeWarnings).toEqual([uncommittedSourceWarning]);
    expect(await repositoryState()).toEqual(before);
    expect(await indexState()).toEqual(index);
    expect(await exists(worktreeAdminLockPath(join(repo, '.git')))).toBe(false);
    const real = await runWorkflow(workflow, {
      ...options('dirty'),
      input: null,
      harness: { invoke: () => Promise.resolve(response) },
    });
    expect(real.worktreeWarnings).toEqual(dry.worktreeWarnings);
  },
);

it.each([
  {
    direction: 'outside the checkout that a symlink leads into it',
    setup: async () => {
      await symlink(repo, join(directory, 'linked'), 'dir');
      return join(directory, 'linked', 'missing', 'caches');
    },
    refused: true,
  },
  {
    direction: 'inside the checkout that a symlink leads out of it',
    setup: async () => {
      await mkdir(join(directory, 'outside'));
      await symlink(join(directory, 'outside'), join(repo, 'out'), 'dir');
      return join(repo, 'out', 'caches');
    },
    refused: false,
  },
])(
  'resolves symlinks in a cache root $direction under dry-run as the real run does',
  async ({ setup, refused }) => {
    const cacheRoot = await setup();
    const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
    const workflow = defineWorkflow({
      name: 'linked-root',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      async run(ctx) {
        return (await ctx.codex.text('edit', { prompt: 'edit', worktree: true })).output;
      },
    });
    const before = await repositoryState();
    const dryOptions = {
      ...freshDryRun('linked-root', processRunner),
      worktrees: { root: cacheRoot },
      harness: { kind: 'dry-run', invoke },
    };
    const realOptions = {
      ...options('linked-root'),
      worktrees: { root: cacheRoot },
      input: null,
      harness: { invoke },
    };
    if (refused) {
      const dry = await failureOf(runWorkflow(workflow, dryOptions));
      expect(dry.message).toContain('worktrees.root must be outside the source checkout');
      expect(dry.cause).toBe('ConfigurationError');
      expect(invoke).not.toHaveBeenCalled();
      expect(await exists(join(repo, 'missing'))).toBe(false);
      expect(await repositoryState()).toEqual(before);
      expect(await failureOf(runWorkflow(workflow, realOptions))).toEqual(dry);
    } else {
      const dry = await runWorkflow(workflow, dryOptions);
      expect(dry.status).toBe('completed');
      // The placeholder directory is planned under the root as given, and nothing is created.
      expect(dry.steps['edit']?.worktree?.path).toContain(join(cacheRoot, 'linked-root-dry-run'));
      expect(await exists(join(directory, 'outside', 'caches'))).toBe(false);
      expect(await repositoryState()).toEqual(before);
      expect((await runWorkflow(workflow, realOptions)).status).toBe('completed');
    }
  },
);

it("keeps the copied ledger's pinned cache root in a dry-run resume, as the real resume does", async () => {
  let stop = true;
  const invoke = vi.fn<Harness['invoke']>(() => Promise.resolve(response));
  const workflow = defineWorkflow({
    name: 'pinned-root',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    async run(ctx) {
      await ctx.codex.text('first', { prompt: 'first', worktree: true });
      if (stop) throw new Error('stopped after the first call');
      return (await ctx.codex.text('second', { prompt: 'second', worktree: true })).output;
    },
  });
  await expect(
    runWorkflow(workflow, { ...options('pinned-root'), input: null, harness: { invoke } }),
  ).rejects.toThrow('stopped after the first call');
  const pinned = (await readRun({ stateDir, runId: 'pinned-root' })).worktrees?.root;
  assert(pinned);
  // A later worktrees.root that a symlink leads into the checkout: a run without a ledger refuses
  // it, but a resume keeps the root its ledger pinned and never checks the new one.
  await symlink(repo, join(directory, 'linked'), 'dir');
  const override = { root: join(directory, 'linked', 'missing', 'caches') };
  stop = false;
  const before = await repositoryState();
  const dry = await runWorkflow(workflow, {
    ...dryRun('pinned-root', await copyRun('pinned-root'), [], processRunner),
    worktrees: override,
    harness: { kind: 'dry-run', invoke },
    resume: true,
  });
  expect(dry.status).toBe('completed');
  // The placeholder directory is planned under the pinned root, and nothing is created.
  expect(dry.steps['second']?.worktree?.path).toContain(join(pinned, 'pinned-root-dry-run'));
  expect(await exists(join(repo, 'missing'))).toBe(false);
  expect(await repositoryState()).toEqual(before);
  const real = await runWorkflow(workflow, {
    ...options('pinned-root'),
    worktrees: override,
    input: null,
    harness: { invoke },
    resume: true,
  });
  expect(real.status).toBe('completed');
  expect(real.steps['second']?.worktree?.path.startsWith(join(pinned, 'pinned-root-'))).toBe(true);
});

it('runs the dry-run status checks without rename detection, which reads blob contents', async () => {
  // A staged rename is a change either way; with rename detection Git would compare the blobs,
  // which Git older than 2.44 could lazy-fetch from a partial clone's promisor remote.
  await command('mv', 'file.txt', 'renamed.txt');
  const workflow = defineWorkflow({
    name: 'renamed-source',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    async run(ctx) {
      await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
      return ctx.merge('publish', [], { target: 'checkout' });
    },
  });
  const spy = spyRunner();
  const dry = await failureOf(runWorkflow(workflow, freshDryRun('renamed-source', spy.runner)));
  const statuses = spy.commands.filter((args) => args[0] === 'status');
  // The ledger's dirty-source check and the checkout target's check.
  expect(statuses).toEqual([status, status]);
  expect(statuses.every((args) => args.includes('--no-renames'))).toBe(true);
  const real = await failureOf(
    runWorkflow(workflow, {
      ...options('renamed-source'),
      input: null,
      harness: { invoke: () => Promise.resolve(response) },
    }),
  );
  expect(dry).toEqual(real);
  expect(dry.message).toContain('Merge target checkout is dirty');
});

it('refuses the dry-run ledger status read in a partial clone on Git older than 2.44, without running it', async () => {
  const workflow = defineWorkflow({
    name: 'partial-source',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    async run(ctx) {
      return (await ctx.codex.text('edit', { prompt: 'edit', worktree: true })).output;
    },
  });
  // A promisor remote makes the repository a partial clone; GIT_NO_LAZY_FETCH keeps 2.44+ from it.
  await command('config', 'remote.origin.promisor', 'true');
  const before = await repositoryState();
  const index = await indexState();
  const old = objectSpy('git version 2.43.0');
  const failure = await failureOf(runWorkflow(workflow, freshDryRun('partial-source', old.runner)));
  expect(failure.message).toContain(
    "Dry-run cannot read the source checkout's status in a partial clone with git version 2.43.0: git status in a partial clone needs Git 2.44 or later",
  );
  expect(failure.cause).toBe('ConfigurationError');
  // The ledger's version read, then the partial-clone listing and its version read; no status.
  expect(old.commands.map(({ args }) => args).filter((args) => args[0] !== 'rev-parse')).toEqual([
    ['--version'],
    partialCloneListing,
    ['--version'],
  ]);
  expect(await repositoryState()).toEqual(before);
  expect(await indexState()).toEqual(index);
  // Git 2.44 honors GIT_NO_LAZY_FETCH, so the same partial clone reads the status and proceeds.
  const current = objectSpy('git version 2.44.0');
  const dry = await runWorkflow(workflow, freshDryRun('partial-source-current', current.runner));
  expect(dry.status).toBe('completed');
  expect(
    current.commands.map(({ args }) => args).filter((args) => args[0] !== 'rev-parse'),
  ).toEqual([['--version'], partialCloneListing, ['--version'], status]);
  expect(await repositoryState()).toEqual(before);
});

it("refuses a dry-run 'checkout' target's status read in a partial clone on Git older than 2.44, without running it", async () => {
  let stop = true;
  const workflow = defineWorkflow({
    name: 'partial-checkout',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    async run(ctx) {
      const edit = await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
      if (stop) throw new Error('stopped before the merge');
      return ctx.merge('publish', edit.worktree ? [edit.worktree] : [], { target: 'checkout' });
    },
  });
  // The real run creates the ledger, so the dry-run resume skips the ledger's own status read.
  await expect(
    runWorkflow(workflow, {
      ...options('partial-checkout'),
      input: null,
      harness: { invoke: () => Promise.resolve(response) },
    }),
  ).rejects.toThrow('stopped before the merge');
  expect((await readRun({ stateDir, runId: 'partial-checkout' })).worktrees).toBeDefined();
  await command('config', 'remote.origin.promisor', 'true');
  const before = await repositoryState();
  const index = await indexState();
  stop = false;
  const old = objectSpy('git version 2.43.0');
  const failure = await failureOf(
    runWorkflow(workflow, {
      ...dryRun('partial-checkout', await copyRun('partial-checkout'), [], old.runner),
      resume: true,
    }),
  );
  expect(failure.message).toContain(
    "Dry-run cannot read the source checkout's status in a partial clone with git version 2.43.0",
  );
  expect(failure.cause).toBe('ConfigurationError');
  expect(old.commands.map(({ args }) => args).filter((args) => args[0] !== 'rev-parse')).toEqual([
    partialCloneListing,
    ['--version'],
  ]);
  expect(await repositoryState()).toEqual(before);
  expect(await indexState()).toEqual(index);
  // On Git 2.44 the target's status read runs, and the unchanged merge is the real no-op.
  const current = objectSpy('git version 2.44.0');
  const dry = await runWorkflow(workflow, {
    ...dryRun('partial-checkout', await copyRun('partial-checkout'), [], current.runner),
    resume: true,
  });
  expect(dry.status).toBe('completed');
  expect(dry.output).toMatchObject({ commit: await command('rev-parse', 'HEAD'), merged: [] });
  expect(
    current.commands.map(({ args }) => args).filter((args) => args[0] !== 'rev-parse'),
  ).toEqual([partialCloneListing, ['--version'], status]);
  expect(await repositoryState()).toEqual(before);
});

/** Every checkpoint file of a run, by name, so a refusal can prove it wrote nothing. */
async function runFiles(runId: string): Promise<Record<string, string>> {
  const run = join(stateDir, runId);
  const names = (await readdir(run, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name): Promise<[string, string]> => [
        name.slice(run.length + 1),
        await readFile(name, 'utf8'),
      ]),
    ),
  );
}
/** Registered worktrees, refs and the cache root's entries: what a real Git effect would change. */
async function gitState(): Promise<Record<string, unknown>> {
  return {
    worktrees: await command('worktree', 'list', '--porcelain'),
    refs: await command('for-each-ref'),
    caches: (await exists(root)) ? (await readdir(root, { recursive: true })).sort() : [],
  };
}
/** A harness that edits the call's checkout, so an isolated call captures a commit. */
function editingHarness() {
  const invoke = vi.fn<Harness['invoke']>(async (request) => {
    await appendFile(join(request.cwd, 'file.txt'), `${request.call.stepId}\n`);
    return response;
  });
  return { invoke };
}
// The accepted-replay preflight (#217) synthesizes every Git effect, so an edited completed step
// after a new or unfinished one is refused before the run, a ref, a worktree or a cache changes.
it.each([
  {
    effect: 'a new ctx.worktree',
    prefix: async (ctx: WorkflowContext, edited: boolean) => {
      if (edited) await ctx.worktree('cache');
    },
  },
  {
    effect: 'an agent call isolated on a ctx.worktree handle',
    prefix: async (ctx: WorkflowContext, edited: boolean) => {
      const handle = await ctx.worktree('cache');
      if (edited) await ctx.codex.text('edit', { prompt: 'edit', worktree: handle });
    },
  },
  {
    effect: 'a local step isolated on a ctx.worktree handle',
    prefix: async (ctx: WorkflowContext, edited: boolean) => {
      const handle = await ctx.worktree('cache');
      if (edited)
        await ctx.step('inside', {
          input: null,
          schema: z.null(),
          worktree: handle,
          run: () => null,
        });
    },
  },
  {
    effect: 'a command isolated on a ctx.worktree handle',
    prefix: async (ctx: WorkflowContext, edited: boolean) => {
      const handle = await ctx.worktree('cache');
      if (edited) await ctx.exec('probe', ['true'], { worktree: handle });
    },
  },
  {
    effect: 'a merge of a captured commit',
    prefix: async (ctx: WorkflowContext, edited: boolean) => {
      const edit = await ctx.codex.text('edit', { prompt: 'edit', worktree: true });
      if (!edit.worktree?.commit) throw new Error('missing captured change');
      if (edited) await ctx.merge('integrate', [edit.worktree]);
    },
  },
])(
  'refuses an accepted edit of a completed step after $effect before any Git',
  async ({ prefix }) => {
    let edited = false;
    let ran = 0;
    const harness = editingHarness();
    const workflow = defineWorkflow({
      name: 'preflight-git',
      version: '1',
      input: z.null(),
      output: z.string(),
      async run(ctx) {
        await prefix(ctx, edited);
        const value = await ctx.step('local', {
          input: null,
          schema: z.string(),
          run: edited
            ? () => {
                ran++;
                return 'edited';
              }
            : () => {
                ran++;
                return 'original';
              },
        });
        if (!edited) throw new Error('tail');
        return value;
      },
    });
    const run = { ...options('preflight-git'), harness, input: null, fingerprint: 'code-1' };
    await expect(runWorkflow(workflow, run)).rejects.toThrow('tail');
    const calls = harness.invoke.mock.calls.length;
    const files = await runFiles('preflight-git');
    const git = await gitState();
    edited = true;
    const spy = spyRunner();
    const rejected: unknown = await runWorkflow(workflow, {
      ...run,
      processRunner: spy.runner,
      resume: true,
      fingerprint: 'code-2',
      acceptCodeChange: true,
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(StepIdentityChangedError);
    expect(isAcceptedReplayRefusal(rejected)).toBe(true);
    expect(findAcceptedReplayDivergence(rejected)).toBe(rejected);
    expect(rejected).toMatchObject({ stepId: 'local', components: ['callback'] });
    expect(await runFiles('preflight-git')).toEqual(files);
    expect(ran).toBe(1);
    expect(harness.invoke).toHaveBeenCalledTimes(calls);
    expect(spy.commands).toEqual([]);
    expect(await gitState()).toEqual(git);
  },
);

it('refuses an accepted edit that skips a completed step behind a new ctx.worktree before any Git', async () => {
  let edited = false;
  const workflow = defineWorkflow({
    name: 'preflight-skip',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      if (edited) await ctx.worktree('cache');
      else await ctx.step('early', { input: null, schema: z.string(), run: () => 'e' });
      const shared = await ctx.step('shared', { input: null, schema: z.string(), run: () => 's' });
      if (!edited) throw new Error('tail');
      return shared;
    },
  });
  const run = { ...options('preflight-skip'), input: null, fingerprint: 'code-1' };
  await expect(runWorkflow(workflow, run)).rejects.toThrow('tail');
  const files = await runFiles('preflight-skip');
  const git = await gitState();
  edited = true;
  const spy = spyRunner();
  const rejected: unknown = await runWorkflow(workflow, {
    ...run,
    processRunner: spy.runner,
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
  }).catch((error: unknown) => error);
  expect(rejected).toBeInstanceOf(ReplaySkippedError);
  expect(isAcceptedReplayRefusal(rejected)).toBe(true);
  expect(rejected).toMatchObject({ kind: 'steps', skipped: ['early'] });
  expect(await runFiles('preflight-skip')).toEqual(files);
  expect(spy.commands).toEqual([]);
  expect(await gitState()).toEqual(git);
});

it('re-finalizes a tail-only fix after completed worktree, handle and merge effects with none repeated', async () => {
  const base = await command('rev-parse', 'HEAD');
  await command('branch', 'integration');
  let late = (): string => {
    throw new Error('bug');
  };
  const harness = editingHarness();
  const workflow = defineWorkflow({
    name: 'preflight-tail',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const handle = await ctx.worktree('cache');
      await ctx.codex.text('shared', { prompt: 'shared', worktree: handle });
      const fresh = await ctx.codex.text('fresh', { prompt: 'fresh', worktree: true });
      if (!fresh.worktree?.commit) throw new Error('missing captured change');
      const merged = await ctx.merge('integrate', [fresh.worktree], {
        target: { branch: 'integration' },
      });
      return `${merged.commit}/${await ctx.step('late', { input: null, schema: z.string(), run: late })}`;
    },
  });
  const run = { ...options('preflight-tail'), harness, input: null, fingerprint: 'code-1' };
  await expect(runWorkflow(workflow, run)).rejects.toThrow('bug');
  const integrated = await command('rev-parse', 'integration');
  expect(integrated).not.toBe(base);
  expect(harness.invoke).toHaveBeenCalledTimes(2);
  late = () => 'late';
  const spy = spyRunner();
  const result = await runWorkflow(workflow, {
    ...run,
    processRunner: spy.runner,
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
  });
  expect(result).toMatchObject({ status: 'completed', output: `${integrated}/late` });
  expect(harness.invoke).toHaveBeenCalledTimes(2);
  expect(result.codeChanges).toHaveLength(1);
  // Nothing was created or merged again: no worktree add, no merge computation, no branch move.
  expect(spy.commands.filter(([verb, sub]) => verb === 'worktree' && sub === 'add')).toEqual([]);
  expect(spy.commands.filter(([verb]) => verb === 'merge-tree')).toEqual([]);
  expect(await command('rev-parse', 'integration')).toBe(integrated);
});

it('runs one real merge when a tail-only fix adds it after completed work', async () => {
  const base = await command('rev-parse', 'HEAD');
  await command('branch', 'integration');
  let fixed = false;
  const harness = editingHarness();
  const workflow = defineWorkflow({
    name: 'preflight-new-merge',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const fresh = await ctx.codex.text('fresh', { prompt: 'fresh', worktree: true });
      if (!fresh.worktree?.commit) throw new Error('missing captured change');
      const value = await ctx.step('local', { input: null, schema: z.string(), run: () => 'v' });
      if (!fixed) throw new Error('tail');
      const merged = await ctx.merge('integrate', [fresh.worktree], {
        target: { branch: 'integration' },
      });
      expect(merged.merged).toEqual([fresh.worktree.commit]);
      return `${value}/${merged.commit}`;
    },
  });
  const run = { ...options('preflight-new-merge'), harness, input: null, fingerprint: 'code-1' };
  await expect(runWorkflow(workflow, run)).rejects.toThrow('tail');
  expect(await command('rev-parse', 'integration')).toBe(base);
  fixed = true;
  const spy = spyRunner();
  const result = await runWorkflow(workflow, {
    ...run,
    processRunner: spy.runner,
    resume: true,
    fingerprint: 'code-2',
    acceptCodeChange: true,
  });
  const integrated = await command('rev-parse', 'integration');
  expect(result).toMatchObject({ status: 'completed', output: `v/${integrated}` });
  expect(integrated).not.toBe(base);
  expect(harness.invoke).toHaveBeenCalledTimes(1);
  // The preflight synthesized the merge without Git; only the real run computed it, once.
  expect(spy.commands.filter(([verb]) => verb === 'merge-tree')).toHaveLength(1);
  expect(spy.commands.filter(([verb, sub]) => verb === 'worktree' && sub === 'add')).toEqual([]);
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
