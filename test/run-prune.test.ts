import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  chmod,
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
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ThresholdLogger } from '../src/application/execution.js';
import { workflowExitCodes } from '../src/cli/workflow-errors.js';
import WorkflowPrune from '../src/commands/workflow/prune.js';
import { defineWorkflow, NodeProcessRunner, readRun, runWorkflow } from '../src/index.js';
import { processIdentity } from '../src/processes/identity.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { listRuns } from '../src/workflow/loader/inspection.js';
import type { PruneWorkflowPlan, WorkflowCommandResult } from '../src/workflow/loader/model.js';
import { pruneRuns, type PruneResult } from '../src/workflow/loader/prune.js';
import { defaultPruneStatuses } from '../src/workflow/loader/prune-selection.js';
import { answerPath, writeAnswer } from '../src/workflow/runtime/inbox.js';
import { formatArgv } from '../src/workflow/runtime/commands.js';
import { defaultStateDir } from '../src/workflow/runtime/paths.js';
import * as lockStore from '../src/workflow/runtime/store.js';
import { runBytes } from '../src/workflow/runtime/run-size.js';
import { WorktreeGit } from '../src/worktrees/git.js';
import { testInvocation } from './harness-invocation.js';

vi.mock('../src/workflow/runtime/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof lockStore>();
  return { ...actual, lockRun: vi.fn(actual.lockRun) };
});
const actualLockStore = await vi.importActual<typeof lockStore>('../src/workflow/runtime/store.js');

const DEAD = 2_000_000_000;
const day = 86_400_000;
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const processRunner = new NodeProcessRunner();
const executor = new WorkflowExecutor({ logger: new ThresholdLogger('silent', () => undefined) });
let root: string;
let stateDir: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'quiet-choir-prune-')));
  stateDir = join(root, 'runs');
  vi.stubEnv('XDG_STATE_HOME', join(root, 'xdg'));
  vi.stubEnv('QUIET_CHOIR_STATE_DIR', undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

function plan(overrides: Partial<PruneWorkflowPlan> = {}): PruneWorkflowPlan {
  return {
    kind: 'workflow.prune',
    stateDir,
    all: false,
    olderThanMs: null,
    statuses: defaultPruneStatuses,
    missingCwd: false,
    refs: false,
    dryRun: false,
    ...overrides,
  };
}

async function prune(overrides: Partial<PruneWorkflowPlan> = {}): Promise<PruneResult> {
  const result: WorkflowCommandResult = await executor.execute(plan(overrides));
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  assert(result.kind === 'workflow.prune.result');
  return result;
}

const ids = (runs: readonly { readonly runId: string }[]) => runs.map((run) => run.runId);
const reasons = (result: PruneResult) =>
  Object.fromEntries(result.skipped.map((run) => [run.runId, [run.reason, run.code]]));

const local = <T>(value: T) => ({ input: null, schema: z.unknown(), run: () => value });

/** A completed run; `directory: null` uses the project's default state, which registers it. */
async function completedRun(
  runId: string,
  cwd = root,
  directory: string | null = stateDir,
): Promise<void> {
  const workflow = defineWorkflow({
    name: 'prune',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) => ctx.step('one', local(1)),
  });
  const options = {
    runId,
    cwd,
    input: null,
    ...(directory === null ? {} : { stateDir: directory }),
  };
  expect((await runWorkflow(workflow, options)).status).toBe('completed');
}

async function failedRun(runId: string, cwd = root): Promise<void> {
  const workflow = defineWorkflow({
    name: 'prune-failed',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: () => Promise.reject(new Error('body failed')),
  });
  await expect(runWorkflow(workflow, { runId, stateDir, cwd, input: null })).rejects.toThrow(
    'body failed',
  );
}

async function suspendedRun(
  runId: string,
  cwd = root,
  directory: string | null = stateDir,
): Promise<void> {
  const workflow = defineWorkflow({
    name: 'prune-ask',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) => ctx.ask('gate', { prompt: 'Ship?', schema: z.boolean() }),
  });
  const options = {
    runId,
    cwd,
    input: null,
    ...(directory === null ? {} : { stateDir: directory }),
  };
  expect((await runWorkflow(workflow, options)).status).toBe('suspended');
}

async function failedWaitingRun(runId: string, cwd = root): Promise<void> {
  const workflow = defineWorkflow({
    name: 'prune-failed-waiting',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) =>
      Promise.all([
        ctx.ask('gate', { prompt: 'Ship?', schema: z.boolean() }),
        ctx.step('fail', {
          input: null,
          schema: z.null(),
          run: async () => {
            await delay(10);
            throw new Error('body failed');
          },
        }),
      ]),
  });
  await expect(runWorkflow(workflow, { runId, stateDir, cwd, input: null })).rejects.toThrow(
    'body failed',
  );
  expect((await readRun({ stateDir, runId })).steps['gate']?.status).toBe('waiting');
}

/** An unmigrated flat running record with no lock, which inspects as stale. */
async function staleRecord(runId: string, cwd: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const time = '2026-01-01T00:00:00.000Z';
  await writeFile(
    join(stateDir, `${runId}.json`),
    JSON.stringify({
      formatVersion: 1,
      id: runId,
      workflow: { name: 'flat', version: '1', fingerprint: null },
      status: 'running',
      cwd,
      input: null,
      output: null,
      error: null,
      steps: {},
      createdAt: time,
      updatedAt: time,
    }),
  );
}

const legacyFixture = new URL('./fixtures/storage/v1.json', import.meta.url);

