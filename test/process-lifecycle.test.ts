import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProcess, type ProcessRequest } from '../src/harnesses/process.js';
import { groupState, processIdentity, signalProcess } from '../src/processes/identity.js';
import { CliHarness, ProcessSupervisor, RunInterruptedError } from '../src/index.js';
import { executionSignals, terminalError, writeAllSync } from '../src/cli/signals.js';

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
function request(
  code: string,
  overrides: Partial<ProcessRequest> = {},
  ...argv: string[]
): ProcessRequest {
  return {
    binary: process.execPath,
    args: ['-e', code, ...argv],
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
    expect(result.warnings).toContain('Reaping leftover process group after leader exit.');
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
      require('node:fs').writeFileSync(process.argv[1], String(child.pid));
      child.unref(); console.log('valid result'); process.exit(0);
    `,
        { drainMs: 120, killGraceMs: 500 },
        path,
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
      require('node:fs').writeFileSync(process.argv[1], String(child.pid));
      child.unref(); process.exit(0);
    `,
        { killGraceMs: 1, backstopMs: 200, drainMs: 1500 },
        path,
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
      require('node:fs').writeFileSync(process.argv[1], String(child.pid)); child.unref();
      process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
    `,
        { timeoutMs: 700, killGraceMs: 120, backstopMs: 180, drainMs: 9000 },
        path,
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
        `process.stdin.on('data', () => require('node:fs').writeFileSync(process.argv[1], 'received')); process.stdin.on('end', () => process.exit(0));`,
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
        path,
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
          `process.stdin.on('data', () => require('node:fs').writeFileSync(process.argv[1], 'unsafe')); setInterval(() => {}, 1000);`,
          {
            input: 'task',
            trackProcess: (child) => {
              pid = child.pid;
              return Promise.reject(error);
            },
          },
          path,
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
        `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);`,
        path,
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
      // The first signal marks a resumable interruption rather than a deliberate cancel.
      expect(handler.signal.reason).toBeInstanceOf(RunInterruptedError);
      expect((handler.signal.reason as Error).message).toBe(`Workflow interrupted by ${name}.`);
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

const errno = (code: string): Error => Object.assign(new Error(code), { code });

/** A scripted write: each entry is a byte count to accept, 'drain' for everything left, or an error. */
function scriptedWrite(...script: (number | 'drain' | Error)[]): {
  readonly write: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  readonly received: Buffer[];
  readonly calls: () => number;
} {
  const received: Buffer[] = [];
  let calls = 0;
  return {
    received,
    calls: () => calls,
    write(fd, buffer, offset, length) {
      expect(fd).toBe(1);
      const step = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (step instanceof Error) throw step;
      const count = step === 'drain' ? length : Math.min(step ?? length, length);
      received.push(buffer.subarray(offset, offset + count));
      return count;
    },
  };
}

describe('writeAllSync', () => {
  it('advances by each short count and writes every byte in order', () => {
    const text = 'abcdefghij';
    const { write, received } = scriptedWrite(3, 1, 'drain');
    const sleeps: number[] = [];
    expect(writeAllSync(1, text, { write, sleep: (ms) => sleeps.push(ms) })).toBe('complete');
    expect(received.map((chunk) => chunk.length)).toEqual([3, 1, 6]);
    expect(Buffer.concat(received).toString('utf8')).toBe(text);
    expect(sleeps).toEqual([]);
  });

  it('retries a thrown EAGAIN and a zero-byte write after a sleep', () => {
    const { write, received, calls } = scriptedWrite(errno('EAGAIN'), errno('EAGAIN'), 0, 'drain');
    const sleeps: number[] = [];
    expect(writeAllSync(1, 'payload', { write, sleep: (ms) => sleeps.push(ms) })).toBe('complete');
    expect(calls()).toBe(4);
    expect(sleeps).toHaveLength(3);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
    expect(Buffer.concat(received).toString('utf8')).toBe('payload');
  });

  it('accepts EWOULDBLOCK as no progress too', () => {
    const { write } = scriptedWrite(errno('EWOULDBLOCK'), 'drain');
    expect(writeAllSync(1, 'x', { write, sleep: () => undefined })).toBe('complete');
  });

  it('returns timeout without throwing once a persistent EAGAIN outlasts the deadline', () => {
    const { write, calls } = scriptedWrite(errno('EAGAIN'));
    let clock = 0;
    const outcome = writeAllSync(1, 'stuck', {
      write,
      sleep: (ms) => {
        clock += ms;
      },
      now: () => clock,
      timeoutMs: 50,
    });
    expect(outcome).toBe('timeout');
    const attempts = calls();
    expect(attempts).toBeGreaterThan(1);
    // The deadline is a bound on retries: it stops calling write once it has passed.
    expect(clock).toBeGreaterThanOrEqual(50);
    expect(attempts).toBeLessThanOrEqual(50);
  });

  it('bounds a reader that accepts one byte at a time, not only a fully stalled one', () => {
    let clock = 0;
    const outcome = writeAllSync(1, 'a'.repeat(1000), {
      write: () => {
        clock += 10;
        return 1;
      },
      now: () => clock,
      timeoutMs: 100,
    });
    expect(outcome).toBe('timeout');
  });

  it('reports closed for EPIPE and EIO and rethrows anything else', () => {
    for (const code of ['EPIPE', 'EIO']) {
      const { write } = scriptedWrite(2, errno(code));
      expect(writeAllSync(1, 'abcd', { write })).toBe('closed');
    }
    const failure = errno('EACCES');
    expect(() => writeAllSync(1, 'abcd', { write: scriptedWrite(failure).write })).toThrow(failure);
  });

  it('reproduces multibyte text exactly through one-byte writes', () => {
    const text = '\u00e9\u{1f600}'.repeat(50);
    const { write, received } = scriptedWrite(1);
    expect(writeAllSync(1, text, { write })).toBe('complete');
    expect(Buffer.concat(received).equals(Buffer.from(text, 'utf8'))).toBe(true);
  });

  it('completes an empty document without writing', () => {
    const { write, calls } = scriptedWrite(1);
    expect(writeAllSync(1, '', { write })).toBe('complete');
    expect(calls()).toBe(0);
  });
});

describe('executionSignals second signal', () => {
  function force(onForce: () => void): { order: string[]; exits: unknown[] } {
    const order: string[] = [];
    const exits: unknown[] = [];
    const supervisor = new ProcessSupervisor();
    const forceKill = vi.spyOn(supervisor, 'forceKill').mockImplementation(() => {
      order.push('forceKill');
      return [];
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      order.push('exit');
      exits.push(code);
      return undefined as never;
    }) as typeof process.exit);
    const handler = executionSignals(
      supervisor,
      () => undefined,
      'Workflow',
      () => {
        order.push('onForce');
        onForce();
      },
    );
    try {
      process.emit('SIGINT');
      expect(order).toEqual([]);
      // The mocked exit returns, so the listener falls through to abort; the real one never does.
      try {
        process.emit('SIGINT');
      } catch (error) {
        order.push(`threw:${(error as Error).message}`);
      }
    } finally {
      handler.dispose();
      exit.mockRestore();
      forceKill.mockRestore();
    }
    return { order, exits };
  }

  it('kills groups, then writes the document, then exits 130', () => {
    const { order, exits } = force(() => undefined);
    expect(order.slice(0, 3)).toEqual(['forceKill', 'onForce', 'exit']);
    expect(exits).toEqual([130]);
  });

  it('still exits 130 when writing the document throws', () => {
    const { order, exits } = force(() => {
      throw errno('EAGAIN');
    });
    expect(order.slice(0, 3)).toEqual(['forceKill', 'onForce', 'exit']);
    expect(exits).toEqual([130]);
  });
});
