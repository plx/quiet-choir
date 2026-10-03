import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runProcess, type ProcessRequest } from '../src/processes/run.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'choir-process-stream-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function request(source: string): Promise<ProcessRequest> {
  const file = join(directory, 'child.cjs');
  await writeFile(file, source);
  return {
    binary: process.execPath,
    args: [file],
    cwd: directory,
    input: 'go',
    timeoutMs: 5000,
    maxOutputBytes: 128,
    killGraceMs: 100,
    signal: new AbortController().signal,
  };
}

it('streams output above the old trace cap with per-pipe backpressure and a bounded stderr tail', async () => {
  const config = await request(`
const {once}=require('node:events');
process.stdin.resume();process.stdin.on('end',async()=>{
 for(let i=0;i<160;i++) if(!process.stdout.write('x'.repeat(65536))) await once(process.stdout,'drain');
 process.stderr.write('e'.repeat(100000)+'TAIL');
});`);
  let bytes = 0,
    active = 0,
    maximum = 0;
  const result = await runProcess({
    ...config,
    stream: {
      maxBytes: 12 * 1024 * 1024,
      stdout: async (chunk) => {
        active++;
        maximum = Math.max(maximum, active);
        await delay(1);
        bytes += chunk.byteLength;
        active--;
      },
      stderr: () => undefined,
    },
  });
  expect(result.code).toBe(0);
  expect(bytes).toBe(160 * 65536);
  expect(maximum).toBe(1);
  expect(result.stdout).toBe('');
  expect(Buffer.byteLength(result.stderr)).toBe(65536);
  expect(result.stderr.endsWith('TAIL')).toBe(true);
  expect(result.truncated).toBe(false);
});

it('terminates a producer when the total stream cap is exceeded', async () => {
  const config = await request(
    `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('x'.repeat(65536));setInterval(()=>{},1000);});`,
  );
  await expect(
    runProcess({
      ...config,
      stream: { maxBytes: 1024, stdout: () => undefined, stderr: () => undefined },
    }),
  ).rejects.toMatchObject({
    code: 'QUIET_CHOIR_OUTPUT_LIMIT',
    message: expect.stringContaining('maxStreamBytes') as unknown,
  });
});

it('preserves a failed asynchronous consumer and reaps its producer', async () => {
  const config = await request(
    `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('session\\n');setInterval(()=>{},1000);});`,
  );
  const failure = new Error('Durable session callback failed');
  await expect(
    runProcess({
      ...config,
      stream: {
        maxBytes: 1024,
        stdout: async () => {
          await delay(1);
          throw failure;
        },
        stderr: () => undefined,
      },
    }),
  ).rejects.toBe(failure);
  expect(failure).toHaveProperty('processResult.stdout', '');
});

it('delivers the first event while a producer is still running, before cancellation', async () => {
  const config = await request(
    `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('session\\n');setInterval(()=>{},1000);});`,
  );
  const controller = new AbortController();
  let first = '';
  await expect(
    runProcess({
      ...config,
      signal: controller.signal,
      stream: {
        maxBytes: 1024,
        stdout: (chunk) => {
          first += Buffer.from(chunk).toString('utf8');
          controller.abort('test interruption');
        },
        stderr: () => undefined,
      },
    }),
  ).rejects.toMatchObject({ code: 'ABORT_ERR' });
  expect(first).toBe('session\n');
});

it('bounds a stalled stream consumer after exit and keeps the ownership record', async () => {
  const config = await request(
    `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('event\\n');});`,
  );
  const release = vi.fn(() => Promise.resolve());
  const started = performance.now();
  const error: unknown = await runProcess({
    ...config,
    drainMs: 100,
    backstopMs: 100,
    trackProcess: () => Promise.resolve({ release }),
    stream: {
      maxBytes: 1024,
      stdout: () => new Promise<void>(() => undefined),
      stderr: () => undefined,
    },
  }).catch((error: unknown) => error);
  // Pipe drain, then the delivery deadline, then the settlement backstop.
  expect(performance.now() - started).toBeLessThan(2000);
  expect(error).toMatchObject({
    code: 'QUIET_CHOIR_CONSUMER_STALLED',
    message: expect.stringContaining('output consumer did not settle') as unknown,
  });
  expect(error).toHaveProperty('message', expect.stringContaining('ownership record was retained'));
  expect(release).not.toHaveBeenCalled();
});

const quietStream = { maxBytes: 1024 * 1024, stdout: () => undefined, stderr: () => undefined };

it('ends a silent child at idleTimeoutMs, well before its wall deadline', async () => {
  const config = await request(
    `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('init\\n');setInterval(()=>{},1000);});`,
  );
  const started = performance.now();
  await expect(
    runProcess({ ...config, idleTimeoutMs: 150, killGraceMs: 50, stream: quietStream }),
  ).rejects.toMatchObject({
    code: 'QUIET_CHOIR_IDLE_TIMEOUT',
    message: expect.stringContaining('produced no output for 150ms (idleTimeoutMs)') as unknown,
  });
  expect(performance.now() - started).toBeLessThan(config.timeoutMs);
});

it('never ends output that keeps streaming, however long the total time', async () => {
  const config = await request(`
process.stdin.resume();process.stdin.on('end',()=>{
 let n=0;const timer=setInterval(()=>{process.stdout.write('tick\\n');if(++n===30){clearInterval(timer);}},40);
});`);
  // About 1.2 s of output against a 400 ms idle window: three windows, ten times the cadence.
  // Child startup counts as idleness, so the window leaves room for a loaded machine.
  const result = await runProcess({ ...config, idleTimeoutMs: 400, stream: quietStream });
  expect(result.code).toBe(0);
});

it('does not count a slow consumer holding a chunk as child idleness', async () => {
  const config = await request(`
process.stdin.resume();process.stdin.on('end',()=>{
 let n=0;const timer=setInterval(()=>{process.stdout.write('tick\\n');if(++n===10){clearInterval(timer);}},20);
});`);
  let slow = 1;
  const result = await runProcess({
    ...config,
    idleTimeoutMs: 400,
    stream: {
      ...quietStream,
      // The first chunk is held for longer than the idle window while the child keeps writing.
      stdout: async () => {
        if (slow-- > 0) await delay(700);
      },
    },
  });
  expect(result.code).toBe(0);
  expect(slow).toBeLessThan(0);
});

it('clears the idle deadline once the leader exits, so a silent leftover is reaped normally', async () => {
  const config = await request(`
const {spawn}=require('node:child_process');
process.stdin.resume();process.stdin.on('end',()=>{
 spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setTimeout(()=>{},5000)"],{stdio:'inherit'});
 let n=0;const timer=setInterval(()=>{process.stdout.write('tick\\n');if(++n===5){clearInterval(timer);process.exit(0);}},20);
});`);
  // The leftover ignores SIGTERM and stays silent until SIGKILL, longer than the idle window.
  const result = await runProcess({
    ...config,
    idleTimeoutMs: 400,
    killGraceMs: 700,
    stream: quietStream,
  });
  expect(result.code).toBe(0);
  expect(result.warnings).toContain('Process cleanup escalated to SIGKILL.');
});