/** The captured format-1 run `legacy`, migrated as test/run-removal.test.ts does. */
async function migratedLegacy(): Promise<void> {
  await mkdir(join(stateDir, 'legacy.inbox'), { recursive: true });
  await writeFile(join(stateDir, 'legacy.json'), await readFile(legacyFixture, 'utf8'));
  await writeFile(join(stateDir, 'legacy.inbox', 'answer.json'), '{"value":true}');
  await writeFile(join(stateDir, 'legacy.cancel.json'), '{}');
  const definition = defineWorkflow({
    name: 'legacy-v1',
    version: '1',
    input: z.null(),
    output: z.string(),
    run: async (ctx) => {
      const value = await ctx.step('local', { input: null, schema: z.number(), run: () => 7 });
      const agent = await ctx.claude.text('agent', { prompt: 'legacy question' });
      await ctx.sleep('pause', 0);
      return `${String(value)}/${agent.output}`;
    },
  });
  await expect(
    runWorkflow(definition, {
      stateDir,
      runId: 'legacy',
      cwd: '/quiet-choir/legacy-project',
      input: null,
      resume: true,
      fingerprint: 'fixed-source',
      acceptCodeChange: true,
    }),
  ).rejects.toThrow('no pinned isolation mode');
  expect((await readRun({ stateDir, runId: 'legacy' })).formatVersion).toBe(7);
}

/** Rewrite a saved record's updatedAt, as a later save would, returning the new value. */
async function setUpdatedAt(runId: string, updatedAt: string, directory = stateDir) {
  const run = await readRun({ stateDir: directory, runId });
  for (const name of ['run.json', 'journal.jsonl']) {
    const file = join(directory, runId, name);
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text !== undefined) await writeFile(file, text.replaceAll(run.updatedAt, updatedAt));
  }
  expect((await readRun({ stateDir: directory, runId })).updatedAt).toBe(updatedAt);
  return updatedAt;
}
const daysAgo = (days: number) => new Date(Date.now() - days * day).toISOString();

function liveOwner(token: string): object {
  return {
    pid: process.pid,
    host: hostname(),
    token,
    osStartTime: processIdentity(process.pid)?.start ?? null,
  };
}

/** A lock directory in the style of test/unlock.test.ts. */
async function plant(path: string, files: { owner?: object; recovery?: object }): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'owner.json'),
    JSON.stringify(files.owner ?? { pid: DEAD, host: hostname(), token: 'old' }),
  );
  if (files.recovery) await writeFile(join(path, 'recovery.json'), JSON.stringify(files.recovery));
}

/** Every entry below `path` with its size, mode and modification time. */
async function snapshot(path: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(path, { recursive: true, withFileTypes: true }).catch(
    () => [],
  )) {
    const file = join(entry.parentPath, entry.name);
    const stat = await lstat(file);
    entries[file] = `${String(stat.size)} ${String(stat.mode)} ${String(stat.mtimeMs)}`;
  }
  return entries;
}

async function gone(path: string): Promise<boolean> {
  return lstat(path).then(
    () => false,
    () => true,
  );
}

