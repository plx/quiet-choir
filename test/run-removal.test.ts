import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ThresholdLogger } from '../src/application/execution.js';
import { workflowExitCodes } from '../src/cli/workflow-errors.js';
import { defineWorkflow, NodeProcessRunner, readRun, runWorkflow } from '../src/index.js';
import { groupState, processIdentity } from '../src/processes/identity.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { inspectRun, listRuns } from '../src/workflow/loader/inspection.js';
import type { WorkflowCommandResult } from '../src/workflow/loader/model.js';
import { prepareStartLaunch } from '../src/workflow/loader/start.js';
import {
  answerPath,
  listPending,
  withdrawDeliveryIfRunRemoved,
  writeAnswer,
} from '../src/workflow/runtime/inbox.js';
import { formatArgv } from '../src/workflow/runtime/commands.js';
import { defaultStateDir } from '../src/workflow/runtime/paths.js';
import { readRequiredRun } from '../src/workflow/runtime/read-required-run.js';
import {
  removeRun,
  type RemovalStep,
  type RunRemovalResult,
} from '../src/workflow/runtime/run-removal.js';
import { runBytes } from '../src/workflow/runtime/run-size.js';
import { cleanupAdminWait } from '../src/workflow/runtime/worktrees.js';
import { WorktreeGit } from '../src/worktrees/git.js';
import { testInvocation } from './harness-invocation.js';
import { holdAdminLock } from './worktree-admin-holder.js';

const DEAD = 2_000_000_000;
const processRunner = new NodeProcessRunner();
const executor = new WorkflowExecutor({ logger: new ThresholdLogger('silent', () => undefined) });
let root: string;
let stateDir: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'quiet-choir-rm-')));
  stateDir = join(root, 'runs');
  vi.stubEnv('XDG_STATE_HOME', join(root, 'xdg'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const child of children.splice(0))
    if (child.pid && groupState({ pid: child.pid, pgid: child.pid }) !== 'dead') {
      const exited = once(child, 'exit');
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* reaped already */
      }
      await exited;
    }
  await rm(root, { recursive: true, force: true });
});

function plan(runId: string, flags: { force?: boolean; refs?: boolean; dryRun?: boolean } = {}) {
  return {
    kind: 'workflow.rm' as const,
    runId,
    stateDir,
    force: flags.force ?? false,
    refs: flags.refs ?? false,
    dryRun: flags.dryRun ?? false,
  };
}

async function remove(
  runId: string,
  flags: { force?: boolean; refs?: boolean; dryRun?: boolean } = {},
): Promise<WorkflowCommandResult> {
  return executor.execute(plan(runId, flags));
}

function removed(result: WorkflowCommandResult): RunRemovalResult {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  assert(result.kind === 'workflow.rm.result');
  return result;
}

function refused(result: WorkflowCommandResult, code: string) {
  assert(!result.ok, 'expected a refusal');
  expect(result.code).toBe(code);
  expect(workflowExitCodes[result.code]).toBe(code === 'workflow.storage' ? 74 : 3);
  return result;
}

const step = <T>(value: T) => ({
  input: null,
  schema: z.unknown(),
  run: () => value,
});

async function completedRun(runId: string): Promise<void> {
  const workflow = defineWorkflow({
    name: 'rm',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run: (ctx) => ctx.step('one', step(1)),
  });
  expect((await runWorkflow(workflow, { runId, stateDir, cwd: root, input: null })).status).toBe(
    'completed',
  );
}

const askWorkflow = defineWorkflow({
  name: 'rm-ask',
  version: '1',
  input: z.null(),
  output: z.unknown(),
  run: (ctx) => ctx.ask('gate', { prompt: 'Ship?', schema: z.boolean() }),
});

async function suspendedRun(runId: string): Promise<void> {
  expect((await runWorkflow(askWorkflow, { runId, stateDir, cwd: root, input: null })).status).toBe(
    'suspended',
  );
}

