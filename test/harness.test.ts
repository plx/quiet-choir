import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CliHarness } from '../src/harnesses/cli.js';
import { parseClaude, parseCodex } from '../src/harnesses/protocol.js';
import type { HarnessRequest } from '../src/workflow/runtime/model.js';

const directories: string[] = [];
const signal = new AbortController().signal;
const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'hello',
  session_id: 'claude-session',
  usage: { input_tokens: 12, output_tokens: 3 },
  total_cost_usd: 0.01,
};
const codexSuccess = [
  { type: 'thread.started', thread_id: 'codex-thread' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'hello' } },
  { type: 'turn.completed', usage: { input_tokens: 13, output_tokens: 4 } },
];

function jsonl(events: readonly unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

async function fixture(script: string): Promise<{ directory: string; binary: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'quiet-choir-harness-test-'));
  directories.push(directory);
  const binary = join(directory, 'agent');
  await writeFile(binary, `#!${process.execPath}\n${script}\n`);
  await chmod(binary, 0o700);
  return { directory, binary };
}

function request(provider: 'claude' | 'codex', cwd = process.cwd()): HarnessRequest {
  return { provider, options: { prompt: 'hello' }, cwd, outputSchema: null };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Claude result protocol', () => {
  it('normalizes text, session and usage', () => {
    expect(parseClaude(JSON.stringify(success), false)).toEqual({
      text: 'hello',
      sessionId: 'claude-session',
      usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.01 },
    });
  });

  it('serializes structured output and accepts JSON null', () => {
    expect(
      parseClaude(JSON.stringify({ ...success, structured_output: { answer: 42 } }), true).text,
    ).toBe('{"answer":42}');
    expect(parseClaude(JSON.stringify({ ...success, structured_output: null }), true).text).toBe(
      'null',
    );
  });

  it('reports unavailable and invalid measurements as null', () => {
    expect(
      parseClaude(
        JSON.stringify({
          ...success,
          session_id: 2,
          usage: { input_tokens: -2, output_tokens: '3' },
          total_cost_usd: -1,
        }),
        false,
      ),
    ).toMatchObject({
      sessionId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
    });
    expect(
      parseClaude(JSON.stringify({ type: 'result', subtype: 'success', result: '' }), false).usage
        .inputTokens,
    ).toBeNull();
  });

  it.each([
    ['malformed', 'malformed JSON'],
    ['[]', 'non-object'],
    [JSON.stringify({ type: 'assistant' }), 'terminal result'],
    [
      JSON.stringify({ ...success, is_error: true, result: 'OAuth session expired' }),
      'OAuth session expired',
    ],
    [
      JSON.stringify({ ...success, subtype: 'error_max_turns', errors: ['maximum turns reached'] }),
      'maximum turns reached',
    ],
    [JSON.stringify({ type: 'result', subtype: 'error' }), 'agent failure'],
    [JSON.stringify({ ...success, result: 4 }), 'missing final text'],
  ])('rejects %s', (input, expected) => {
    expect(() => parseClaude(input, false)).toThrow(expected);
  });

  it('requires the structured output field when a schema was requested', () => {
    expect(() => parseClaude(JSON.stringify(success), true)).toThrow('structured_output');
  });
});

describe('Codex event protocol', () => {
  it('normalizes completed events and uses the last agent message', () => {
    expect(
      parseCodex(
        `\n${jsonl([{ type: 'item.completed', item: { type: 'agent_message', text: 'earlier' } }, ...codexSuccess])}\r\n`,
      ),
    ).toEqual({
      text: 'hello',
      sessionId: 'codex-thread',
      usage: { inputTokens: 13, outputTokens: 4, costUsd: null },
    });
  });

  it('ignores tool and future events and tolerates missing optional metadata', () => {
    expect(
      parseCodex(
        jsonl([
          { type: 'thread.started' },
          { type: 'future.event' },
          { type: 'item.completed' },
          { type: 'item.completed', item: { type: 'command_execution' } },
          { type: 'item.completed', item: { type: 'agent_message', text: '' } },
          { type: 'turn.completed' },
        ]),
      ),
    ).toEqual({
      text: '',
      sessionId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
    });
  });

  it.each([
    [[{ type: 'turn.failed', error: { message: 'quota exhausted' } }], 'quota exhausted'],
    [[...codexSuccess, { type: 'error', message: 'late failure' }], 'late failure'],
    [[{ type: 'error' }], 'agent failure'],
    [[{}], 'missing its type'],
    [[{ type: 'item.completed', item: { type: 'agent_message' } }], 'missing final text'],
    [[{ type: 'turn.started' }], 'without turn.completed'],
    [[{ type: 'turn.completed' }], 'without a final agent_message'],
  ])('rejects invalid event sequences', (events, expected) => {
    expect(() => parseCodex(jsonl(events))).toThrow(expected);
  });
});