interface Captured {
  readonly error: unknown;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the prune command in-process, as test/cli.test.ts runs commands. */
async function command(argv: string[]): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    stdout.push(typeof message === 'string' ? message : inspect(message));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    stderr.push(typeof message === 'string' ? message : inspect(message));
  });
  let caught: unknown;
  try {
    await WorkflowPrune.run(argv, { root: projectRoot });
  } catch (thrown) {
    caught = thrown;
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { error: caught, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function usageFailure(captured: Captured): void {
  expect(captured.error).toMatchObject({ oclif: { exit: 2 } });
  expect(JSON.parse(captured.stdout)).toMatchObject({
    ok: false,
    exitCode: workflowExitCodes['usage.flag'],
    error: { code: 'usage.flag' },
  });
}

describe('workflow prune selection', () => {
  it('filters by age and status, oldest first, and leaves the rest alone', async () => {
    await completedRun('old-done');
    await failedRun('old-failed');
    await completedRun('fresh-done');
    await setUpdatedAt('old-done', daysAgo(30));
    await setUpdatedAt('old-failed', daysAgo(20));

    const failedOnly = await prune({ statuses: ['failed'], olderThanMs: 7 * day, dryRun: true });
    expect(ids(failedOnly.removed)).toEqual(['old-failed']);
    expect(failedOnly.skipped).toEqual([]);

    const result = await prune({ olderThanMs: 7 * day });
    expect(result).toMatchObject({
      dryRun: false,
      stateDirs: [stateDir],
      filters: {
        olderThanMs: 7 * day,
        statuses: ['completed', 'failed', 'cancelled'],
        missingCwd: false,
        all: false,
        refs: false,
      },
      skipped: [],
      tombstones: [],
      warnings: [],
    });
    expect(ids(result.removed)).toEqual(['old-done', 'old-failed']);
    expect(result.removed.map((run) => run.status)).toEqual(['completed', 'failed']);
    expect(result.bytes).toBe(result.removed.reduce((total, run) => total + run.bytes, 0));
    expect(await gone(join(stateDir, 'old-done'))).toBe(true);
    expect(await gone(join(stateDir, 'old-failed'))).toBe(true);
    expect((await readRun({ stateDir, runId: 'fresh-done' })).status).toBe('completed');

    const statusOnly = await prune({ statuses: ['completed'] });
    expect(ids(statusOnly.removed)).toEqual(['fresh-done']);
    expect(await readdir(stateDir)).toEqual(['.gitignore']);
  });

  it('never selects an active, waiting, queued, locked or recovering run, even when every filter matches', async () => {
    const project = join(root, 'project');
    await mkdir(project);
    await suspendedRun('asked', project);
    await staleRecord('stale', project);
    await failedWaitingRun('waiting', project);
    await completedRun('queued', project);
    await mkdir(join(stateDir, 'queued', 'inbox'), { recursive: true });
    await writeFile(join(stateDir, 'queued', 'inbox', 'gate.answer.json'), '{"value":true}');
    await completedRun('locked', project);
    await plant(join(stateDir, 'locked', 'lock'), { owner: liveOwner('live') });
    await completedRun('recovering', project);
    await plant(join(stateDir, 'recovering', 'lock'), { recovery: liveOwner('rec') });
    await completedRun('plain', project);
    await rm(project, { recursive: true });
    const everyFilter = { olderThanMs: 0, missingCwd: true };

    const before = await snapshot(root);
    const preview = await prune({ ...everyFilter, dryRun: true });
    expect(await snapshot(root)).toEqual(before);
    expect(preview.warnings).toEqual([]);
    const observed = await listRuns({ stateDir });
    expect(
      Object.fromEntries(
        observed.runs
          .filter((run) => run.id === 'asked' || run.id === 'stale')
          .map((run) => [run.id, run.status]),
      ),
    ).toEqual({ asked: 'suspended', stale: 'stale' });
    expect(ids(preview.removed)).toEqual(['plain']);
    expect(reasons(preview)).toEqual({
      waiting: ['waiting', 'run.active'],
      queued: ['queued-answer', null],
      locked: ['locked', 'run.locked'],
      recovering: ['locked', 'run.locked'],
    });
    const queued = preview.skipped.find((run) => run.runId === 'queued');
    expect(queued?.message).toContain(`quiet-choir workflow rm queued --state-dir ${stateDir}.`);
    expect(queued?.message).not.toContain('--force');
    expect(preview.skipped.find((run) => run.runId === 'waiting')?.message).toContain(
      `quiet-choir workflow rm waiting --state-dir ${stateDir} --force.`,
    );
    expect(preview.skipped.find((run) => run.runId === 'locked')).toMatchObject({
      details: { kind: 'primary', role: 'owner', state: 'alive' },
    });

    // Through the command: the same selection, and the protected runs stay on disk.
    const captured = await command([
      '--status',
      'completed,failed',
      '--status',
      'cancelled',
      '--older-than',
      '0s',
      '--missing-cwd',
      '--state-dir',
      stateDir,
      '--json',
    ]);
    expect(captured.error).toBeUndefined();
    const document = JSON.parse(captured.stdout) as PruneResult & { kind: string };
    expect(document.kind).toBe('workflow.prune.result');
    expect(ids(document.removed)).toEqual(['plain']);
    expect(Object.keys(reasons(document)).sort()).toEqual([
      'locked',
      'queued',
      'recovering',
      'waiting',
    ]);
    for (const runId of ['asked', 'stale', 'waiting', 'queued', 'locked', 'recovering'])
      expect((await readRun({ stateDir, runId })).id).toBe(runId);
    expect(await gone(join(stateDir, 'plain'))).toBe(true);
    // Statuses that only a direct caller could pass are refused before any I/O.
    const refused = await executor.execute(plan({ statuses: ['running' as 'completed'] }));
    assert(!refused.ok);
    expect(refused.code).toBe('usage.flag');
  });

  it('starts every rm suggestion with the launcher, and defaults to quiet-choir', async () => {
    const launcher = [process.execPath, '/abs/bin/run.js'];
    await suspendedRun('asked');
    await failedWaitingRun('waiting');
    await completedRun('queued');
    await mkdir(join(stateDir, 'queued', 'inbox'), { recursive: true });
    await writeFile(join(stateDir, 'queued', 'inbox', 'gate.answer.json'), '{"value":true}');
    const selection = plan({
      // Only a direct caller can name a non-terminal status; it reaches prune's active protection.
      statuses: ['completed', 'failed', 'suspended' as 'completed'],
      dryRun: true,
    });
    const messages = async (live?: { commandLauncher: readonly string[] }) => {
      const outcome = await pruneRuns(selection, processRunner, live);
      assert(outcome.kind === 'done');
      return Object.fromEntries(outcome.result.skipped.map((run) => [run.runId, run.message]));
    };
    const rm = (program: readonly string[], runId: string, ...flags: string[]) =>
      `${formatArgv([...program, 'workflow', 'rm', runId, '--state-dir', stateDir, ...flags])}.`;

    const bare = await messages();
    expect(bare['asked']).toContain(rm(['quiet-choir'], 'asked', '--force'));
    expect(bare['waiting']).toContain(rm(['quiet-choir'], 'waiting', '--force'));
    expect(bare['queued']).toContain(rm(['quiet-choir'], 'queued'));
    const launched = await messages({ commandLauncher: launcher });
    expect(launched['asked']).toContain(rm(launcher, 'asked', '--force'));
    expect(launched['waiting']).toContain(rm(launcher, 'waiting', '--force'));
    expect(launched['queued']).toContain(rm(launcher, 'queued'));
    for (const message of Object.values(launched))
      expect(message).not.toContain('quiet-choir workflow');
  });

  it('does not count consumed or quarantined deliveries as queued answers', async () => {
    const workflow = defineWorkflow({
      name: 'prune-answered',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) => ctx.ask('gate', { prompt: 'Ship?', schema: z.boolean() }),
    });
    for (const runId of ['answered', 'stray']) {
      expect(
        (await runWorkflow(workflow, { runId, stateDir, cwd: root, input: null })).status,
      ).toBe('suspended');
      await writeAnswer({ stateDir, runId, stepId: 'gate', value: true });
      const resumed = await runWorkflow(workflow, {
        runId,
        stateDir,
        cwd: root,
        input: null,
        resume: true,
      });
      expect(resumed.status).toBe('completed');
      // The owner leaves the consumed delivery in the inbox.
      expect(await gone(answerPath(stateDir, runId, 'gate'))).toBe(false);
    }
    await writeFile(
      `${answerPath(stateDir, 'answered', 'gate')}.rejected.00000000-0000-4000-8000-000000000000.json`,
      '{}',
    );
    await writeFile(join(stateDir, 'stray', 'inbox', 'unknown.json'), '{}');
    const result = await prune({ statuses: ['completed'] });
    expect(ids(result.removed)).toEqual(['answered']);
    expect(reasons(result)).toEqual({ stray: ['queued-answer', null] });
    expect(result.skipped[0]?.details).toEqual({ queuedAnswers: 1 });
  });

  it('lists missing-cwd runs with their bytes in a dry run, then removes them through rm', async () => {
    const project = join(root, 'deleted-project');
    await mkdir(project);
    await completedRun('lost', project);
    for (const [name, value] of [
      ['attempts/one/1.jsonl', 'transcript\n'],
      ['artifacts/one/1/report.txt', 'artifact'],
    ] as const) {
      await mkdir(join(stateDir, 'lost', name, '..'), { recursive: true });
      await writeFile(join(stateDir, 'lost', name), value);
    }
    await rm(project, { recursive: true });
    await migratedLegacy();
    // The fixture's queued answer would protect it; without it the run qualifies.
    await rm(join(stateDir, 'legacy.inbox', 'answer.json'));
    await completedRun('kept');
    const bytes = {
      lost: await runBytes(stateDir, 'lost'),
      legacy: await runBytes(stateDir, 'legacy'),
    };

    const before = await snapshot(root);
    const preview = await prune({ missingCwd: true, dryRun: true });
    expect(await snapshot(root)).toEqual(before);
    expect(preview.skipped).toEqual([]);
    expect(Object.fromEntries(preview.removed.map((run) => [run.runId, run.bytes]))).toEqual(bytes);
    expect(preview.bytes).toBe(bytes.lost + bytes.legacy);
    expect(preview.removed.find((run) => run.runId === 'legacy')).toMatchObject({
      cwd: '/quiet-choir/legacy-project',
      paths: expect.arrayContaining([
        join(stateDir, 'legacy'),
        join(stateDir, 'legacy.json'),
        join(stateDir, 'legacy.json.v1'),
        join(stateDir, 'legacy.cancel.json'),
      ]) as unknown,
    });

    const result = await prune({ missingCwd: true });
    expect(Object.fromEntries(result.removed.map((run) => [run.runId, run.bytes]))).toEqual(bytes);
    for (const name of [
      'lost',
      'legacy',
      'legacy.json',
      'legacy.json.v1',
      'legacy.cancel.json',
      'legacy.inbox',
      'legacy.json.lock',
    ])
      expect(await gone(join(stateDir, name))).toBe(true);
    expect((await readdir(stateDir)).sort()).toEqual(['.gitignore', 'kept']);
  });

  it('covers every registered project with --all, reporting a refused run and exiting 0', async () => {
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    const firstRuns = defaultStateDir(first);
    const secondRuns = defaultStateDir(second);
    await completedRun('first-done', first, null);
    await completedRun('first-held', first, null);
    await plant(join(firstRuns, 'first-held', 'lock'), { owner: liveOwner('live') });
    await completedRun('second-done', second, null);
    await suspendedRun('elsewhere');
    // The command's own container is empty; --all reaches both registered projects.
    vi.stubEnv('QUIET_CHOIR_STATE_DIR', join(root, 'empty'));

    const captured = await command(['--all', '--status', 'completed', '--json']);
    expect(captured.error).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
    const document = JSON.parse(captured.stdout) as PruneResult;
    expect(document.stateDirs[0]).toBe(join(root, 'empty'));
    expect(document.stateDirs.slice(1).sort()).toEqual([firstRuns, secondRuns].sort());
    expect(ids(document.removed).sort()).toEqual(['first-done', 'second-done']);
    expect(document.skipped).toMatchObject([
      {
        runId: 'first-held',
        stateDir: firstRuns,
        reason: 'locked',
        code: 'run.locked',
        message: expect.stringContaining('is alive') as unknown,
      },
    ]);
    expect((await readRun({ stateDir: firstRuns, runId: 'first-held' })).id).toBe('first-held');
    expect(await gone(join(secondRuns, 'second-done'))).toBe(true);
    // A runs container outside the registered projects is not scanned.
    expect((await readRun({ stateDir, runId: 'elsewhere' })).status).toBe('suspended');

    const text = await command(['--all', '--status', 'completed', '--dry-run']);
    expect(text.error).toBeUndefined();
    expect(text.stdout).toMatch(/^Would remove 0 runs \(0 B\); skipped 1\./u);
    expect(text.stdout).toContain('Skipped first-held completed');
  });
});

describe('workflow prune removal', () => {
  it('reports a refusal at removal time as skipped and still removes later runs', async () => {
    await completedRun('first');
    await completedRun('second');
    await completedRun('third');
    await setUpdatedAt('first', daysAgo(3));
    await setUpdatedAt('second', daysAgo(2));
    let changed = '';
    const outcome = await pruneRuns(plan({ statuses: ['completed'] }), processRunner, {
      beforeLock: async (runId) => {
        if (runId === 'first')
          await plant(join(stateDir, 'first', 'lock'), { owner: liveOwner('late') });
        if (runId === 'second') changed = await setUpdatedAt('second', daysAgo(1));
      },
    });
    assert(outcome.kind === 'done');
    const { result } = outcome;
    expect(ids(result.removed)).toEqual(['third']);
    expect(reasons(result)).toEqual({
      first: ['locked', 'run.locked'],
      second: ['changed', 'run.exists'],
    });
    expect(result.skipped.find((run) => run.runId === 'second')).toMatchObject({
      message: expect.stringContaining('changed after prune selected it') as unknown,
      details: { updatedAt: changed },
    });
    expect((await readRun({ stateDir, runId: 'first' })).id).toBe('first');
    expect((await readRun({ stateDir, runId: 'second' })).updatedAt).toBe(changed);
    expect(await gone(join(stateDir, 'third'))).toBe(true);
  });

  it('skips a run that changed after listing in a dry run, as a real prune would', async () => {
    await completedRun('first');
    await setUpdatedAt('first', daysAgo(2));
    const before = (await readRun({ stateDir, runId: 'first' })).updatedAt;
    const changed = daysAgo(1);
    // The clock is read after listing and before removal: the seam that sits between them.
    const now = () => {
      for (const name of ['run.json', 'journal.jsonl']) {
        const file = join(stateDir, 'first', name);
        try {
          writeFileSync(file, readFileSync(file, 'utf8').replaceAll(before, changed));
        } catch {
          // A record without that file has nothing to rewrite.
        }
      }
      return Date.now();
    };
    const outcome = await pruneRuns(
      plan({ statuses: ['completed'], dryRun: true }),
      processRunner,
      {
        now,
      },
    );
    assert(outcome.kind === 'done');
    expect(outcome.result.removed).toEqual([]);
    expect(reasons(outcome.result)).toEqual({ first: ['changed', 'run.exists'] });
    expect((await readRun({ stateDir, runId: 'first' })).updatedAt).toBe(changed);
  });

  it('stops between removals on a signal and reports the runs removed so far', async () => {
    await completedRun('first');
    await completedRun('second');
    await setUpdatedAt('first', daysAgo(2));
    const controller = new AbortController();
    const outcome = await pruneRuns(plan({ statuses: ['completed'] }), processRunner, {
      signal: controller.signal,
      beforeLock: (runId) => {
        if (runId === 'second') controller.abort();
      },
    });
    assert(outcome.kind === 'interrupted');
    expect(ids(outcome.removed)).toEqual(['first']);
    expect((await readRun({ stateDir, runId: 'second' })).id).toBe('second');

    const aborted = new WorkflowExecutor({
      logger: new ThresholdLogger('silent', () => undefined),
      signal: AbortSignal.abort(),
    });
    const failure = await aborted.execute(plan({ statuses: ['completed'] }));
    assert(!failure.ok);
    expect(failure).toMatchObject({
      code: 'workflow.interrupted',
      details: { removed: [], roots: [], unfinishedRemovals: [] },
    });
    expect((await readRun({ stateDir, runId: 'second' })).id).toBe('second');
  });

  it('sweeps a dead rm tombstone in a scanned container', async () => {
    await completedRun('young');
    const tombstone = join(
      stateDir,
      `.old.${String(DEAD)}.00000000-0000-4000-8000-000000000000.removing`,
    );
    await mkdir(join(tombstone, 'journal'), { recursive: true });
    const preview = await prune({ olderThanMs: 7 * day, dryRun: true });
    expect(preview).toMatchObject({ removed: [], skipped: [], tombstones: [tombstone] });
    expect(await gone(tombstone)).toBe(false);
    const result = await prune({ olderThanMs: 7 * day });
    expect(result).toMatchObject({ removed: [], tombstones: [tombstone] });
    expect(await gone(tombstone)).toBe(true);
    expect((await readRun({ stateDir, runId: 'young' })).id).toBe('young');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails the command when a scanned container cannot be read',
    async () => {
      await completedRun('done');
      await chmod(stateDir, 0o000);
      try {
        const failure = await executor.execute(plan({ statuses: ['completed'] }));
        assert(!failure.ok);
        expect(failure.code).toBe('workflow.storage');
      } finally {
        await chmod(stateDir, 0o755);
      }
      expect((await readRun({ stateDir, runId: 'done' })).id).toBe('done');
    },
  );
});

describe('workflow prune and interrupted flat-run removals', () => {
  /**
   * What an rm of an unmigrated flat run leaves when it crashes after deleting the flat file:
   * `<runId>/` with its primary lock, the legacy guard and a backup, both locks owned by a dead
   * process (ADR 0061).
   */
  async function interruptedRemoval(runId: string, directory = stateDir): Promise<string> {
    await plant(join(directory, runId, 'lock'), {});
    await plant(join(directory, `${runId}.json.lock`), {});
    await writeFile(join(directory, `${runId}.json.v1`), '{}');
    return join(directory, runId);
  }

  it('finishes one even when no run matches the filters, after a preview that changes nothing', async () => {
    await completedRun('young');
    const leftover = await interruptedRemoval('ghost');
    const before = await snapshot(stateDir);
    const preview = await prune({ olderThanMs: 7 * day, dryRun: true });
    expect(preview).toMatchObject({
      removed: [],
      skipped: [],
      unfinishedRemovals: [leftover],
      warnings: [],
    });
    const text = await command(['--older-than', '7d', '--state-dir', stateDir, '--dry-run']);
    expect(text.error).toBeUndefined();
    expect(text.stdout).toContain(`Unfinished removal: ${leftover}`);
    expect(await snapshot(stateDir)).toEqual(before);

    const result = await prune({ olderThanMs: 7 * day });
    expect(result).toMatchObject({ removed: [], unfinishedRemovals: [leftover], warnings: [] });
    expect((await readdir(stateDir)).sort()).toEqual(['.gitignore', 'young']);
    expect((await readRun({ stateDir, runId: 'young' })).id).toBe('young');
    expect((await prune({ olderThanMs: 7 * day })).unfinishedRemovals).toEqual([]);
  });

  it('reports a finished one in the text output', async () => {
    const leftover = await interruptedRemoval('ghost');
    const text = await command(['--status', 'completed', '--state-dir', stateDir]);
    expect(text.error).toBeUndefined();
    expect(text.stdout).toContain(`Finished interrupted removal: ${leftover}`);
    expect(await gone(leftover)).toBe(true);
  });

  it('neither touches nor lists one that a live owner holds', async () => {
    await interruptedRemoval('held');
    await rm(join(stateDir, 'held', 'lock'), { recursive: true });
    await plant(join(stateDir, 'held', 'lock'), { owner: liveOwner('creating') });
    const before = await snapshot(stateDir);
    for (const dryRun of [true, false]) {
      const result = await prune({ statuses: ['completed'], dryRun });
      expect(result).toMatchObject({ unfinishedRemovals: [], warnings: [] });
    }
    expect(await snapshot(stateDir)).toEqual(before);
  });

  it('skips one that became a run before the lock, keeping the run', async () => {
    const leftover = await interruptedRemoval('raced');
    const outcome = await pruneRuns(plan({ statuses: ['completed'] }), processRunner, {
      beforeLock: async (runId) => {
        if (runId === 'raced') await staleRecord('raced', root);
      },
    });
    assert(outcome.kind === 'done');
    expect(outcome.result).toMatchObject({ unfinishedRemovals: [], warnings: [] });
    expect((await readRun({ stateDir, runId: 'raced' })).id).toBe('raced');
    expect(await gone(leftover)).toBe(false);
    expect(await gone(join(stateDir, 'raced', 'lock'))).toBe(true);
  });

  it('reports the warnings of a finished one, which stays listed', async () => {
    const leftover = await interruptedRemoval('ghost');
    vi.mocked(lockStore.lockRun).mockImplementation(async (...args) => {
      const release = await actualLockStore.lockRun(...args);
      return Object.assign(
        async () => {
          await release();
          throw new Error('injected EACCES');
        },
        {
          trackProcess: release.trackProcess.bind(release),
          releaseOwner: release.releaseOwner.bind(release),
        },
      );
    });
    try {
      const result = await prune({ statuses: ['completed'] });
      expect(result.unfinishedRemovals).toEqual([leftover]);
      expect(result.warnings).toEqual([
        expect.stringContaining('Removed the run but could not release'),
      ]);
      expect(result.warnings[0]).toContain('injected EACCES');
    } finally {
      vi.mocked(lockStore.lockRun).mockImplementation(actualLockStore.lockRun);
    }
    expect(await gone(leftover)).toBe(true);
  });

  it('sweeps an additional scanned container too', async () => {
    const other = join(root, 'legacy-runs');
    await mkdir(other);
    const here = await interruptedRemoval('here');
    const there = await interruptedRemoval('there', other);
    const result = await prune({ statuses: ['completed'], additionalStateDirs: [other] });
    expect(result).toMatchObject({
      stateDirs: [stateDir, other],
      unfinishedRemovals: [here, there],
    });
    expect(await readdir(other)).toEqual(['.gitignore']);
  });
});

describe('workflow prune project roots', () => {
  const xdg = () => join(root, 'xdg', 'quiet-choir');
  const namespace = (runId: string) => `${runId}-${randomUUID()}`;

  /** A registered root for a cwd that never existed, with no runs. */
  async function registeredRoot(name: string, directories: string[] = []): Promise<string> {
    const cwd = join(root, name);
    const project = dirname(defaultStateDir(cwd));
    await mkdir(join(project, 'runs'), { recursive: true });
    await writeFile(join(project, 'runs', '.gitignore'), '*\n');
    await writeFile(join(project, 'project.json'), `${JSON.stringify({ cwd })}\n`);
    for (const directory of directories)
      await mkdir(join(project, 'worktrees', directory), { recursive: true });
    return project;
  }

  /** A root without project.json that holds only the given directories under worktrees/. */
  async function bareRoot(name: string, directories: string[]): Promise<string> {
    const project = join(xdg(), name);
    for (const directory of directories)
      await mkdir(join(project, 'worktrees', directory), { recursive: true });
    return project;
  }

  /** A deleted workspace whose registered root holds the given completed runs. */
  async function deletedProject(name: string, runIds: string[]): Promise<string> {
    const cwd = join(root, name);
    await mkdir(cwd);
    for (const runId of runIds) await completedRun(runId, cwd, null);
    await rm(cwd, { recursive: true });
    return dirname(defaultStateDir(cwd));
  }

  const byRoot = (result: PruneResult) =>
    Object.fromEntries(result.roots.map((entry) => [entry.root, [entry.reason, entry.removed]]));

  async function listAll() {
    const listed = await executor.execute({ kind: 'workflow.list', stateDir, all: true });
    assert(listed.ok && listed.kind === 'workflow.list.result');
    return listed;
  }

  it('previews stale roots without changes, then removes them so list --all is clean', async () => {
    const withRuns = await deletedProject('deleted-with-runs', ['lost-one', 'lost-two']);
    const cache = namespace('lost-one');
    const withoutRuns = await registeredRoot('deleted-empty', [cache, namespace('old')]);
    const bare = await bareRoot('wtrepo-9c2bdb8d4801', [
      namespace('gone'),
      join(namespace('gone'), 'nested', 'deeper'),
    ]);
    const alive = join(root, 'alive');
    await mkdir(alive);
    await completedRun('alive-done', alive, null);
    const aliveRoot = dirname(defaultStateDir(alive));
    expect((await listAll()).warnings).toEqual([
      expect.stringMatching(new RegExp(`^Skipped project ${bare}: `, 'u')) as unknown,
    ]);

    const before = await snapshot(root);
    const preview = await prune({ missingCwd: true, all: true, dryRun: true });
    expect(await snapshot(root)).toEqual(before);
    expect(ids(preview.removed).sort()).toEqual(['lost-one', 'lost-two']);
    expect(preview.skipped).toEqual([]);
    expect(byRoot(preview)).toEqual({
      [withRuns]: ['missing-cwd', true],
      [withoutRuns]: ['missing-cwd', true],
      [bare]: ['empty', true],
    });
    expect(preview.roots.map((entry) => entry.root)).toEqual([withRuns, withoutRuns, bare].sort());
    const projectBytes = (await lstat(join(withoutRuns, 'project.json'))).size + 2;
    expect(preview.roots.find((entry) => entry.root === withoutRuns)).toMatchObject({
      cwd: join(root, 'deleted-empty'),
      registered: true,
      bytes: projectBytes,
      runs: [],
      paths: [
        join(withoutRuns, 'runs', '.gitignore'),
        join(withoutRuns, 'runs'),
        expect.stringContaining(join(withoutRuns, 'worktrees', '')) as unknown,
        expect.stringContaining(join(withoutRuns, 'worktrees', '')) as unknown,
        join(withoutRuns, 'worktrees'),
        join(withoutRuns, 'project.json'),
        withoutRuns,
      ],
    });
    expect(preview.roots.find((entry) => entry.root === bare)).toMatchObject({
      cwd: null,
      registered: false,
      bytes: 0,
    });
    expect(preview.bytes).toBe(preview.removed.reduce((total, run) => total + run.bytes, 0));

    const result = await prune({ missingCwd: true, all: true });
    expect(ids(result.removed).sort()).toEqual(['lost-one', 'lost-two']);
    const summary = (entries: PruneResult['roots']) =>
      entries.map(({ root: path, reason, removed, bytes }) => ({ path, reason, removed, bytes }));
    expect(summary(result.roots)).toEqual(summary(preview.roots));
    for (const path of [withRuns, withoutRuns, bare]) expect(await gone(path)).toBe(true);
    expect((await readRun({ stateDir: defaultStateDir(alive), runId: 'alive-done' })).id).toBe(
      'alive-done',
    );
    expect(await readdir(xdg())).toEqual([aliveRoot.slice(xdg().length + 1)]);
    const listed = await listAll();
    expect(listed.runs.map((run) => run.id)).toEqual(['alive-done']);
    expect(listed.warnings).toEqual([]);
  });

  it('keeps a stale root that holds a kept run or any file, with its project.json', async () => {
    const asked = join(root, 'asked');
    await mkdir(asked);
    await suspendedRun('asked', asked, null);
    await rm(asked, { recursive: true });
    const askedRoot = dirname(defaultStateDir(asked));
    const heldRoot = await deletedProject('held', ['held']);
    await plant(join(heldRoot, 'runs', 'held', 'lock'), { owner: liveOwner('live') });
    const cache = namespace('cached');
    const cacheRoot = await registeredRoot('cached', [cache]);
    await writeFile(join(cacheRoot, 'worktrees', cache, 'README.md'), 'live cache\n');
    const bareFile = await bareRoot('repo-7b94ad023d34', [namespace('x')]);
    await writeFile(join(bareFile, 'worktrees', 'note.txt'), 'x');
    const invalid = await bareRoot('invalid-000000000000', [namespace('y')]);
    await writeFile(join(invalid, 'project.json'), '{}\n');
    const registered = [askedRoot, heldRoot, cacheRoot];
    const projectJson = await Promise.all(
      registered.map((path) => readFile(join(path, 'project.json'))),
    );

    const before = await snapshot(root);
    const preview = await prune({ missingCwd: true, all: true, dryRun: true });
    expect(await snapshot(root)).toEqual(before);
    const result = await prune({ missingCwd: true, all: true });
    for (const outcome of [preview, result]) {
      expect(ids(outcome.removed)).toEqual([]);
      expect(reasons(outcome)).toEqual({ held: ['locked', 'run.locked'] });
      expect(byRoot(outcome)).toEqual({
        [askedRoot]: ['runs-kept', false],
        [heldRoot]: ['runs-kept', false],
        [cacheRoot]: ['files', false],
        [bareFile]: ['files', false],
        [invalid]: ['files', false],
      });
    }
    expect(result.roots.find((entry) => entry.root === askedRoot)).toMatchObject({
      runs: ['asked'],
      bytes: null,
      paths: [join(askedRoot, 'runs', 'asked')],
    });
    expect(result.roots.find((entry) => entry.root === cacheRoot)).toMatchObject({
      paths: [join(cacheRoot, 'worktrees', cache, 'README.md')],
      message: expect.stringContaining('remove them by hand') as unknown,
    });
    expect(result.roots.find((entry) => entry.root === invalid)?.message).toContain(
      'project.json must contain a cwd string.',
    );
    expect(await snapshot(root)).toEqual(before);
    for (const [index, path] of registered.entries()) {
      expect(await readFile(join(path, 'project.json'))).toEqual(projectJson[index]);
      expect(await readFile(join(path, 'runs', '.gitignore'), 'utf8')).toBe('*\n');
    }
  });

  it('keeps a root whose worktree namespace names a run a scanned container still holds', async () => {
    await suspendedRun('live-one');
    const inUse = await bareRoot('repo-111111111111', [namespace('live-one')]);
    const result = await prune({ missingCwd: true, all: true });
    expect(result.roots).toMatchObject([
      { root: inUse, reason: 'in-use', removed: false, runs: ['live-one'] },
    ]);
    expect(await gone(inUse)).toBe(false);
  });

  it('keeps a root busy and restores what it unlinked when an entry appears during removal', async () => {
    const late = await registeredRoot('late-root', [namespace('a')]);
    const lateRuns = await registeredRoot('late-runs');
    const projectJson = await readFile(join(late, 'project.json'));
    const outcome = await pruneRuns(plan({ missingCwd: true, all: true }), processRunner, {
      beforeRmdir: async (path) => {
        if (path === late) await writeFile(join(late, 'intruder'), 'x');
        if (path === join(lateRuns, 'runs')) await writeFile(join(lateRuns, 'runs', 'new'), 'x');
      },
    });
    assert(outcome.kind === 'done');
    expect(byRoot(outcome.result)).toEqual({
      [late]: ['busy', false],
      [lateRuns]: ['busy', false],
    });
    expect(outcome.result.roots.find((entry) => entry.root === late)).toMatchObject({
      bytes: null,
      paths: [join(late, 'intruder'), join(late, 'project.json')],
    });
    expect(await readFile(join(late, 'project.json'))).toEqual(projectJson);
    expect(await gone(join(late, 'runs'))).toBe(true);
    expect(await gone(join(late, 'worktrees'))).toBe(true);
    expect(await readFile(join(lateRuns, 'runs', '.gitignore'), 'utf8')).toBe('*\n');
    expect(await gone(join(lateRuns, 'project.json'))).toBe(false);
    expect((await listAll()).warnings).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'warns, naming the root, when it cannot restore project.json',
    async () => {
      const late = await registeredRoot('unrestorable');
      try {
        const outcome = await pruneRuns(plan({ missingCwd: true, all: true }), processRunner, {
          beforeRmdir: async (path) => {
            if (path !== late) return;
            await writeFile(join(late, 'intruder'), 'x');
            await chmod(late, 0o500);
          },
        });
        assert(outcome.kind === 'done');
        expect(byRoot(outcome.result)).toEqual({ [late]: ['busy', false] });
        expect(outcome.result.warnings).toEqual([
          expect.stringContaining(`Could not restore a file in project root ${late}`) as unknown,
        ]);
      } finally {
        await chmod(late, 0o700);
      }
    },
  );

  it('stops between roots on a signal and reports the roots removed so far', async () => {
    const first = await bareRoot('a-000000000000', [namespace('a')]);
    const second = await bareRoot('b-000000000000', [namespace('b')]);
    const controller = new AbortController();
    const outcome = await pruneRuns(plan({ missingCwd: true, all: true }), processRunner, {
      signal: controller.signal,
      beforeRmdir: (path) => {
        if (path === first) controller.abort();
      },
    });
    assert(outcome.kind === 'interrupted');
    expect(outcome).toMatchObject({ removed: [], roots: [first] });
    expect(await gone(first)).toBe(true);
    expect(await gone(second)).toBe(false);
  });

  it('touches no root without both --missing-cwd and --all, nor the current project or a symlink', async () => {
    const stale = await registeredRoot('stale-root', [namespace('a')]);
    const bare = await bareRoot('repo-222222222222', [namespace('b')]);
    const current = dirname(defaultStateDir());
    await mkdir(join(current, 'worktrees', namespace('c')), { recursive: true });
    const target = join(root, 'elsewhere');
    await mkdir(join(target, 'worktrees', namespace('d')), { recursive: true });
    await symlink(target, join(xdg(), 'linked-333333333333'));
    const linkedInside = await bareRoot('repo-444444444444', [namespace('e')]);
    await symlink(target, join(linkedInside, 'worktrees', 'link'));

    const before = await snapshot(root);
    expect((await prune({ missingCwd: true })).roots).toEqual([]);
    expect((await prune({ all: true, statuses: ['completed'] })).roots).toEqual([]);
    expect(await snapshot(root)).toEqual(before);

    const result = await prune({ missingCwd: true, all: true });
    expect(byRoot(result)).toEqual({
      [stale]: ['missing-cwd', true],
      [bare]: ['empty', true],
      [linkedInside]: ['files', false],
    });
    expect(await gone(current)).toBe(false);
    expect(await gone(join(target, 'worktrees'))).toBe(false);
    expect(await gone(join(linkedInside, 'worktrees', 'link'))).toBe(false);

    // As in the --all test above: an empty container, so the checkout's legacy runs stay out.
    vi.stubEnv('QUIET_CHOIR_STATE_DIR', join(root, 'empty'));
    const text = await command(['--missing-cwd', '--all', '--dry-run']);
    expect(text.error).toBeUndefined();
    expect(text.stdout).toMatch(/^Would remove 0 runs \(0 B\); skipped 0\.\n/u);
    expect(text.stdout).toContain('Would remove 0 project roots; kept 1.');
    expect(text.stdout).toContain(`Kept project root ${linkedInside} (files): `);
  });
});

describe('workflow prune usage', () => {
  it.each([
    ['a bare prune', []],
    ['a non-terminal status', ['--status', 'running']],
    ['an empty status', ['--status', '']],
    ['an unparseable age', ['--older-than', 'soon']],
  ])('refuses %s with usage.flag before touching state', async (_name, argv) => {
    await completedRun('done');
    const before = await snapshot(root);
    usageFailure(await command([...argv, '--state-dir', stateDir, '--json']));
    expect(await snapshot(root)).toEqual(before);
  });
});

// measured: 0.36 s alone (two runs with Git worktrees, then Git cache and ref removal); the same Git
// work in test/run-removal.test.ts reaches 3.1 s in loaded full coverage runs.
describe('workflow prune and pinned refs', { timeout: 10_000 }, () => {
  it('deletes pins only with --refs', async () => {
    const repo = join(root, 'repo');
    const caches = join(root, 'caches');
    const git = new WorktreeGit(processRunner);
    const invocation = testInvocation();
    const run = (...args: string[]) => git.text(repo, args, invocation);
    await mkdir(repo);
    await run('init', '-q');
    await writeFile(join(repo, 'file.txt'), 'base\n');
    await run('add', '--all');
    await run('-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'base');
    const withCache = async (runId: string) => {
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
      const saved = await runWorkflow(workflow, {
        runId,
        cwd: repo,
        stateDir,
        processRunner,
        input: null,
        worktrees: { root: caches, keep: 'all' },
      });
      assert(saved.worktrees);
      return {
        caches: Object.values(saved.worktrees.caches).map((cache) => cache.path),
        refs: Object.keys(saved.worktrees.refs),
      };
    };

    const kept = await withCache('kept');
    expect(kept.refs.length).toBeGreaterThan(0);
    const withoutRefs = await prune({ statuses: ['completed'] });
    expect(withoutRefs.removed).toMatchObject([
      {
        runId: 'kept',
        caches: kept.caches.map((path) => ({ path, method: 'git' })),
        refsRemoved: [],
        keptRefs: kept.refs,
      },
    ]);
    for (const path of kept.caches) expect(await gone(path)).toBe(true);
    for (const ref of kept.refs)
      expect(await run('rev-parse', '--verify', ref)).toMatch(/^[0-9a-f]{40}$/u);

    const pinned = await withCache('pinned');
    const withRefs = await prune({ statuses: ['completed'], refs: true });
    expect(withRefs.removed).toMatchObject([
      { runId: 'pinned', refsRemoved: pinned.refs, keptRefs: [] },
    ]);
    for (const ref of pinned.refs)
      expect(await run('for-each-ref', '--format=%(refname)', ref)).toBe('');
    expect(await readdir(stateDir)).toEqual(['.gitignore']);
  });
});
