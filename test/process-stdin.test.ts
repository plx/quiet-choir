import { spawn } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defineWorkflow,
  ExecError,
  NodeProcessRunner,
  runWorkflow,
  z,
  type HarnessInvocation,
  type HarnessProcess,
  type ProcessRunner,
} from '../src/index.js';
import { groupMembersExited, processIdentity } from '../src/processes/identity.js';
import { runProcess, type ProcessRequest } from '../src/processes/run.js';

/**
 * When enabled, every spawned child's stdin fails each write with ENOTCONN, as macOS reports for a
 * write to a pipe socket whose child has gone, and counts the writes it saw.
 */
const failWrites = vi.hoisted(() => ({ enabled: false, writes: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const spawnWithFailingWrites = ((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    if (failWrites.enabled && child.stdin) {
      const fail = (callback: (error: Error) => void): void => {
        failWrites.writes++;
        callback(
          Object.assign(new Error('write ENOTCONN'), { code: 'ENOTCONN', syscall: 'write' }),
        );
      };
      Object.assign(child.stdin, {
        _write: (_chunk: unknown, _encoding: unknown, callback: (error: Error) => void) => {
          fail(callback);
        },
        _writev: (_chunks: unknown, callback: (error: Error) => void) => {
          fail(callback);
        },
      });
    }
    return child;
  }) as typeof actual.spawn;
  return { ...actual, spawn: spawnWithFailingWrites };
});

let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'choir-process-stdin-')));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const lease = { release: () => Promise.resolve() };

/** Resolve registration only after `ms`, so a short-lived child usually exits before its input. */
const delayed =
  (ms: number): NonNullable<ProcessRequest['trackProcess']> =>
  async () => {
    await delay(ms);
    return lease;
  };

/** Resolve registration only once the child has exited (gone or a zombie), never before. */
const afterExit: NonNullable<ProcessRequest['trackProcess']> = async (child) => {
  for (;;) {
    const identity = processIdentity(child.pid);
    if (!identity || identity.zombie) return lease;
    await delay(10);
  }
};

