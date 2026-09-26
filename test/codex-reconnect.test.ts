import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { CliHarness, defineWorkflow, readRun, runWorkflow, z } from '../src/index.js';
import { parseCodex } from '../src/harnesses/protocol.js';

const directories: string[] = [];
const jsonl = (events: readonly unknown[]): string =>
  events.map((event) => JSON.stringify(event)).join('\n');
const success = [
  { type: 'thread.started', thread_id: 'thread' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
  { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } },
];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'quiet-choir-reconnect-'));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

it('accepts notices before and after a successful terminal turn and exposes warnings', () => {
  expect(
    parseCodex(
      jsonl([
        { type: 'error', message: 'Reconnecting... 1/3' },
        ...success,
        { type: 'error', message: 'late notice' },
      ]),
    ),
  ).toEqual({
    kind: 'success',
    response: {
      text: 'done',
      sessionId: 'thread',
      usage: { inputTokens: 3, outputTokens: 1, costUsd: null },
      warnings: ['Reconnecting... 1/3', 'late notice'],
    },
  });
});

it('keeps terminal failures authoritative even after completion and includes retry history', () => {
  expect(
    parseCodex(
      jsonl([
        { type: 'error', message: 'Reconnecting... 1/3' },
        ...success,
        { type: 'turn.failed', error: { message: 'quota exhausted' } },
      ]),
    ),
  ).toMatchObject({
    kind: 'failure',
    failure: { subtype: 'turn.failed', reason: 'quota exhausted; notices: Reconnecting... 1/3' },
  });
  expect(
    parseCodex(
      jsonl([
        { type: 'error', message: 'first error' },
        { type: 'error', message: 'last error' },
      ]),
    ),
  ).toMatchObject({ kind: 'failure', failure: { reason: 'last error; notices: first error' } });
});

it('bounds warning count, warning lengths, and failure history', () => {
  const notices = Array.from({ length: 40 }, (_, i) => ({
    type: 'error',
    message: `${String(i)}: ${'x'.repeat(3000)}`,
  }));
  const result = parseCodex(jsonl([...notices, ...success]));
  expect(result.kind).toBe('success');
  if (result.kind !== 'success') throw new Error('Expected success');
  expect(result.response.warnings).toHaveLength(32);
  expect(result.response.warnings?.[0]).toMatch(/^8: /u);
  expect(result.response.warnings?.every((notice) => notice.length === 2048)).toBe(true);
  const failed = parseCodex(jsonl([...notices, { type: 'turn.failed', error: 'terminal reason' }]));
  expect(failed.kind).toBe('failure');
  if (failed.kind !== 'failure') throw new Error('Expected failure');
  expect(failed.failure.reason).toHaveLength('terminal reason; notices: '.length + 4096);
});

it('completes the captured reconnect turn, persists warnings, and replays without another process', async () => {
  const capture = z
    .object({
      stdout: z.string(),
      stderr: z.string(),
      code: z.number(),
      version: z.literal('0.157.1'),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL('./fixtures/harness/codex-reconnect-success.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  const stateDir = await directory();
  const binary = join(stateDir, 'codex');
  const calls = join(stateDir, 'calls');
  await writeFile(
    binary,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, 'call\\n'); process.stdout.write(${JSON.stringify(capture.stdout)}); process.stderr.write(${JSON.stringify(capture.stderr)}); process.exitCode = ${String(capture.code)};`,
  );
  await chmod(binary, 0o700);
  let fail = true;
  const workflow = defineWorkflow({
    name: 'reconnect',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const result = await ctx.codex.text('agent', { prompt: 'fixture' });
      await ctx.step('after', {
        input: null,
        schema: z.null(),
        run() {
          if (fail) throw new Error('later failure');
          return null;
        },
      });
      return result.output;
    },
  });
  const options = {
    runId: 'reconnect',
    stateDir,
    input: null,
    harness: new CliHarness({ codexBinary: binary }),
  };
  await expect(runWorkflow(workflow, options)).rejects.toThrow('later failure');
  const checkpoint = await readRun({ stateDir, runId: 'reconnect' });
  expect(checkpoint.steps['agent']?.status).toBe('completed');
  expect(checkpoint.steps['agent']?.warnings?.[0]).toMatch(/^Reconnecting/u);
  expect(checkpoint.steps['agent']?.output).not.toHaveProperty('warnings');
  fail = false;
  const result = await runWorkflow(workflow, { ...options, resume: true });
  expect(result.output).toBe('hello from fake codex');
  expect(result.steps['agent']?.warnings).toEqual(checkpoint.steps['agent']?.warnings);
  expect(await readFile(calls, 'utf8')).toBe('call\n');
});

it('replays an agent checkpoint captured before warnings were supported', async () => {
  const stateDir = await directory();
  await writeFile(
    join(stateDir, 'legacy.json'),
    await readFile(new URL('./fixtures/harness/legacy-agent-checkpoint.json', import.meta.url)),
  );
  const workflow = defineWorkflow({
    name: 'legacy-reconnect',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      return (await ctx.codex.text('agent', { prompt: 'fixture' })).output;
    },
  });
  const result = await runWorkflow(workflow, {
    runId: 'legacy',
    stateDir,
    cwd: '/fixture',
    resume: true,
    harness: {
      invoke() {
        throw new Error('must replay without invoking');
      },
    },
  });
  expect(result.output).toBe('legacy answer');
  expect(result.steps['agent']?.attempts).toBe(1);
  expect(result.steps['agent']?.warnings).toBeUndefined();
});
