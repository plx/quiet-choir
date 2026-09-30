import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CliHarness,
  CheckpointError,
  defineWorkflow,
  inspectRunOwnership,
  OrphanProcessesError,
  ProcessSupervisor,
  readRun,
  runWorkflow,
  z,
  type HarnessProcess,
} from '../src/index.js';
import { groupState, processIdentity } from '../src/processes/identity.js';
import { lockRun } from '../src/workflow/runtime/store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actualFs = await vi.importActual<typeof fs>('node:fs/promises');

let directory: string;
const children: ChildProcess[] = [];
const context = { runId: 'run', stepId: 'review/3', attempt: 2 };
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'quiet-choir-registry-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      child.pid &&
      groupState({ pid: child.pid, pgid: child.pid }) !== 'dead'
    ) {
      const ended = once(child, 'exit');
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* reaped already */
      }
      await ended;
    }
  }
  await fs.rm(directory, { recursive: true, force: true });
});
async function childProcess(): Promise<HarnessProcess> {
  const child = spawn(
    process.execPath,
    ['-e', `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);`],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  children.push(child);
  await once(child.stdout, 'data');
  if (!child.pid) throw new Error('Missing fixture PID');
  const identity = processIdentity(child.pid);
  expect(identity?.start).toBeTruthy();
  return {
    pid: child.pid,
    pgid: child.pid,
    binary: 'fake-harness',
    cwd: directory,
    startedAt: new Date().toISOString(),
    osStartTime: identity?.start ?? null,
  };
}
async function abandon(): Promise<void> {
  // A real crash marks both the legacy guard and the directory lock with the same dead pid, since
  // one process acquires both; fake death in both so recovery reaches the directory lock's orphan
  // handling instead of stopping at a guard that still looks alive.
  for (const path of [
    join(directory, 'run', 'lock', 'owner.json'),
    join(directory, 'run.json.lock', 'owner.json'),
  ]) {
    const owner = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(path, JSON.stringify({ ...owner, pid: 2_000_000_000, osStartTime: null }));
  }
}

describe.skipIf(process.platform === 'win32')('durable harness ownership', () => {
  it('persists private run/step/attempt records and removes them only after reaping', async () => {
    const lock = await lockRun(directory, 'run');
    const child = await childProcess();
    const lease = await lock.trackProcess(context, child);
    const path = join(directory, 'run', 'lock', 'processes', `${String(child.pid)}.json`);
    const raw = await fs.readFile(path, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ ...context, ...child });
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(
      (await inspectRunOwnership({ stateDir: directory, runId: 'run' })).processes[0],
    ).toMatchObject({ state: 'alive' });
    await expect(lease.release()).rejects.toBeInstanceOf(OrphanProcessesError);
    const firstChild = children[0];
    if (!firstChild) throw new Error('Missing child');
    const exited = once(firstChild, 'exit');
    process.kill(-child.pid, 'SIGKILL');
    await exited;
    await lease.release();
    await lease.release();
    await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await lock();
    expect(await inspectRunOwnership({ stateDir: directory, runId: 'run' })).toEqual({
      locked: false,
      owner: null,
      processes: [],
      locks: [],
    });
  });

  it('refuses recovery with live children, then kills confirmed orphans before replacing ownership', async () => {
    const lock = await lockRun(directory, 'run');
    const child = await childProcess();
    await lock.trackProcess(context, child);
    await abandon();
    const before = await fs.readFile(join(directory, 'run', 'lock', 'owner.json'), 'utf8');
    await expect(lockRun(directory, 'run')).rejects.toMatchObject({
      code: 'run.orphans',
      runId: 'run',
    });
    expect(await fs.readFile(join(directory, 'run', 'lock', 'owner.json'), 'utf8')).toBe(before);
    expect(groupState(child)).toBe('alive');
    const inspected = await inspectRunOwnership({ stateDir: directory, runId: 'run' });
    expect(inspected.owner?.state).toBe('dead');
    expect(inspected.processes[0]?.state).toBe('alive');
    const next = await lockRun(directory, 'run', { killOrphans: true, killGraceMs: 50 });
    expect(groupState(child)).toBe('dead');
    await next();
  });

  it('finishes stopping orphans after the first interrupt and leaves replacement work unstarted', async () => {
    const lock = await lockRun(directory, 'run');
    const child = await childProcess();
    await lock.trackProcess(context, child);
    await abandon();
    const controller = new AbortController();
    const supervisor = new ProcessSupervisor();
    const send = process.kill.bind(process);
    const reason = new Error('Recovery interrupted.');
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      const sent = send(pid, signal);
      if (pid === -child.pid && signal === 'SIGTERM') controller.abort(reason);
      return sent;
    });
    await expect(
      lockRun(directory, 'run', {
        killOrphans: true,
        killGraceMs: 50,
        signal: controller.signal,
        processSupervisor: supervisor,
      }),
    ).rejects.toBe(reason);
    expect(groupState(child)).toBe('dead');
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    expect((await inspectRunOwnership({ stateDir: directory, runId: 'run' })).owner?.state).toBe(
      'dead',
    );
    kill.mockClear();
    expect(supervisor.forceKill()).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    const next = await lockRun(directory, 'run');
    await next();
  });

  it('never signals a reused PID and permits recovery without stopping the unrelated process', async () => {
    const lock = await lockRun(directory, 'run');
    const child = await childProcess();
    await lock.trackProcess(context, { ...child, osStartTime: 'earlier OS birth identity' });
    await abandon();
    expect(
      (await inspectRunOwnership({ stateDir: directory, runId: 'run' })).processes[0]?.state,
    ).toBe('reused');
    const kill = vi.spyOn(process, 'kill');
    const next = await lockRun(directory, 'run', { killOrphans: true, killGraceMs: 50 });
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(groupState(child)).toBe('alive');
    await next();
  });

  it('retains unconfirmed identity and malformed process records without sending signals', async () => {
    const lock = await lockRun(directory, 'run');
    const child = await childProcess();
    await lock.trackProcess(context, { ...child, osStartTime: null });
    await abandon();
    const path = join(directory, 'run', 'lock', 'processes', 'malformed.json');
    await fs.writeFile(path, '{bad');
    const kill = vi.spyOn(process, 'kill');
    await expect(
      lockRun(directory, 'run', { killOrphans: true, killGraceMs: 10 }),
    ).rejects.toBeInstanceOf(OrphanProcessesError);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    const result = await inspectRunOwnership({ stateDir: directory, runId: 'run' });
    expect(result.processes.map((entry) => entry.state)).toEqual(['unknown', 'unknown']);
    expect(await fs.readFile(path, 'utf8')).toBe('{bad');
    expect(await fs.readdir(join(directory, 'run', 'lock'))).not.toContain('recovery');
  });

  it('retains children on release and allows recovery while the original embedder is still alive', async () => {
    const lock = await lockRun(directory, 'run');
    const child = await childProcess();
    await lock.trackProcess(context, child);
    await expect(lock()).rejects.toBeInstanceOf(OrphanProcessesError);
    expect((await inspectRunOwnership({ stateDir: directory, runId: 'run' })).owner?.state).toBe(
      'released',
    );
    const next = await lockRun(directory, 'run', { killOrphans: true, killGraceMs: 10 });
    expect(groupState(child)).toBe('dead');
    await next();
  });

  it('treats registry write failure as infrastructure failure instead of retry or settled data', async () => {
    const binary = join(directory, 'fake');
    const executed = join(directory, 'executed');
    await fs.writeFile(
      binary,
      `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }\nprocess.stdin.on('data', () => require('node:fs').writeFileSync(${JSON.stringify(executed)}, 'unexpected')); setInterval(() => {}, 1000);`,
      { mode: 0o700 },
    );
    const original = actualFs.open;
    const opened = vi.spyOn(fs, 'open').mockImplementation((path, flags, mode) => {
      if (String(path).includes('/processes/'))
        return Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      return original(path, flags, mode);
    });
    let calls = 0;
    const native = new CliHarness({ claudeBinary: binary, killGraceMs: 30 });
    const workflow = defineWorkflow({
      name: 'registry-error',
      version: '1',
      input: z.null(),
      output: z.string(),
      run: async (ctx) => {
        const result = await ctx.claude.text('call', {
          prompt: 'task',
          retry: { maxAttempts: 3 },
          onError: 'return',
        });
        return result.ok ? result.value.output : 'incorrect fallback';
      },
    });
    let error: unknown;
    try {
      await runWorkflow(workflow, {
        runId: 'run',
        stateDir: directory,
        input: null,
        harness: {
          invoke: (request, invocation) => {
            calls++;
            return native.invoke(request, invocation);
          },
        },
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({
      name: 'WorkflowRunError',
      cause: expect.any(CheckpointError) as unknown,
    });
    expect((error as CheckpointError).message).toContain('disk full');
    expect(calls).toBe(1);
    expect(await fs.readFile(executed, 'utf8').catch(() => null)).toBeNull();
    expect((await readRun({ stateDir: directory, runId: 'run' })).steps['call']?.status).not.toBe(
      'settled-failed',
    );
    opened.mockRestore();
  });
});

it('reports incomplete and remote ownership without claiming local child identities', async () => {
  const lockPath = join(directory, 'run', 'lock');
  await fs.mkdir(lockPath, { recursive: true });
  expect((await inspectRunOwnership({ stateDir: directory, runId: 'run' })).warning).toBeTruthy();
  await fs.writeFile(
    join(lockPath, 'owner.json'),
    JSON.stringify({ pid: process.pid, token: 'remote', host: `${hostname()}-remote` }),
  );
  expect((await inspectRunOwnership({ stateDir: directory, runId: 'run' })).owner?.state).toBe(
    'remote',
  );
});
