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
