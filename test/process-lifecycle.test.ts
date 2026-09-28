import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProcess, type ProcessRequest } from '../src/harnesses/process.js';
import { groupState, processIdentity, signalProcess } from '../src/processes/identity.js';
import { CliHarness, ProcessSupervisor } from '../src/index.js';
import { executionSignals, terminalError } from '../src/cli/signals.js';

let directory: string;
const leftovers = new Map<number, string | null>();
function remember(pid: number): void {
  leftovers.set(pid, processIdentity(pid)?.start ?? null);
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'quiet-choir-process-'));
});
afterEach(async () => {
  for (const [pid, start] of leftovers) {
    if (!start || processIdentity(pid)?.start !== start) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  leftovers.clear();
  await rm(directory, { recursive: true, force: true });
});
function request(code: string, overrides: Partial<ProcessRequest> = {}): ProcessRequest {
  return {
    binary: process.execPath,
    args: ['-e', code],
    cwd: directory,
    input: '',
    timeoutMs: 3000,
    maxOutputBytes: 8192,
    killGraceMs: 150,
    drainMs: 500,
    backstopMs: 200,
    signal: new AbortController().signal,
    ...overrides,
  };
}
async function waitForFile(file: string): Promise<string> {
  for (let i = 0; i < 300; i++) {
    try {
      return await readFile(file, 'utf8');
    } catch {
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

describe.skipIf(process.platform === 'win32')('bounded POSIX process ownership', () => {
  it('succeeds within the drain period after a leader exits with inherited pipes and reaps leftovers', async () => {
    const start = performance.now();
    const result = await runProcess(
      request(
        `
      const child = require('node:child_process').spawn('/bin/sleep', ['30'], { stdio: ['ignore', 1, 2] });
      console.log(child.pid); child.unref(); process.exit(0);
    `,
        { drainMs: 1200 },
      ),
    );
    expect(result.code).toBe(0);
    expect(performance.now() - start).toBeLessThan(1200);
    const pid = Number(result.stdout.trim());
    expect(pid).toBeGreaterThan(1);
    expect(processIdentity(pid)?.zombie ?? groupState({ pid, pgid: null }) === 'dead').toBe(true);
    expect(result.warnings).toContain('Reaping leftover harness process group after leader exit.');
  });

  it('reaps same-group children even when their pipes were redirected away', async () => {
    const result = await runProcess(
      request(`
      const child = require('node:child_process').spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
      console.log(child.pid); child.unref(); process.exit(0);
    `),
    );
    expect(result.code).toBe(0);
    const pid = Number(result.stdout.trim());
    expect(processIdentity(pid)?.zombie ?? groupState({ pid, pgid: null }) === 'dead').toBe(true);
  });

  it('bounds successful output draining even when an escaped descendant holds stdout forever', async () => {
    const path = join(directory, 'escaped');
    const result = await runProcess(
      request(
        `
      const child = require('node:child_process').spawn('/bin/sleep', ['30'], { detached: true, stdio: ['ignore', 1, 2] });
      require('node:fs').writeFileSync(${JSON.stringify(path)}, String(child.pid));
      child.unref(); console.log('valid result'); process.exit(0);
    `,
        { drainMs: 120, killGraceMs: 500 },
      ),
    );
    const pid = Number(await readFile(path, 'utf8'));
    remember(pid);
    expect(result).toMatchObject({ code: 0, stdout: 'valid result\n' });
    expect(result.warnings.join(' ')).toContain('drain deadline');
    expect(groupState({ pid, pgid: pid })).toBe('alive');
  });

  it('keeps draining a reaped successful leader past a short grace and backstop', async () => {
    const path = join(directory, 'escaped');
    const started = performance.now();
    const result = await runProcess(
      request(
        `
      const child = require('node:child_process').spawn(process.execPath, ['-e', "setTimeout(() => console.log('late line'), 600)"], { detached: true, stdio: ['ignore', 1, 2] });
      require('node:fs').writeFileSync(${JSON.stringify(path)}, String(child.pid));
      child.unref(); process.exit(0);
    `,
        { killGraceMs: 1, backstopMs: 200, drainMs: 1500 },
      ),
    );
    remember(Number(await readFile(path, 'utf8')));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('late line');
    expect(result.warnings.join(' ')).not.toContain('backstop');
    expect(performance.now() - started).toBeLessThan(1500 + 700);
  });

  it('force-settles a timeout despite permanently inherited pipes in another group', async () => {
    const path = join(directory, 'escaped');
    const started = performance.now();
    const work = runProcess(
      request(
        `
      const child = require('node:child_process').spawn('/bin/sleep', ['30'], { detached: true, stdio: ['ignore', 1, 2] });
      require('node:fs').writeFileSync(${JSON.stringify(path)}, String(child.pid)); child.unref();
      process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
    `,
        { timeoutMs: 700, killGraceMs: 120, backstopMs: 180, drainMs: 9000 },
      ),
    );
    // Install the rejection assertion before waiting for fixture readiness.
    const assertion = expect(work).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    remember(Number(await waitForFile(path)));
    await assertion;
    expect(performance.now() - started).toBeLessThan(1600);
  });

  it('holds input until registration finishes and releases only after child reaping', async () => {
    const path = join(directory, 'stdin');
    let registered = false;
    let released = false;
    await runProcess(
      request(
        `process.stdin.on('data', () => require('node:fs').writeFileSync(${JSON.stringify(path)}, 'received')); process.stdin.on('end', () => process.exit(0));`,
        {
          input: 'secret task',
          trackProcess: async (child) => {
            expect(await readFile(path, 'utf8').catch(() => null)).toBeNull();
            await delay(80);
            expect(await readFile(path, 'utf8').catch(() => null)).toBeNull();
            registered = true;
            return {
              release: () => {
                expect(registered).toBe(true);
                expect(groupState(child)).toBe('dead');
                released = true;
                return Promise.resolve();
              },
            };
          },
        },
      ),
    );
    expect(await readFile(path, 'utf8')).toBe('received');
    expect(released).toBe(true);
  });

  it('kills a spawned child and rejects failed registration without sending input', async () => {
    const path = join(directory, 'input');
    let pid = 0;
    const error = new Error('registry unavailable');
    await expect(
      runProcess(
        request(
          `process.stdin.on('data', () => require('node:fs').writeFileSync(${JSON.stringify(path)}, 'unsafe')); setInterval(() => {}, 1000);`,
          {
            input: 'task',
            trackProcess: (child) => {
              pid = child.pid;
              return Promise.reject(error);
            },
          },
        ),
      ),
    ).rejects.toBe(error);
    expect(groupState({ pid, pgid: pid })).toBe('dead');
    expect(await readFile(path, 'utf8').catch(() => null)).toBeNull();
  });

  it('preserves a completed result with a cleanup warning when record removal fails', async () => {
    const result = await runProcess(
      request(`console.log('result')`, {
        trackProcess: () =>
          Promise.resolve({ release: () => Promise.reject(new Error('record removal failed')) }),
      }),
    );
    expect(result.stdout).toBe('result\n');
    expect(result.warnings.join(' ')).toContain('record removal failed');
  });

  it('escalates when a live child ignores SIGTERM and synchronously kills through a supervisor', async () => {
    const path = join(directory, 'ready');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(path)}, 'ready'); setInterval(() => {}, 1000);`,
      ],
      { detached: true, stdio: 'ignore' },
    );
    const pid = child.pid;
    if (!pid) throw new Error('No fixture PID');
    remember(pid);
    await waitForFile(path);
    const supervisor = new ProcessSupervisor();
    const descriptor = {
      pid,
      pgid: pid,
      binary: process.execPath,
      cwd: directory,
      startedAt: new Date().toISOString(),
      osStartTime: processIdentity(pid)?.start ?? null,
    };
    const forgetReused = supervisor.track({ ...descriptor, osStartTime: 'earlier birth identity' });
    expect(supervisor.forceKill()).toEqual([]);
    expect(groupState(descriptor)).toBe('alive');
    forgetReused();
    const forget = supervisor.track(descriptor);
    signalProcess({ pid, pgid: pid }, 'SIGTERM');
    expect(groupState({ pid, pgid: pid })).toBe('alive');
    const exit = once(child, 'exit');
    expect(supervisor.forceKill()).toEqual([]);
    await exit;
    expect(groupState({ pid, pgid: pid })).toBe('dead');
    forget();
    expect(supervisor.forceKill()).toEqual([]);
  });
});

it('defaults to a three-second native kill grace', () => {
  expect(new CliHarness().policyDefaults('claude').killGraceMs).toBe(3000);
});
it('treats SIGINT, SIGTERM, and SIGHUP equally and removes all owned listeners', () => {
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const before = process.listenerCount(name);
    const logs: string[] = [];
    const handler = executionSignals(new ProcessSupervisor(), (message) => {
      logs.push(message);
    });
    try {
      process.emit(name);
      expect(handler.signal.aborted).toBe(true);
      expect(logs[0]).toContain('Send again to force');
    } finally {
      handler.dispose();
    }
    expect(process.listenerCount(name)).toBe(before);
  }
});
it('recognizes only dead-terminal EIO/EPIPE errors', () => {
  expect(terminalError(Object.assign(new Error(), { code: 'EPIPE' }))).toBe(true);
  expect(terminalError(Object.assign(new Error(), { code: 'EIO' }))).toBe(true);
  expect(terminalError(Object.assign(new Error(), { code: 'EACCES' }))).toBe(false);
  expect(terminalError('EPIPE')).toBe(false);
});