async function failedWaitingRun(runId: string): Promise<void> {
  const workflow = defineWorkflow({
    name: 'rm-failed',
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
  await expect(runWorkflow(workflow, { runId, stateDir, cwd: root, input: null })).rejects.toThrow(
    'body failed',
  );
  const saved = await readRun({ stateDir, runId });
  expect(saved.status).toBe('failed');
  expect(saved.steps['gate']?.status).toBe('waiting');
}

/** An unmigrated flat format-1 record, as an old binary left it. */
async function flatRecord(runId: string, status: 'running' | 'completed'): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const time = '2026-01-01T00:00:00.000Z';
  await writeFile(
    join(stateDir, `${runId}.json`),
    JSON.stringify({
      formatVersion: 1,
      id: runId,
      workflow: { name: 'flat', version: '1', fingerprint: null },
      status,
      cwd: '/',
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

/** The captured format-1 run `legacy`, flat and unmigrated, with a legacy inbox and cancel request. */
async function unmigratedLegacy(): Promise<void> {
  await mkdir(join(stateDir, 'legacy.inbox'), { recursive: true });
  await writeFile(join(stateDir, 'legacy.json'), await readFile(legacyFixture, 'utf8'));
  await writeFile(join(stateDir, 'legacy.inbox', 'answer.json'), '{"value":true}');
  await writeFile(join(stateDir, 'legacy.cancel.json'), '{}');
}

/** The same capture migrated as test/journal.test.ts does: a marker, `.v1` and `legacy/`. */
async function migratedLegacy(): Promise<void> {
  await unmigratedLegacy();
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
  expect((await readdir(stateDir)).sort()).toEqual(
    expect.arrayContaining(['legacy', 'legacy.json', 'legacy.json.v1', 'legacy.inbox']),
  );
}

interface Planted {
  readonly owner?: object | null;
  readonly recovery?: object;
  readonly files?: Record<string, string>;
}

/** A lock directory in the style of test/unlock.test.ts. */
async function plant(path: string, planted: Planted = {}): Promise<void> {
  await mkdir(path, { recursive: true });
  if (planted.owner !== null)
    await writeFile(join(path, 'owner.json'), JSON.stringify(planted.owner ?? owner(DEAD, 'old')));
  if (planted.recovery)
    await writeFile(join(path, 'recovery.json'), JSON.stringify(planted.recovery));
  for (const [name, value] of Object.entries(planted.files ?? {})) {
    await mkdir(join(path, name, '..'), { recursive: true });
    await writeFile(join(path, name), value);
  }
}

function owner(pid: number, token: string, host = hostname(), extra: object = {}): object {
  return { pid, host, token, ...extra };
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

/** What the runs container holds after a run was removed: only the ignore file. */
async function onlyIgnoreFileLeft(): Promise<void> {
  expect(await readdir(stateDir)).toEqual(['.gitignore']);
}

describe('workflow rm guards', () => {
  it('refuses a suspended run without --force and removes it with --force', async () => {
    await suspendedRun('asked');
    const refusal = refused(await remove('asked'), 'run.active');
    expect(refusal.message).toContain('is suspended');
    expect(refusal.details).toMatchObject({ status: 'suspended', waiting: ['gate'] });
    expect((await readRun({ stateDir, runId: 'asked' })).status).toBe('suspended');
    expect(removed(await remove('asked', { force: true }))).toMatchObject({
      removed: true,
      force: true,
      verdict: 'remove',
    });
    await onlyIgnoreFileLeft();
  });

  it('refuses a failed run that still has a waiting step, and removes it with --force', async () => {
    await failedWaitingRun('waiting');
    expect(refused(await remove('waiting'), 'run.active').details).toMatchObject({
      status: 'failed',
      waiting: ['gate'],
    });
    removed(await remove('waiting', { force: true }));
    await onlyIgnoreFileLeft();
  });

  it('refuses a running run, and with --force recovers its dead owner’s lock to remove it', async () => {
    await flatRecord('busy', 'running');
    await plant(join(stateDir, 'busy.json.lock'));
    expect(refused(await remove('busy'), 'run.active').details).toMatchObject({
      status: 'running',
    });
    expect(await gone(join(stateDir, 'busy.json.lock'))).toBe(false);
    removed(await remove('busy', { force: true }));
    await onlyIgnoreFileLeft();
  });

  it('removes a completed run without --force', async () => {
    await completedRun('done');
    removed(await remove('done'));
    await onlyIgnoreFileLeft();
    await expect(readRequiredRun({ stateDir, runId: 'done' })).rejects.toMatchObject({
      code: 'run.not_found',
    });
  });

  it.each([
    [
      'a live local owner',
      () => ({
        owner: owner(process.pid, 'live', hostname(), {
          osStartTime: processIdentity(process.pid)?.start ?? null,
        }),
      }),
      'alive',
    ],
    ['an unverifiable owner', () => ({ owner: owner(23_456, 'eperm') }), 'unknown'],
    ['a foreign host', () => ({ owner: owner(DEAD, 'far', `${hostname()}-gone`) }), 'remote'],
    ['a live recoverer', () => ({ recovery: owner(process.pid, 'rec') }), 'alive'],
  ] as const)('refuses %s even with --force, changing nothing', async (_name, planted, state) => {
    await completedRun('held');
    await plant(join(stateDir, 'held', 'lock'), planted());
    const real = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 23_456) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return real(pid, signal);
    });
    const before = await snapshot(stateDir);
    const refusal = refused(await remove('held', { force: true }), 'run.locked');
    expect(refusal.details).toMatchObject({ kind: 'primary', state });
    if (state === 'remote')
      expect(refusal.message).toContain(
        `quiet-choir workflow unlock held --state-dir ${stateDir} --force-remote`,
      );
    expect(await snapshot(stateDir)).toEqual(before);
  });

  it('lists the unlock command behind the invocation launcher for a foreign or unreadable lock', async () => {
    const launcher = [process.execPath, '/abs/bin/run.js'];
    const behind = new WorkflowExecutor({
      logger: new ThresholdLogger('silent', () => undefined),
      commandLauncher: launcher,
    });
    await completedRun('held');
    const lock = join(stateDir, 'held', 'lock');
    const unlock = [...launcher, 'workflow', 'unlock', 'held', '--state-dir', stateDir];
    for (const [planted, argv] of [
      [{ owner: owner(DEAD, 'far', `${hostname()}-gone`) }, [...unlock, '--force-remote']],
      [{ owner: null, files: { 'owner.json': '{bad' } }, unlock],
    ] as const) {
      await rm(lock, { recursive: true, force: true });
      await plant(lock, planted);
      for (const dryRun of [false, true]) {
        const result = await behind.execute({ ...plan('held', { force: true }), dryRun });
        if (dryRun) {
          // A dry run reports the verdict's code and message only.
          assert(result.ok && result.kind === 'workflow.rm.result');
          expect(result.verdict).toMatchObject({ code: 'run.locked' });
          expect((result.verdict as { message: string }).message).toContain(formatArgv(argv));
          continue;
        }
        const refusal = refused(result, 'run.locked');
        expect(refusal.details).toMatchObject({ next: [{ argv }] });
        expect(refusal.message).toContain(formatArgv(argv));
        expect(refusal.next).toEqual([{ why: expect.any(String) as unknown, argv }]);
      }
    }
  });

  it('hands the launcher to start and clean refusals as well', async () => {
    const launcher = [process.execPath, '/abs/bin/run.js'];
    const behind = new WorkflowExecutor({
      logger: new ThresholdLogger('silent', () => undefined),
      commandLauncher: launcher,
    });
    await completedRun('held');
    await plant(join(stateDir, 'held', 'lock'), { owner: owner(DEAD, 'far', 'elsewhere') });
    await plant(join(stateDir, 'held.json.lock'), { owner: owner(DEAD, 'far', 'elsewhere') });
    const argv = [
      ...launcher,
      'workflow',
      'unlock',
      'held',
      '--state-dir',
      stateDir,
      '--force-remote',
    ];
    // Start only reaches the guard for a run ID that has no record yet.
    await plant(join(stateDir, 'fresh.json.lock'), { owner: owner(DEAD, 'far', 'elsewhere') });
    const started = await prepareStartLaunch(
      { runId: 'fresh', stateDir, cwd: root },
      undefined,
      launcher,
    );
    assert(!started.ok);
    expect(started.details).toMatchObject({
      next: [{ argv: [...argv.slice(0, 4), 'fresh', ...argv.slice(5)] }],
    });
    const cleaned = await behind.execute({
      kind: 'workflow.clean',
      runId: 'held',
      stateDir,
      refs: false,
    });
    assert(!cleaned.ok);
    expect(cleaned.code).toBe('run.locked');
    expect(cleaned.details).toMatchObject({ next: [{ argv }] });
    expect(cleaned.next).toEqual([{ why: expect.any(String) as unknown, argv }]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a dead owner’s live recorded child as run.orphans, changing nothing',
    async () => {
      await completedRun('orphan');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      children.push(child);
      assert(child.pid);
      await delay(50);
      await plant(join(stateDir, 'orphan', 'lock'), {
        files: {
          [`processes/${String(child.pid)}.json`]: JSON.stringify({
            pid: child.pid,
            pgid: child.pid,
            binary: 'fake-harness',
            cwd: stateDir,
            startedAt: new Date().toISOString(),
            osStartTime: processIdentity(child.pid)?.start ?? null,
            runId: 'orphan',
            stepId: 'review',
            attempt: 1,
            ownerToken: 'old',
          }),
        },
      });
      const before = await snapshot(stateDir);
      const refusal = refused(await remove('orphan', { force: true }), 'run.orphans');
      expect(refusal.message).toContain('--kill-orphans');
      expect(refusal.details).toMatchObject({ processes: [{ state: 'alive' }] });
      expect(await snapshot(stateDir)).toEqual(before);
    },
  );

  it('reports a missing run as run.not_found without creating the runs container', async () => {
    refused(await remove('nothing'), 'run.not_found');
    refused(await remove('nothing', { dryRun: true }), 'run.not_found');
    expect(await gone(stateDir)).toBe(true);
  });
});

describe('workflow rm deletion', () => {
  it('deletes a directory run with its transcripts, artifacts, launch files and inbox', async () => {
    await completedRun('full');
    const directory = join(stateDir, 'full');
    for (const [name, value] of [
      ['attempts/one/1.jsonl', 'transcript\n'],
      ['artifacts/one/1/report.txt', 'artifact'],
      ['launch/1.json', '{}'],
      ['inbox/gate.json', '{}'],
    ] as const) {
      await mkdir(join(directory, name, '..'), { recursive: true });
      await writeFile(join(directory, name), value);
    }
    const bytes = await runBytes(stateDir, 'full');
    const result = removed(await remove('full'));
    expect(result).toMatchObject({
      paths: [directory],
      bytes,
      caches: [],
      tombstones: [],
      launchOnly: false,
    });
    await onlyIgnoreFileLeft();
    expect(await gone(join(root, 'xdg'))).toBe(true);
  });

  it('deletes an unmigrated flat run with its legacy inbox and cancel request', async () => {
    await unmigratedLegacy();
    const result = removed(await remove('legacy'));
    expect([...result.paths].sort()).toEqual(
      ['legacy.cancel.json', 'legacy.inbox', 'legacy.json'].map((name) => join(stateDir, name)),
    );
    await onlyIgnoreFileLeft();
    await expect(readRequiredRun({ stateDir, runId: 'legacy' })).rejects.toMatchObject({
      code: 'run.not_found',
    });
    expect(await gone(join(root, 'xdg'))).toBe(true);
  });

  it('deletes a migrated run: marker, backup, directory, inbox and cancel request', async () => {
    await migratedLegacy();
    const result = removed(await remove('legacy'));
    expect([...result.paths].sort()).toEqual(
      ['legacy', 'legacy.cancel.json', 'legacy.inbox', 'legacy.json', 'legacy.json.v1'].map(
        (name) => join(stateDir, name),
      ),
    );
    await onlyIgnoreFileLeft();
    await expect(readRequiredRun({ stateDir, runId: 'legacy' })).rejects.toMatchObject({
      code: 'run.not_found',
    });
  });

  it('never registers a project, even for a run in the default runs container', async () => {
    const project = join(root, 'project');
    await mkdir(project);
    const workflow = defineWorkflow({
      name: 'rm',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) => ctx.step('one', step(1)),
    });
    await runWorkflow(workflow, { runId: 'home', cwd: project, input: null });
    const runs = defaultStateDir(project);
    const registration = join(runs, '..', 'project.json');
    expect(await gone(registration)).toBe(false);
    await rm(registration);
    removed(await executor.execute({ ...plan('home'), stateDir: runs }));
    expect(await gone(registration)).toBe(true);
    expect(await readdir(runs)).toEqual(['.gitignore']);
  });
});

describe('workflow rm and a racing answer', () => {
  /** A delivery recreated at `path`, as a writer that linked after rm's final sweep leaves it. */
  async function lateDelivery(path: string, runCreatedAt: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ value: true, runCreatedAt }));
  }

  it.each([
    ['the format-7 inbox', () => answerPath(stateDir, 'asked', 'gate')],
    ['the legacy flat inbox', () => join(stateDir, 'asked.inbox', 'gate.answer.json')],
  ])('withdraws a delivery linked into %s after the run was removed', async (_name, target) => {
    await suspendedRun('asked');
    const run = await readRun({ stateDir, runId: 'asked' });
    removed(await remove('asked', { force: true }));
    const path = target();
    await lateDelivery(path, run.createdAt);
    await expect(withdrawDeliveryIfRunRemoved(stateDir, run, path)).rejects.toMatchObject({
      name: 'AnswerError',
      reason: 'conflict',
      message: 'Run asked was removed while the answer was being delivered.',
    });
    await onlyIgnoreFileLeft();
  });

  it('withdraws only the delivery when the ID now names another run', async () => {
    await suspendedRun('asked');
    const run = await readRun({ stateDir, runId: 'asked' });
    removed(await remove('asked', { force: true }));
    await completedRun('asked');
    const path = join(stateDir, 'asked', 'inbox', 'gate.answer.json');
    await lateDelivery(path, run.createdAt);
    await expect(withdrawDeliveryIfRunRemoved(stateDir, run, path)).rejects.toMatchObject({
      reason: 'conflict',
    });
    expect(await gone(path)).toBe(true);
    expect((await readRun({ stateDir, runId: 'asked' })).status).toBe('completed');
  });

  it('keeps a delivery to the run that reuses the ID, byte for byte', async () => {
    await suspendedRun('asked');
    const run = await readRun({ stateDir, runId: 'asked' });
    removed(await remove('asked', { force: true }));
    await delay(5);
    await suspendedRun('asked');
    const replacement = await readRun({ stateDir, runId: 'asked' });
    expect(replacement.createdAt).not.toBe(run.createdAt);
    // The replacement rejected the stale envelope and a new writer published at the same path.
    const delivery = await writeAnswer({ stateDir, runId: 'asked', stepId: 'gate', value: true });
    const bytes = await readFile(delivery.path);
    expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({
      runCreatedAt: replacement.createdAt,
    });
    await expect(withdrawDeliveryIfRunRemoved(stateDir, run, delivery.path)).rejects.toMatchObject({
      reason: 'conflict',
    });
    expect(await readFile(delivery.path)).toEqual(bytes);
    expect(await readdir(join(delivery.path, '..'))).toEqual([basename(delivery.path)]);
    expect(
      (
        await runWorkflow(askWorkflow, {
          runId: 'asked',
          stateDir,
          cwd: root,
          input: null,
          resume: true,
        })
      ).status,
    ).toBe('completed');
  });

  it('keeps an envelope it cannot read at the path', async () => {
    await suspendedRun('asked');
    const run = await readRun({ stateDir, runId: 'asked' });
    removed(await remove('asked', { force: true }));
    const path = answerPath(stateDir, 'asked', 'gate');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'not json');
    await expect(withdrawDeliveryIfRunRemoved(stateDir, run, path)).rejects.toMatchObject({
      reason: 'conflict',
    });
    expect(await readFile(path, 'utf8')).toBe('not json');
    expect(await readdir(join(path, '..'))).toEqual([basename(path)]);
  });

  it('still reports the conflict when nothing is left at the path', async () => {
    await suspendedRun('asked');
    const run = await readRun({ stateDir, runId: 'asked' });
    removed(await remove('asked', { force: true }));
    await expect(
      withdrawDeliveryIfRunRemoved(stateDir, run, answerPath(stateDir, 'asked', 'gate')),
    ).rejects.toMatchObject({ reason: 'conflict' });
    await onlyIgnoreFileLeft();
  });

  it('a run that reuses the ID rejects a delivery addressed to the removed run', async () => {
    await suspendedRun('asked');
    const first = await readRun({ stateDir, runId: 'asked' });
    const delivery = await writeAnswer({ stateDir, runId: 'asked', stepId: 'gate', value: true });
    const envelope = JSON.parse(await readFile(delivery.path, 'utf8')) as Record<string, unknown>;
    expect(envelope['runCreatedAt']).toBe(first.createdAt);
    removed(await remove('asked', { force: true }));
    await delay(5);
    await suspendedRun('asked');
    const second = await readRun({ stateDir, runId: 'asked' });
    expect(second.createdAt).not.toBe(first.createdAt);
    expect(second.steps['gate']?.fingerprint).toBe(delivery.questionFingerprint);
    // The old writer's link lands after the new run registered the same question.
    await mkdir(join(delivery.path, '..'), { recursive: true });
    await writeFile(delivery.path, JSON.stringify(envelope));
    expect((await listPending({ stateDir }))[0]?.delivery).toEqual({
      state: 'queued',
      at: null,
      by: null,
    });
    expect(
      (
        await runWorkflow(askWorkflow, {
          runId: 'asked',
          stateDir,
          cwd: root,
          input: null,
          resume: true,
        })
      ).status,
    ).toBe('suspended');
    const saved = await readRun({ stateDir, runId: 'asked' });
    expect(saved.steps['gate']?.status).toBe('waiting');
    expect(saved.steps['gate']?.question?.rejections).toEqual([
      expect.objectContaining({ error: 'Answer was addressed to an earlier run with this ID.' }),
    ]);
    expect(await gone(delivery.path)).toBe(true);
  });

  it('still accepts a delivery without runCreatedAt, as an older writer leaves it', async () => {
    await suspendedRun('asked');
    const delivery = await writeAnswer({ stateDir, runId: 'asked', stepId: 'gate', value: true });
    const { runCreatedAt, ...older } = JSON.parse(await readFile(delivery.path, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(runCreatedAt).toBeDefined();
    await writeFile(delivery.path, JSON.stringify(older));
    expect((await listPending({ stateDir }))[0]?.delivery).toMatchObject({
      state: 'queued',
      by: 'agent:unspecified',
    });
    const resumed = await runWorkflow(askWorkflow, {
      runId: 'asked',
      stateDir,
      cwd: root,
      input: null,
      resume: true,
    });
    expect(resumed).toMatchObject({ status: 'completed', output: true });
  });

  it('keeps a delivery to an intact run', async () => {
    await suspendedRun('asked');
    const delivery = await writeAnswer({ stateDir, runId: 'asked', stepId: 'gate', value: true });
    const run = await readRun({ stateDir, runId: 'asked' });
    await withdrawDeliveryIfRunRemoved(stateDir, run, delivery.path);
    expect(await gone(delivery.path)).toBe(false);
  });
});

describe('workflow rm ordering', () => {
  const steps: readonly RemovalStep[] = [
    'siblings',
    'flat',
    'backups',
    'primary-released',
    'renamed',
    'tombstone-deleted',
  ];
  const cases = steps.flatMap((stop) =>
    (['migrated', 'flat'] as const).map((layout) => [layout, stop] as const),
  );

  it.each(cases)(
    'a %s run stopped after %s lists and inspects as intact or not found',
    async (layout, stop) => {
      await (layout === 'migrated' ? migratedLegacy() : unmigratedLegacy());
      await expect(
        removeRun({ runId: 'legacy', stateDir }, processRunner, {
          afterStep: (name) => {
            if (name === stop) throw new Error(`stopped after ${name}`);
          },
        }),
      ).rejects.toThrow(`stopped after ${stop}`);
      // The seam's error released every lock through the normal path.
      expect(await gone(join(stateDir, 'legacy.json.lock'))).toBe(true);
      expect(await gone(join(stateDir, 'legacy', 'lock'))).toBe(true);
      const listed = await listRuns({ stateDir });
      expect(listed.warnings).toEqual([]);
      const present = listed.runs.some((run) => run.id === 'legacy');
      const inspected = await inspectRun({ stateDir, runId: 'legacy' }).then(
        () => 'intact',
        (error: unknown) => {
          expect(error).toMatchObject({ code: 'run.not_found' });
          return 'not found';
        },
      );
      expect(inspected).toBe(present ? 'intact' : 'not found');
      const intactUntil = layout === 'migrated' ? 'primary-released' : 'siblings';
      expect(present).toBe(steps.indexOf(stop) <= steps.indexOf(intactUntil));
      if (present) {
        removed(await remove('legacy'));
        expect((await listRuns({ stateDir })).runs).toEqual([]);
      }
      const tombstones = (await readdir(stateDir)).filter((name) => name.endsWith('.removing'));
      expect(tombstones).toHaveLength(stop === 'renamed' ? 1 : 0);
    },
  );

  it('sweeps a dead removal’s tombstone on the next rm, even of a missing run', async () => {
    await completedRun('first');
    await expect(
      removeRun({ runId: 'first', stateDir }, processRunner, {
        afterStep: (name) => {
          if (name === 'renamed') throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    const [live] = (await readdir(stateDir)).filter((name) => name.endsWith('.removing'));
    assert(live);
    expect(live).toMatch(
      new RegExp(`^\\.first\\.${String(process.pid)}\\.[0-9a-f-]{36}\\.removing$`, 'u'),
    );
    // This process is alive, so its tombstone is not swept; a dead one is.
    refused(await remove('missing'), 'run.not_found');
    expect(await gone(join(stateDir, live))).toBe(false);
    const dead = live.replace(`.${String(process.pid)}.`, `.${String(DEAD)}.`);
    await rename(join(stateDir, live), join(stateDir, dead));
    refused(await remove('missing', { dryRun: true }), 'run.not_found');
    expect(await gone(join(stateDir, dead))).toBe(false);
    refused(await remove('missing'), 'run.not_found');
    expect(await gone(join(stateDir, dead))).toBe(true);
    // An rm of another run sweeps too, and reports what it swept.
    await completedRun('second');
    await mkdir(join(stateDir, dead));
    expect(removed(await remove('second')).tombstones).toEqual([dead]);
    await onlyIgnoreFileLeft();
  });
});

describe('workflow rm and a replaced run', () => {
  it.each([false, true])(
    'refuses a run that reused the ID after inspection and leaves it intact (force %s)',
    async (force) => {
      await completedRun('reused');
      const inspected = (await readRequiredRun({ runId: 'reused', stateDir })).createdAt;
      let replaced = '';
      await expect(
        removeRun({ runId: 'reused', stateDir, force }, processRunner, {
          beforeLock: async () => {
            // Another rm removed the inspected run and a new one reused its ID.
            await rm(join(stateDir, 'reused'), { recursive: true, force: true });
            await delay(5);
            await completedRun('reused');
            replaced = (await readRequiredRun({ runId: 'reused', stateDir })).createdAt;
            expect(replaced).not.toBe(inspected);
          },
        }),
      ).rejects.toMatchObject({ code: 'run.exists', runId: 'reused' });
      expect((await readRequiredRun({ runId: 'reused', stateDir })).createdAt).toBe(replaced);
      expect(await gone(join(stateDir, 'reused', 'lock'))).toBe(true);
      expect(await gone(join(stateDir, 'reused.json.lock'))).toBe(true);
      // A fresh rm inspects the replacement and removes it.
      removed(await remove('reused', { force }));
      await onlyIgnoreFileLeft();
    },
  );

  it('leaves the replacement’s checkpoint files untouched when it refuses', async () => {
    await completedRun('reused');
    let before: Record<string, string> = {};
    await expect(
      removeRun({ runId: 'reused', stateDir }, processRunner, {
        beforeLock: async () => {
          await rm(join(stateDir, 'reused'), { recursive: true, force: true });
          await delay(5);
          await completedRun('reused');
          before = await snapshot(join(stateDir, 'reused'));
        },
      }),
    ).rejects.toMatchObject({ code: 'run.exists' });
    expect(Object.keys(before).length).toBeGreaterThan(0);
    expect(await snapshot(join(stateDir, 'reused'))).toEqual(before);
  });
});

describe('workflow rm with an expected updatedAt (prune)', () => {
  /** Rewrite the saved record's updatedAt in place, as a resume or answer that saved would. */
  async function touch(runId: string): Promise<string> {
    const run = await readRun({ stateDir, runId });
    const updatedAt = new Date(Date.parse(run.updatedAt) + 1000).toISOString();
    for (const name of ['run.json', 'journal.jsonl']) {
      const file = join(stateDir, runId, name);
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text !== undefined) await writeFile(file, text.replaceAll(run.updatedAt, updatedAt));
    }
    expect((await readRun({ stateDir, runId })).updatedAt).toBe(updatedAt);
    return updatedAt;
  }

  it('refuses a record that changed before the first read, changing nothing', async () => {
    await completedRun('pinned');
    const selected = (await readRun({ stateDir, runId: 'pinned' })).updatedAt;
    const updatedAt = await touch('pinned');
    const before = await snapshot(stateDir);
    await expect(
      removeRun({ runId: 'pinned', stateDir, expectedUpdatedAt: selected }, processRunner),
    ).rejects.toMatchObject({
      code: 'run.exists',
      message: `Run pinned changed after prune selected it (updatedAt ${selected}, now ${updatedAt}); nothing was removed. Re-run prune to judge the current record.`,
      details: { expectedUpdatedAt: selected, updatedAt },
    });
    expect(await snapshot(stateDir)).toEqual(before);
  });

  it('refuses a changed record in a dry run too, changing nothing', async () => {
    await completedRun('pinned');
    const selected = (await readRun({ stateDir, runId: 'pinned' })).updatedAt;
    const updatedAt = await touch('pinned');
    const before = await snapshot(stateDir);
    await expect(
      removeRun(
        { runId: 'pinned', stateDir, dryRun: true, expectedUpdatedAt: selected },
        processRunner,
      ),
    ).rejects.toMatchObject({
      code: 'run.exists',
      details: { expectedUpdatedAt: selected, updatedAt },
    });
    expect(await snapshot(stateDir)).toEqual(before);
  });

  it('plans a dry run when the record still carries the expected updatedAt', async () => {
    await completedRun('pinned');
    const selected = (await readRun({ stateDir, runId: 'pinned' })).updatedAt;
    const outcome = await removeRun(
      { runId: 'pinned', stateDir, dryRun: true, expectedUpdatedAt: selected },
      processRunner,
    );
    expect(outcome).toMatchObject({ kind: 'removed', result: { dryRun: true, removed: false } });
  });

  it('refuses a record that changed before the lock, and releases every lock', async () => {
    await completedRun('pinned');
    const selected = (await readRun({ stateDir, runId: 'pinned' })).updatedAt;
    let updatedAt = '';
    const refusal: unknown = await removeRun(
      { runId: 'pinned', stateDir, expectedUpdatedAt: selected },
      processRunner,
      {
        beforeLock: async () => {
          updatedAt = await touch('pinned');
        },
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      code: 'run.exists',
      details: { expectedUpdatedAt: selected, updatedAt },
    });
    expect((await readRun({ stateDir, runId: 'pinned' })).updatedAt).toBe(updatedAt);
    expect(await gone(join(stateDir, 'pinned', 'lock'))).toBe(true);
    expect(await gone(join(stateDir, 'pinned.json.lock'))).toBe(true);
  });

  it('removes a record that still carries the expected updatedAt', async () => {
    await completedRun('pinned');
    const selected = (await readRun({ stateDir, runId: 'pinned' })).updatedAt;
    const outcome = await removeRun(
      { runId: 'pinned', stateDir, expectedUpdatedAt: selected },
      processRunner,
    );
    expect(outcome).toMatchObject({ kind: 'removed', result: { removed: true } });
    await onlyIgnoreFileLeft();
  });
});

describe('workflow rm and a racing start', () => {
  it.each(['flat', 'primary-released'] as const)(
    'start refuses while an unmigrated flat run is removed (after %s), and succeeds after',
    async (stop) => {
      await flatRecord('flat', 'completed');
      const directory = join(stateDir, 'flat');
      let attempted = false;
      await removeRun({ runId: 'flat', stateDir }, processRunner, {
        afterStep: async (name) => {
          if (name === stop) {
            // The flat record is gone, but rm still holds the legacy guard.
            expect(await gone(join(stateDir, 'flat.json'))).toBe(true);
            const prepared = await prepareStartLaunch({ runId: 'flat', stateDir, cwd: root });
            assert(!prepared.ok, 'start must refuse mid-removal');
            expect(prepared.code).toBe('run.locked');
            expect(prepared.message).toContain('Run ID flat is locked or being removed');
            expect(await gone(join(directory, 'launch'))).toBe(true);
            attempted = true;
          }
          if (name === 'renamed') {
            const [tombstone] = (await readdir(stateDir)).filter((entry) =>
              entry.endsWith('.removing'),
            );
            assert(tombstone);
            const entries = await readdir(join(stateDir, tombstone), { recursive: true });
            expect(entries.filter((entry) => entry.includes('launch'))).toEqual([]);
          }
        },
      });
      expect(attempted).toBe(true);
      await onlyIgnoreFileLeft();
      const prepared = await prepareStartLaunch({ runId: 'flat', stateDir, cwd: root });
      assert(prepared.ok);
      await Promise.all(prepared.files.handles.map((handle) => handle.close()));
      expect(prepared.files.log).toBe(join(directory, 'launch', '1.log'));
      expect(await readdir(join(directory, 'launch'))).toEqual(['1.log', '1.result.json']);
      expect(await gone(join(stateDir, 'flat.json.lock'))).toBe(true);
    },
  );
});

describe('workflow rm dry run', () => {
  it('reports the verdict, paths, bytes and sweepable tombstones, changing nothing', async () => {
    await completedRun('keep');
    await suspendedRun('active');
    const tombstone = `.old.${String(DEAD)}.00000000-0000-4000-8000-000000000000.removing`;
    await mkdir(join(stateDir, tombstone, 'journal'), { recursive: true });
    const before = await snapshot(root);
    const preview = removed(await remove('keep', { dryRun: true }));
    expect(preview).toMatchObject({
      dryRun: true,
      removed: false,
      verdict: 'remove',
      paths: [join(stateDir, 'keep')],
      caches: [],
      refsRemoved: [],
      keptRefs: [],
      bytes: await runBytes(stateDir, 'keep'),
      tombstones: [tombstone],
    });
    expect(preview.bytes).toBeGreaterThan(0);
    const active = removed(await remove('active', { dryRun: true }));
    expect(active.verdict).toMatchObject({ code: 'run.active' });
    expect(removed(await remove('active', { dryRun: true, force: true })).verdict).toBe('remove');
    expect(await snapshot(root)).toEqual(before);
  });
});

// measured: 0.14-0.61 s per case alone (Git processes, and a forked tsx lock holder for the blocked
// case); the same Git work in test/worktrees.test.ts reaches 3.1 s in loaded full coverage runs.
describe('workflow rm worktree caches', { timeout: 10_000 }, () => {
  let repo: string;
  let caches: string;
  const git = new WorktreeGit(processRunner);
  const invocation = testInvocation();
  const command = (...args: string[]) => git.text(repo, args, invocation);

  beforeEach(async () => {
    repo = join(root, 'repo');
    caches = join(root, 'caches');
    await mkdir(repo);
    await command('init', '-q');
    await writeFile(join(repo, 'file.txt'), 'base\n');
    await command('add', '--all');
    await command(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@localhost',
      'commit',
      '-qm',
      'base',
    );
  });

  /** A finished run with one kept cache per handle (one by default) and their pinned refs. */
  async function runWithCache(runId: string, handles: readonly string[] = ['cache']) {
    const workflow = defineWorkflow({
      name: runId,
      version: '1',
      input: z.null(),
      output: z.null(),
      async run(ctx) {
        for (const handle of handles) await ctx.worktree(handle);
        return null;
      },
    });
    const run = await runWorkflow(workflow, {
      runId,
      cwd: repo,
      stateDir,
      processRunner,
      input: null,
      worktrees: { root: caches, keep: 'all' },
    });
    const ledger = run.worktrees;
    assert(ledger);
    const paths = Object.values(ledger.caches).map((cache) => cache.path);
    expect(paths).toHaveLength(handles.length);
    const [path] = paths;
    assert(path);
    const refs = Object.keys(ledger.refs);
    expect(refs.length).toBeGreaterThan(0);
    return { path, paths, refs, namespace: join(caches, `${runId}-${ledger.namespace}`) };
  }

  const repoState = async () => ({
    refs: await command('for-each-ref', '--format=%(refname) %(objectname)'),
    worktrees: await command('worktree', 'list', '--porcelain'),
  });

  it('previews, then removes caches through Git and keeps pins unless --refs', async () => {
    const kept = await runWithCache('kept');
    const before = { tree: await snapshot(root), repo: await repoState() };
    expect(removed(await remove('kept', { dryRun: true }))).toMatchObject({
      caches: [{ path: kept.path, method: 'git' }],
      refsRemoved: [],
      keptRefs: kept.refs,
    });
    expect(removed(await remove('kept', { dryRun: true, refs: true }))).toMatchObject({
      refsRemoved: kept.refs,
      keptRefs: [],
    });
    expect({ tree: await snapshot(root), repo: await repoState() }).toEqual(before);

    expect(removed(await remove('kept'))).toMatchObject({
      caches: [{ path: kept.path, method: 'git' }],
      refsRemoved: [],
      keptRefs: kept.refs,
      warnings: [],
    });
    expect(await gone(kept.path)).toBe(true);
    expect(await gone(kept.namespace)).toBe(true);
    for (const ref of kept.refs)
      expect(await command('rev-parse', '--verify', ref)).toMatch(/^[0-9a-f]{40}$/u);

    const pinned = await runWithCache('pinned');
    expect(removed(await remove('pinned', { refs: true }))).toMatchObject({
      caches: [{ path: pinned.path, method: 'git' }],
      refsRemoved: pinned.refs,
      keptRefs: [],
    });
    expect(await gone(pinned.namespace)).toBe(true);
    for (const ref of pinned.refs)
      expect(await command('for-each-ref', '--format=%(refname)', ref)).toBe('');
    await onlyIgnoreFileLeft();
  });

  it('stops before deleting the run when Git cannot remove a cache, naming it', async () => {
    const blocked = await runWithCache('blocked');
    const holder = holdAdminLock(await realpath(join(repo, '.git')), 'forever');
    await holder.held;
    const original = cleanupAdminWait.ms;
    cleanupAdminWait.ms = 200;
    try {
      const failure = refused(await remove('blocked', { refs: true }), 'workflow.storage');
      expect(failure.message).toContain(blocked.path);
      expect(failure.message).toContain(
        `quiet-choir workflow clean blocked --state-dir ${stateDir}`,
      );
      const launched = new WorkflowExecutor({
        logger: new ThresholdLogger('silent', () => undefined),
        commandLauncher: [process.execPath, '/abs/bin/run.js'],
      });
      const viaLauncher = refused(
        await launched.execute(plan('blocked', { refs: true })),
        'workflow.storage',
      );
      expect(viaLauncher.message).toContain(
        `${formatArgv([process.execPath, '/abs/bin/run.js'])} workflow clean blocked --state-dir ${stateDir}`,
      );
      expect(viaLauncher.message).not.toContain('quiet-choir workflow');
      expect(failure.details).toMatchObject({
        caches: [blocked.path],
        removedCaches: [],
        warnings: [
          expect.stringContaining('Timed out waiting for the worktree administration lock'),
        ],
      });
    } finally {
      cleanupAdminWait.ms = original;
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
    expect((await readRun({ stateDir, runId: 'blocked' })).worktrees?.caches).toBeDefined();
    expect(await gone(blocked.path)).toBe(false);
    // Refs are kept while a cache remains, so a retry can still pin the work.
    for (const ref of blocked.refs)
      expect(await command('rev-parse', '--verify', ref)).toMatch(/^[0-9a-f]{40}$/u);
    expect(await gone(join(stateDir, 'blocked.json.lock'))).toBe(true);
    removed(await remove('blocked', { refs: true }));
    await onlyIgnoreFileLeft();
  });

  it('keeps the caches Git removed before a later cache blocked the removal', async () => {
    const partial = await runWithCache('partial', ['first', 'second']);
    const [first, second] = partial.paths;
    assert(first && second);
    // Unregister the second cache from Git while its directory stays, which cleanup refuses.
    const gitdir = /^gitdir: (.+)$/mu.exec(await readFile(join(second, '.git'), 'utf8'))?.[1];
    assert(gitdir);
    await rm(gitdir, { recursive: true, force: true });
    const failure = refused(await remove('partial', { refs: true }), 'workflow.storage');
    expect(failure.details).toMatchObject({
      caches: [second],
      removedCaches: [first],
      warnings: [expect.stringContaining('Unregistered directory exists')],
    });
    expect(await gone(first)).toBe(true);
    expect(await gone(second)).toBe(false);
    const ledger = (await readRun({ stateDir, runId: 'partial' })).worktrees;
    const states = Object.fromEntries(
      Object.values(ledger?.caches ?? {}).map((cache) => [cache.path, cache.state]),
    );
    expect(states).toEqual({ [first]: 'removed', [second]: 'ready' });
    for (const ref of partial.refs)
      expect(await command('rev-parse', '--verify', ref)).toMatch(/^[0-9a-f]{40}$/u);
    await rm(second, { recursive: true, force: true });
    const retried = removed(await remove('partial', { refs: true }));
    expect(retried.caches).toEqual([{ path: second, method: 'git' }]);
    expect([...retried.refsRemoved].sort()).toEqual([...partial.refs].sort());
    await onlyIgnoreFileLeft();
  });

  it('deletes caches directly when their repository is gone', async () => {
    const orphaned = await runWithCache('orphaned');
    await rm(repo, { recursive: true, force: true });
    expect(removed(await remove('orphaned', { dryRun: true })).caches).toEqual([
      { path: orphaned.path, method: 'direct' },
    ]);
    const result = removed(await remove('orphaned'));
    expect(result).toMatchObject({
      caches: [{ path: orphaned.path, method: 'direct' }],
      keptRefs: [],
      warnings: [expect.stringContaining('pinned refs went with it')],
    });
    expect(await gone(orphaned.namespace)).toBe(true);
    expect(await readdir(caches)).toEqual([]);
    await onlyIgnoreFileLeft();
  });

  it('refuses to delete a cache outside its namespace when the repository is gone', async () => {
    const escaped = await runWithCache('escaped');
    const outside = join(root, 'outside');
    await cp(escaped.path, outside, { recursive: true });
    await rm(repo, { recursive: true, force: true });
    // Point the ledger's cache at a directory beside the namespace, as a corrupt record would.
    for (const name of ['run.json', 'journal.jsonl']) {
      const file = join(stateDir, 'escaped', name);
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text !== undefined) await writeFile(file, text.replaceAll(escaped.path, outside));
    }
    expect(
      Object.values((await readRun({ stateDir, runId: 'escaped' })).worktrees?.caches ?? {}),
    ).toMatchObject([{ path: outside }]);
    const failure = await remove('escaped');
    assert(!failure.ok);
    expect(failure.message).toContain('outside');
    expect(await gone(outside)).toBe(false);
    expect((await readRun({ stateDir, runId: 'escaped' })).id).toBe('escaped');
  });

  it.each([
    [
      'is not named by a digest',
      (namespace: string) => join(namespace, 'not-a-digest'),
      'not named by a SHA-256 digest',
    ],
    [
      'does not match its ledger key',
      (namespace: string) => join(namespace, '0'.repeat(64)),
      'does not match its ledger key',
    ],
  ] as const)(
    'refuses to delete a cache that %s when the repository is gone',
    async (_name, retarget, message) => {
      const forged = await runWithCache('forged');
      const planted = retarget(forged.namespace);
      await cp(forged.path, planted, { recursive: true });
      await rm(repo, { recursive: true, force: true });
      // Retarget the ledger's cache inside the namespace, keeping its key, as a corrupt record would.
      for (const name of ['run.json', 'journal.jsonl']) {
        const file = join(stateDir, 'forged', name);
        const text = await readFile(file, 'utf8').catch(() => undefined);
        if (text !== undefined) await writeFile(file, text.replaceAll(forged.path, planted));
      }
      expect(
        Object.values((await readRun({ stateDir, runId: 'forged' })).worktrees?.caches ?? {}),
      ).toMatchObject([{ path: planted }]);
      const failure = refused(await remove('forged'), 'workflow.storage');
      expect(failure.message).toContain(message);
      expect(await gone(planted)).toBe(false);
      expect(await gone(forged.path)).toBe(false);
      expect((await readRun({ stateDir, runId: 'forged' })).id).toBe('forged');
    },
  );
});

describe('workflow rm of a leftover launch directory', () => {
  const hour = 3_600_000;
  const liveRunner = () => ({
    pid: process.pid,
    host: hostname(),
    osStartTime: processIdentity(process.pid)?.start ?? null,
  });
  const deadRunner = { pid: DEAD, host: hostname(), osStartTime: null };

  /** A record-less `<runId>/launch/` as a failed start leaves it, aged `ageMs`. */
  async function leftover(
    runId: string,
    options: { runner?: object | string | null; ageMs?: number; extra?: string[] } = {},
  ): Promise<string> {
    const launch = join(stateDir, runId, 'launch');
    await mkdir(launch, { recursive: true });
    const files: Record<string, string> = {
      '1.log': 'compiler output\n',
      '1.result.json': '{"ok":false}\n',
    };
    const runner = options.runner === undefined ? deadRunner : options.runner;
    if (runner !== null)
      files['1.runner.json'] = typeof runner === 'string' ? runner : JSON.stringify(runner);
    for (const [name, value] of Object.entries(files)) await writeFile(join(launch, name), value);
    const at = new Date(Date.now() - (options.ageMs ?? 0));
    for (const name of Object.keys(files)) await utimes(join(launch, name), at, at);
    return join(stateDir, runId);
  }

  it('removes a leftover whose runner is dead, through the legacy guard', async () => {
    const directory = await leftover('broken');
    const bytes = await runBytes(stateDir, 'broken');
    const result = removed(await remove('broken', { refs: true }));
    expect(result).toMatchObject({
      launchOnly: true,
      removed: true,
      verdict: 'remove',
      refs: true,
      paths: [directory],
      bytes,
      caches: [],
      refsRemoved: [],
      keptRefs: [],
      tombstones: [],
      warnings: [],
    });
    expect(bytes).toBeGreaterThan(0);
    expect((await readdir(stateDir)).filter((name) => name !== '.gitignore')).toEqual([]);
    expect(await gone(join(root, 'xdg'))).toBe(true);
  });

  it('removes an old leftover without a runner record, but refuses a young one', async () => {
    await leftover('old', { runner: null, ageMs: 2 * hour });
    expect(removed(await remove('old')).launchOnly).toBe(true);
    expect(await gone(join(stateDir, 'old'))).toBe(true);
    const directory = await leftover('young', { runner: null });
    const before = await snapshot(directory);
    const refusal = refused(await remove('young', { force: true }), 'run.active');
    expect(refusal.message).toContain('no runner record');
    expect(refusal.details).toMatchObject({
      status: 'starting',
      waiting: [],
      launches: [{ n: 1, pid: null, host: null, state: 'none', inFlight: true }],
    });
    expect(await snapshot(directory)).toEqual(before);
    // An injected floor settles it.
    const outcome = await removeRun({ runId: 'young', stateDir }, processRunner, {
      launchSettle: { floorMs: 0, now: () => Date.now() + 1_000 },
    });
    expect(outcome).toMatchObject({ kind: 'removed', result: { launchOnly: true } });
  });

  const flying: readonly (readonly [string, () => object | string, string])[] = [
    ['a live runner', () => liveRunner(), 'alive'],
    ['a runner on another host', () => ({ ...deadRunner, host: `${hostname()}-gone` }), 'remote'],
    ['an unparsable runner record', () => '{"pid":', 'unparsable'],
  ];
  it.for(flying)(
    'refuses %s even with --force and in a dry run, changing nothing',
    async ([, runner, state]) => {
      const directory = await leftover('flying', { runner: runner(), ageMs: 2 * hour });
      const before = await snapshot(stateDir);
      const refusal = refused(await remove('flying', { force: true }), 'run.active');
      expect(refusal.message).toContain('may still create the record');
      expect(refusal.details).toMatchObject({
        status: 'starting',
        launches: [{ n: 1, state, inFlight: true }],
      });
      for (const force of [false, true]) {
        const preview = removed(await remove('flying', { dryRun: true, force }));
        expect(preview).toMatchObject({
          launchOnly: true,
          removed: false,
          verdict: { code: 'run.active' },
          paths: [directory],
        });
      }
      expect(await snapshot(stateDir)).toEqual(before);
      expect((await listRuns({ stateDir })).leftoverLaunches).toEqual([]);
    },
  );

  it('previews a removable leftover, changing nothing', async () => {
    const directory = await leftover('broken');
    const before = await snapshot(root);
    expect(removed(await remove('broken', { dryRun: true }))).toMatchObject({
      dryRun: true,
      removed: false,
      launchOnly: true,
      verdict: 'remove',
      paths: [directory],
      bytes: await runBytes(stateDir, 'broken'),
      tombstones: [],
    });
    expect(await snapshot(root)).toEqual(before);
  });

  it('refuses with run.locked while the legacy guard is held, changing nothing', async () => {
    const directory = await leftover('guarded');
    await plant(join(stateDir, 'guarded.json.lock'), {
      owner: owner(process.pid, 'live', hostname(), {
        osStartTime: processIdentity(process.pid)?.start ?? null,
      }),
    });
    const before = await snapshot(directory);
    refused(await remove('guarded'), 'run.locked');
    expect(await snapshot(directory)).toEqual(before);
  });

  it('refuses with run.active when a new launch was allocated before the guard', async () => {
    const directory = await leftover('again');
    await expect(
      removeRun({ runId: 'again', stateDir }, processRunner, {
        beforeLock: async () => {
          const prepared = await prepareStartLaunch({ runId: 'again', stateDir, cwd: root });
          assert(prepared.ok);
          await Promise.all(prepared.files.handles.map((handle) => handle.close()));
          expect(prepared.files.log).toBe(join(directory, 'launch', '2.log'));
        },
      }),
    ).rejects.toMatchObject({
      code: 'run.active',
      details: {
        launches: [
          { n: 1, inFlight: false },
          { n: 2, inFlight: true },
        ],
      },
    });
    expect((await readdir(join(directory, 'launch'))).sort()).toEqual([
      '1.log',
      '1.result.json',
      '1.runner.json',
      '2.log',
      '2.result.json',
    ]);
    expect(await gone(join(stateDir, 'again.json.lock'))).toBe(true);
  });

  it('refuses with run.exists when a record appeared before the guard, leaving it in place', async () => {
    const directory = await leftover('raced');
    let before: Record<string, string> = {};
    await expect(
      removeRun({ runId: 'raced', stateDir }, processRunner, {
        beforeLock: async () => {
          await writeFile(join(directory, 'run.json'), '{}');
          before = await snapshot(directory);
        },
      }),
    ).rejects.toMatchObject({ code: 'run.exists', runId: 'raced' });
    expect(await snapshot(directory)).toEqual(before);
    expect(await gone(join(stateDir, 'raced.json.lock'))).toBe(true);
  });

  it.for([
    ['another entry beside launch/', async (directory: string) => mkdir(join(directory, 'lock'))],
    [
      'an unknown file in launch/',
      async (directory: string) => writeFile(join(directory, 'launch', 'notes.txt'), ''),
    ],
    ['a legacy inbox', async () => mkdir(join(stateDir, 'odd.inbox'))],
    ['a legacy cancel request', async () => writeFile(join(stateDir, 'odd.cancel.json'), '{}')],
    ['a migration backup', async () => writeFile(join(stateDir, 'odd.json.v1'), '{}')],
  ] as const)('still reports run.not_found with %s', async ([, add]) => {
    const directory = await leftover('odd');
    await add(directory);
    const before = await snapshot(stateDir);
    refused(await remove('odd'), 'run.not_found');
    refused(await remove('odd', { dryRun: true }), 'run.not_found');
    expect(await snapshot(stateDir)).toEqual(before);
    expect((await listRuns({ stateDir })).leftoverLaunches).toEqual([]);
  });

  it('still reports run.unreadable for a run whose run.json is damaged', async () => {
    await completedRun('damaged');
    const directory = join(stateDir, 'damaged');
    await mkdir(join(directory, 'launch'));
    await writeFile(join(directory, 'launch', '1.log'), '');
    await writeFile(join(directory, 'run.json'), 'not json');
    refused(await remove('damaged'), 'run.unreadable');
    refused(await remove('damaged', { dryRun: true }), 'run.unreadable');
    expect(await gone(join(directory, 'launch', '1.log'))).toBe(false);
  });

  it('is listed only once every launch has settled, and never for a run with a record', async () => {
    await completedRun('real');
    await mkdir(join(stateDir, 'real', 'launch'));
    await writeFile(join(stateDir, 'real', 'launch', '1.log'), '');
    const broken = await leftover('broken', { ageMs: 2 * hour });
    await leftover('flying', { runner: liveRunner() });
    const listed = await listRuns({ stateDir });
    expect(listed.runs.map((run) => run.id)).toEqual(['real']);
    expect(listed.leftoverLaunches).toEqual([
      {
        runId: 'broken',
        stateDir,
        path: broken,
        bytes: await runBytes(stateDir, 'broken'),
        launches: [1],
        newest: expect.any(String) as unknown,
        log: join(broken, 'launch', '1.log'),
      },
    ]);
    expect(Date.now() - Date.parse(listed.leftoverLaunches[0]?.newest ?? '')).toBeGreaterThan(hour);
    expect(listed.warnings).toEqual([]);
    expect((await listRuns({ stateDir, status: 'completed' })).leftoverLaunches).toEqual([]);
    expect(removed(await remove('real')).launchOnly).toBe(false);
  });

  it('scans every registered project with --all', async () => {
    const project = join(root, 'project');
    await mkdir(project);
    const workflow = defineWorkflow({
      name: 'rm',
      version: '1',
      input: z.null(),
      output: z.unknown(),
      run: (ctx) => ctx.step('one', step(1)),
    });
    await runWorkflow(workflow, { runId: 'home', cwd: project, input: null });
    const runs = defaultStateDir(project);
    const elsewhere = join(runs, 'far');
    await mkdir(join(elsewhere, 'launch'), { recursive: true });
    await writeFile(
      join(elsewhere, 'launch', '1.runner.json'),
      JSON.stringify({ pid: DEAD, host: hostname(), osStartTime: null }),
    );
    await leftover('near');
    const listed = await listRuns({ stateDir, all: true });
    expect(listed.runs.map((run) => run.id)).toEqual(['home']);
    expect(
      listed.leftoverLaunches.map((entry) => [entry.runId, entry.stateDir, entry.log]).sort(),
    ).toEqual([
      ['far', runs, null],
      ['near', stateDir, join(stateDir, 'near', 'launch', '1.log')],
    ]);
    expect((await listRuns({ stateDir })).leftoverLaunches.map((entry) => entry.runId)).toEqual([
      'near',
    ]);
  });
});