function request(source: string, overrides: Partial<ProcessRequest> = {}): ProcessRequest {
  return {
    binary: process.execPath,
    args: ['-e', source],
    cwd: directory,
    input: '',
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    killGraceMs: 200,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const bigInput = 'x'.repeat(8 * 1024 * 1024);

describe('a child that exits before its stdin is written', () => {
  it('never fails 200 concurrent fast runs, with or without input', async () => {
    // A shell that exits at once is the cheapest child that ignores stdin, so 200 of them do not
    // load the machine for other suites; registration delays of 0-95ms straddle its exit.
    const exitAtOnce: Partial<ProcessRequest> =
      process.platform === 'win32' ? {} : { binary: '/bin/sh', args: ['-c', 'exit 0'] };
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        runProcess(
          request('', {
            ...exitAtOnce,
            input: index % 2 === 0 ? '' : 'x'.repeat(4096),
            trackProcess: delayed((index % 20) * 5),
          }),
        ).then(
          (result) => ({ code: result.code, signal: result.signal, warnings: result.warnings }),
          (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
        ),
      ),
    );
    const failures = results.filter(
      (result) =>
        !('code' in result) ||
        result.code !== 0 ||
        result.signal !== null ||
        result.warnings.length > 0,
    );
    expect(failures).toEqual([]);
  }, 60_000);

  it('treats a stdin write that fails with ENOTCONN as benign, and writes nothing for empty input', async () => {
    failWrites.enabled = true;
    failWrites.writes = 0;
    try {
      // The child exits on stdin EOF without consuming input, so it is still alive when the write
      // fails (the stream is then destroyed, closing the pipe); its exit status decides.
      const exitOnEof =
        "process.stdin.on('close',()=>process.exit(Number(process.argv[1]))).resume()";
      for (const input of ['', 'x'.repeat(4096)])
        expect(
          await runProcess(
            request(exitOnEof, {
              args: ['-e', exitOnEof, input ? '3' : '0'],
              input,
              trackProcess: () => Promise.resolve(lease),
            }),
          ),
        ).toMatchObject({ code: input ? 3 : 0, signal: null, warnings: [] });
      expect(failWrites.writes).toBe(1);
    } finally {
      failWrites.enabled = false;
    }
  });

  it.each([
    ['empty', ''],
    ['non-empty', 'x'.repeat(4096)],
  ])(
    'succeeds when registration resolves after the child exited, with %s input',
    async (_, input) => {
      const result = await runProcess(request('', { input, trackProcess: afterExit }));
      expect(result).toMatchObject({ code: 0, signal: null, warnings: [] });
    },
  );

  it('reports a child that exits 3 without reading a large input by its exit status', async () => {
    const result = await runProcess(
      request('process.exit(3)', { input: bigInput, trackProcess: delayed(200) }),
    );
    expect(result).toMatchObject({ code: 3, signal: null, warnings: [] });
  });

  it('keeps that exit status through NodeProcessRunner and ctx.exec', async () => {
    // Registration (a checkpoint save) is slowed so the child exits before its input is written.
    const native = new NodeProcessRunner();
    const slow: ProcessRunner = {
      run: (runRequest, invocation) =>
        native.run(
          runRequest,
          Object.assign(Object.create(invocation) as HarnessInvocation, {
            trackProcess: async (child: HarnessProcess) => {
              await delay(200);
              return invocation.trackProcess(child);
            },
          }),
        ),
    };
    const direct = await native.run(
      {
        command: [process.execPath, '-e', 'process.exit(3)'],
        cwd: directory,
        env: {},
        inheritEnv: true,
        input: bigInput,
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
        capture: 'truncate',
        schema: null,
      },
      {
        signal: new AbortController().signal,
        runId: 'direct',
        stepId: 'exec',
        attempt: 1,
        trackProcess: delayed(200),
      },
    );
    expect(direct).toMatchObject({ code: 3, signal: null });

    const failure = await runWorkflow(
      defineWorkflow({
        name: 'stdin-exit',
        version: '1',
        input: z.null(),
        output: z.unknown(),
        run: (ctx) =>
          ctx.step('parent', {
            input: null,
            schema: z.unknown(),
            run: (context) =>
              context.exec([process.execPath, '-e', 'process.exit(3)'], { input: bigInput }),
          }),
      }),
      {
        cwd: directory,
        stateDir: join(directory, 'state'),
        runId: 'stdin-exit',
        input: null,
        processRunner: slow,
      },
    ).catch((error: unknown) => error);
    // The run fails with the step's ExecError as its cause: a non-zero exit, not a stdin failure.
    expect(failure).toMatchObject({ name: 'WorkflowRunError' });
    const exec = failure instanceof Error ? failure.cause : undefined;
    expect(exec).toBeInstanceOf(ExecError);
    expect(exec).toMatchObject({
      message: 'Command exited with 3.',
      kind: 'process',
      diagnostics: { code: 3, signal: null },
    });
  });

  it('delivers EOF for empty input only after registration resolves', async () => {
    const marker = join(directory, 'eof');
    let seenDuringHold: boolean | undefined;
    const result = await runProcess(
      request(
        `process.stdin.on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},''));process.stdin.resume();`,
        {
          trackProcess: async () => {
            await delay(200);
            seenDuringHold = existsSync(marker);
            return lease;
          },
        },
      ),
    );
    expect(seenDuringHold).toBe(false);
    expect(result).toMatchObject({ code: 0, warnings: [] });
    expect(existsSync(marker)).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('cleanup of a group that already exited', () => {
  it('groupMembersExited is true for an exited group and false for a live one', async () => {
    const exited = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
    await once(exited, 'exit');
    expect(exited.pid).toBeDefined();
    expect(groupMembersExited({ pid: exited.pid ?? 0, pgid: exited.pid ?? 0 })).toBe(true);

    const live = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      expect(live.pid).toBeDefined();
      expect(groupMembersExited({ pid: live.pid ?? 0, pgid: live.pid ?? 0 })).toBe(false);
      expect(groupMembersExited({ pid: live.pid ?? 0, pgid: null })).toBe(false);
    } finally {
      live.kill('SIGKILL');
    }
  });

  /** Fail the next group signal with EPERM, as macOS does for a group of unreaped zombies. */
  function failGroupSignal(before: (pgid: number) => void): { failed: () => number } {
    const original = process.kill.bind(process);
    let failed = 0;
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal !== 0 && failed === 0) {
        failed++;
        before(-pid);
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' });
      }
      return original(pid, signal);
    });
    return { failed: () => failed };
  }

  it('does not warn when signalling a group whose members have all exited fails with EPERM', async () => {
    const spy = failGroupSignal((pgid) => {
      // Kill the group and wait, synchronously, until its leader is a zombie: the event loop cannot
      // reap it before this signal attempt returns, which is the window macOS reports as EPERM.
      process.kill(-pgid, 'SIGKILL');
      while (processIdentity(pgid) && !processIdentity(pgid)?.zombie) {
        /* spin until the leader has exited */
      }
    });
    const error = await runProcess(
      request('setInterval(()=>{},1000)', {
        timeoutMs: 300,
        trackProcess: () => Promise.resolve(lease),
      }),
    ).catch((caught: unknown) => caught);
    expect(spy.failed()).toBe(1);
    expect(error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(error).not.toHaveProperty('processWarnings');
    expect(error).toHaveProperty('message', expect.not.stringContaining('Could not send'));
  });

  it('still warns when the EPERM group has a live member', async () => {
    const spy = failGroupSignal(() => undefined);
    const error = await runProcess(
      request('setInterval(()=>{},1000)', {
        timeoutMs: 300,
        trackProcess: () => Promise.resolve(lease),
      }),
    ).catch((caught: unknown) => caught);
    expect(spy.failed()).toBe(1);
    expect(error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(error).toHaveProperty(
      'processWarnings',
      expect.arrayContaining([`Could not send SIGTERM to ${process.execPath}: kill EPERM`]),
    );
  });
});
