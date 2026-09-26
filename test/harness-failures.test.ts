import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CliHarness, HarnessError, defineWorkflow, readRun, runWorkflow, z } from '../src/index.js';
import type { HarnessRequest } from '../src/index.js';
import { parseCodex } from '../src/harnesses/protocol.js';

const directories: string[] = [];
const signal = new AbortController().signal;
const captureSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  version: z.string(),
  code: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  structured: z.boolean(),
  expected: z.object({
    reason: z.string(),
    terminalReason: z.string().nullable(),
    apiStatus: z.number().nullable(),
  }),
});
const fixtureDirectory = new URL('./fixtures/harness/', import.meta.url);
const captures = await Promise.all(
  (await readdir(fixtureDirectory))
    .filter((name) => name.endsWith('.json'))
    .map(async (name) => ({
      name,
      ...captureSchema.parse(JSON.parse(await readFile(new URL(name, fixtureDirectory), 'utf8'))),
    })),
);

async function binaryFor(
  stdout: string,
  stderr = '',
  code = 1,
): Promise<{ directory: string; binary: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'quiet-choir-failures-'));
  directories.push(directory);
  const binary = join(directory, 'agent');
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${String(code)};`,
  );
  await chmod(binary, 0o700);
  return { directory, binary };
}

function request(provider: 'claude' | 'codex'): HarnessRequest {
  return { provider, options: { prompt: 'fixture' }, outputSchema: null, cwd: process.cwd() };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('captured exit-1 failures', () => {
  it.each(captures)(
    'persists diagnostics and attempt usage from $name ($version)',
    async (capture) => {
      const { directory, binary } = await binaryFor(capture.stdout, capture.stderr, capture.code);
      const harness = new CliHarness({ claudeBinary: binary, codexBinary: binary });
      const definition = defineWorkflow({
        name: 'failure-capture',
        version: '1',
        input: z.null(),
        output: z.string(),
        async run(ctx) {
          const client = ctx[capture.provider];
          if (capture.structured)
            return (
              await client.object('agent', {
                prompt: 'fixture',
                schema: z.object({ answer: z.string() }),
              })
            ).output.answer;
          return (await client.text('agent', { prompt: 'fixture' })).output;
        },
      });
      const options = { runId: 'capture', stateDir: directory, input: null, harness };
      for (const resume of [false, true]) {
        const error: unknown = await runWorkflow(definition, { ...options, resume }).catch(
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(HarnessError);
        if (!(error instanceof HarnessError)) throw new Error('Expected HarnessError');
        expect(error.message).toContain(capture.expected.reason);
        expect(error.message).toContain('[exit code 1]');
        expect(error.exit).toEqual({ code: 1, signal: null });
        expect(error.failure).toMatchObject({
          terminalReason: capture.expected.terminalReason,
          apiStatus: capture.expected.apiStatus,
        });
        if (capture.expected.terminalReason)
          expect(error.message).toContain(capture.expected.terminalReason);
        if (capture.expected.apiStatus)
          expect(error.message).toContain(`HTTP ${String(capture.expected.apiStatus)}`);
        expect(error.failure?.reason).not.toMatch(/^Reconnecting/u);
        expect(error.stderrTail).toBe(capture.stderr.trim());
        const saved = await readRun(directory, 'capture');
        expect(saved.steps['agent']?.error).toBe(error.message);
        expect(saved.steps['agent']?.failedAttempts).toHaveLength(resume ? 2 : 1);
        expect(saved.steps['agent']?.failedAttempts?.at(-1)).toEqual({
          attempt: resume ? 2 : 1,
          sessionId: error.sessionId,
          usage: error.usage,
        });
        if (capture.provider === 'claude') {
          const raw = z
            .object({
              usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
              total_cost_usd: z.number(),
            })
            .parse(JSON.parse(capture.stdout));
          expect(error.usage).toEqual({
            inputTokens: raw.usage.input_tokens,
            outputTokens: raw.usage.output_tokens,
            costUsd: raw.total_cost_usd,
          });
        } else expect(error.usage).toBeNull();
      }
      const completed = await runWorkflow(definition, {
        ...options,
        resume: true,
        harness: {
          invoke() {
            return Promise.resolve({
              text: capture.structured ? '{"answer":"recovered"}' : 'recovered',
              sessionId: null,
              usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
            });
          },
        },
      });
      expect(completed.output).toBe('recovered');
      expect(completed.steps['agent']?.failedAttempts).toHaveLength(2);
    },
  );
});

it('prefers terminal failure text over unrelated stderr and bounds diagnostic tails', async () => {
  const { binary } = await binaryFor(
    JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      errors: ['turn limit'],
      is_error: true,
    }),
    'irrelevant MCP log '.repeat(1000),
  );
  const error: unknown = await new CliHarness({ claudeBinary: binary })
    .invoke(request('claude'), signal)
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(HarnessError);
  if (!(error instanceof HarnessError)) throw new Error('Expected HarnessError');
  expect(error.message).toMatch(/^claude error_max_turns: turn limit \[exit code 1\]; stderr:/u);
  expect(error.stderrTail).toHaveLength(1024);
  expect(error.stdoutTail).toBe('');
});

it.each(['', 'not-json'.repeat(1000)])(
  'reports an unusable stdout protocol with both bounded tails',
  async (stdout) => {
    const { binary } = await binaryFor(stdout, 'stderr'.repeat(1000), 9);
    const error: unknown = await new CliHarness({ codexBinary: binary })
      .invoke(request('codex'), signal)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HarnessError);
    if (!(error instanceof HarnessError)) throw new Error('Expected HarnessError');
    expect(error.exit.code).toBe(9);
    expect(error.message).toContain('exit code 9');
    expect(error.failure).toBeNull();
    expect(error.usage).toBeNull();
    expect(error.stderrTail).toHaveLength(1024);
    expect(error.stdoutTail).toBe(stdout.slice(-1024));
  },
);

it.each([0, 1])('fails a protocol error on exit %s without quoting plain text', async (code) => {
  const { binary } = await binaryFor(
    '{"type":"result","subtype":"success","is_error":true,"result":"auth expired"}',
    '',
    code,
  );
  await expect(
    new CliHarness({ claudeBinary: binary }).invoke(request('claude'), signal),
  ).rejects.toThrow(`claude success: auth expired [exit code ${String(code)}]`);
});

it('retains usage when a success envelope is followed by a nonzero exit', async () => {
  const { binary } = await binaryFor(
    '{"type":"result","subtype":"success","result":"done","session_id":"session","usage":{"input_tokens":4,"output_tokens":2},"total_cost_usd":0.01}',
  );
  await expect(
    new CliHarness({ claudeBinary: binary }).invoke(request('claude'), signal),
  ).rejects.toMatchObject({
    name: 'HarnessError',
    exit: { code: 1, signal: null },
    failure: null,
    sessionId: 'session',
    usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.01 },
  });
});

it('prefers turn.failed and unwraps nested API errors without trusting reconnect notices', () => {
  expect(
    parseCodex(
      [
        { type: 'error', message: 'Reconnecting... 1/3' },
        {
          type: 'turn.failed',
          error: { message: JSON.stringify({ status: 429, error: { message: 'quota exceeded' } }) },
          usage: { input_tokens: 2, output_tokens: 1 },
        },
        { type: 'error', message: 'unrelated later notice' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    ),
  ).toMatchObject({
    kind: 'failure',
    failure: {
      reason: 'quota exceeded',
      subtype: 'turn.failed',
      apiStatus: 429,
      usage: { inputTokens: 2, outputTokens: 1, costUsd: null },
    },
  });
  expect(parseCodex('{"type":"error","message":"Reconnecting... 1/3"}')).toMatchObject({
    kind: 'failure',
    failure: { reason: 'Codex output ended without a successful terminal turn.' },
  });
});