describe('headless CLI adapter', () => {
  it('sends literal stdin without a shell and passes conservative Claude defaults', async () => {
    const { binary, directory } = await fixture(`const fs = require('node:fs');
      const prompt = fs.readFileSync(0, 'utf8');
      fs.writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), prompt }));
      console.log(${JSON.stringify(JSON.stringify(success))});`);
    const prompt = 'Do not execute: $(touch injected) `touch injected` $HOME "quoted"\nnext line';
    const harness = new CliHarness({ claudeBinary: binary });
    await expect(
      harness.invoke({ ...request('claude', directory), options: { prompt } }, signal),
    ).resolves.toMatchObject({ text: 'hello' });
    const invocation: unknown = JSON.parse(
      await readFile(join(directory, 'invocation.json'), 'utf8'),
    );
    expect(invocation).toEqual({
      prompt,
      args: [
        '--print',
        '--output-format',
        'json',
        '--permission-mode',
        'dontAsk',
        '--tools',
        '',
        '--max-turns',
        '3',
        '--max-budget-usd',
        '0.25',
        '--no-session-persistence',
      ],
    });
    await expect(stat(join(directory, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('passes explicitly enabled Claude tools, limits, model and schema', async () => {
    const { binary, directory } = await fixture(`const fs = require('node:fs');
      fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
      console.log(${JSON.stringify(JSON.stringify({ ...success, structured_output: { answer: 42 } }))});`);
    const schema = { type: 'object', properties: { answer: { type: 'number' } } };
    const result = await new CliHarness({ claudeBinary: binary }).invoke(
      {
        provider: 'claude',
        cwd: directory,
        outputSchema: schema,
        options: {
          prompt: 'answer',
          tools: ['Read', 'Glob'],
          allowedTools: ['Read'],
          maxTurns: 1,
          maxBudgetUsd: 0.1,
          model: 'test-model',
        },
      },
      signal,
    );
    expect(result.text).toBe('{"answer":42}');
    const args: unknown = JSON.parse(await readFile(join(directory, 'args.json'), 'utf8'));
    expect(args).toEqual(
      expect.arrayContaining([
        'Read,Glob',
        '--allowedTools',
        'Read',
        '--json-schema',
        JSON.stringify(schema),
        '--model',
        'test-model',
        '0.1',
        '1',
      ]),
    );
  });

  it('passes Codex defaults and parses a real JSONL subprocess', async () => {
    const { binary, directory } =
      await fixture(`const fs = require('node:fs'); fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
      console.log(${JSON.stringify(jsonl(codexSuccess))});`);
    await expect(
      new CliHarness({ codexBinary: binary }).invoke(request('codex', directory), signal),
    ).resolves.toMatchObject({ text: 'hello' });
    expect(JSON.parse(await readFile(join(directory, 'args.json'), 'utf8'))).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--config',
      'approval_policy="never"',
      '--ephemeral',
      '--color',
      'never',
      '-',
    ]);
  });

  it('writes a private Codex schema, passes options, and removes the schema afterward', async () => {
    const { binary, directory } =
      await fixture(`const fs = require('node:fs'); const args = process.argv.slice(2);
      const path = args[args.indexOf('--output-schema') + 1];
      fs.writeFileSync('invocation.json', JSON.stringify({ args, path, schema: JSON.parse(fs.readFileSync(path)), mode: fs.statSync(path).mode & 511 }));
      console.log(${JSON.stringify(jsonl(codexSuccess))});`);
    const schema = { type: 'object', properties: {} };
    await new CliHarness({ codexBinary: binary }).invoke(
      {
        provider: 'codex',
        cwd: directory,
        outputSchema: schema,
        options: {
          prompt: 'hello',
          sandbox: 'workspace-write',
          reasoningEffort: 'low',
          skipGitRepoCheck: true,
          model: 'test-model',
        },
      },
      signal,
    );
    const data = JSON.parse(await readFile(join(directory, 'invocation.json'), 'utf8')) as {
      args: string[];
      path: string;
      schema: unknown;
      mode: number;
    };
    expect(data.schema).toEqual(schema);
    expect(data.mode).toBe(0o600);
    expect(data.args).toEqual(
      expect.arrayContaining([
        'workspace-write',
        'model_reasoning_effort="low"',
        '--skip-git-repo-check',
        '--model',
        'test-model',
      ]),
    );
    await expect(stat(data.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes schema files even when a subprocess fails', async () => {
    const { binary, directory } =
      await fixture(`const fs = require('node:fs'); const args = process.argv.slice(2);
      fs.writeFileSync('schema-path', args[args.indexOf('--output-schema') + 1]); process.exit(9);`);
    await expect(
      new CliHarness({ codexBinary: binary }).invoke(
        { ...request('codex', directory), outputSchema: {} },
        signal,
      ),
    ).rejects.toThrow('code 9');
    await expect(
      stat(await readFile(join(directory, 'schema-path'), 'utf8')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports missing and non-executable binaries', async () => {
    await expect(
      new CliHarness({ claudeBinary: '/missing/quiet-choir-claude' }).invoke(
        request('claude'),
        signal,
      ),
    ).rejects.toThrow('Install the harness CLI');
    const { binary } = await fixture('');
    await chmod(binary, 0o600);
    await expect(
      new CliHarness({ codexBinary: binary }).invoke(request('codex'), signal),
    ).rejects.toThrow('Cannot start');
  });

  it.each([
    [
      "process.stderr.write('authentication needed'); process.exit(2)",
      'code 2: authentication needed',
    ],
    ["process.kill(process.pid, 'SIGTERM')", 'SIGTERM'],
    ["console.log('not JSON')", 'malformed JSON'],
    [
      `console.log(${JSON.stringify(JSON.stringify({ ...success, is_error: true }))})`,
      'Claude reported success',
    ],
  ])('rejects failed subprocesses and invalid protocols', async (script, expected) => {
    const { binary } = await fixture(script);
    await expect(
      new CliHarness({ claudeBinary: binary }).invoke(request('claude'), signal),
    ).rejects.toThrow(expected);
  });

  it('enforces the combined stdout and stderr byte limit', async () => {
    const { binary } = await fixture(
      "process.stdout.write('x'.repeat(40)); process.stderr.write('x'.repeat(40)); setInterval(() => {}, 1000)",
    );
    await expect(
      new CliHarness({ claudeBinary: binary, maxOutputBytes: 64 }).invoke(
        request('claude'),
        signal,
      ),
    ).rejects.toThrow('64-byte output limit');
  });

  it('kills a process that ignores SIGTERM after its deadline', async () => {
    const { binary } = await fixture(
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    );
    await expect(
      new CliHarness({ claudeBinary: binary, killGraceMs: 20 }).invoke(
        { ...request('claude'), options: { prompt: 'hi', timeoutMs: 150 } },
        signal,
      ),
    ).rejects.toThrow('150ms deadline');
  });

  it('cancels a running process and removes its descendants', async () => {
    const { binary, directory } =
      await fixture(`const fs = require('node:fs'); const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
      fs.writeFileSync('child-pid', String(descendant.pid)); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const invocation = new CliHarness({ claudeBinary: binary, killGraceMs: 20 }).invoke(
      request('claude', directory),
      controller.signal,
    );
    const assertion = expect(invocation).rejects.toThrow('cancelled');
    await expect.poll(async () => readFile(join(directory, 'child-pid'), 'utf8')).toMatch(/^\d+$/u);
    const pid = Number(await readFile(join(directory, 'child-pid'), 'utf8'));
    controller.abort();
    await assertion;
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  });

  it('rejects pre-cancelled invocations before starting a binary', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already stopped'));
    await expect(
      new CliHarness({ claudeBinary: '/missing/binary' }).invoke(
        request('claude'),
        controller.signal,
      ),
    ).rejects.toThrow('already stopped');
  });

  it('validates resource limits before execution', async () => {
    expect(() => new CliHarness({ maxOutputBytes: 0 })).toThrow('maxOutputBytes');
    expect(() => new CliHarness({ killGraceMs: Number.POSITIVE_INFINITY })).toThrow('killGraceMs');
    expect(() => new CliHarness({ killGraceMs: 2_147_483_648 })).toThrow('must not exceed');
    await expect(new CliHarness().invoke(request('claude', 'relative'), signal)).rejects.toThrow(
      'absolute path',
    );
    await expect(
      new CliHarness().invoke(
        { ...request('claude'), options: { prompt: '', timeoutMs: 0 } },
        signal,
      ),
    ).rejects.toThrow('timeoutMs');
    await expect(
      new CliHarness().invoke(
        { ...request('claude'), options: { prompt: '', timeoutMs: 2_147_483_648 } },
        signal,
      ),
    ).rejects.toThrow('must not exceed');
    await expect(
      new CliHarness().invoke(
        {
          provider: 'claude',
          cwd: process.cwd(),
          outputSchema: null,
          options: { prompt: '', maxTurns: 0 },
        },
        signal,
      ),
    ).rejects.toThrow('maxTurns');
    await expect(
      new CliHarness().invoke(
        {
          provider: 'claude',
          cwd: process.cwd(),
          outputSchema: null,
          options: { prompt: '', maxBudgetUsd: 0 },
        },
        signal,
      ),
    ).rejects.toThrow('maxBudgetUsd');
  });
});
