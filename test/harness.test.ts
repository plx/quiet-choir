import { testInvocation } from './harness-invocation.js';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliHarness } from '../src/harnesses/cli.js';
import { ConfigurationError } from '../src/workflow/runtime/configuration-error.js';
import { errorKind } from '../src/workflow/runtime/step-error.js';
import {
  parseClaude as classifyClaude,
  parseCodex as classifyCodex,
  type ProtocolOutcome,
} from '../src/harnesses/protocol.js';
import type { HarnessRequestInput } from '../src/workflow/runtime/model.js';
import { HarnessStream } from '../src/harnesses/stream.js';

// Existing success/malformed-shape checks exercise the classified parser result.
function response(outcome: ProtocolOutcome) {
  if (outcome.kind === 'success') return outcome.response;
  throw new Error(outcome.kind === 'failure' ? outcome.failure.reason : outcome.reason);
}
const parseClaude = (stdout: string, structured: boolean) =>
  response(classifyClaude(stdout, structured));
const parseCodex = (stdout: string) => response(classifyCodex(stdout));

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

function request(provider: 'claude' | 'codex', cwd = process.cwd()): HarnessRequestInput {
  return { harness: provider, options: { prompt: 'hello' }, cwd, outputSchema: null };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Claude result protocol', () => {
  it('normalizes text, session and usage', () => {
    expect(parseClaude(JSON.stringify(success), false)).toMatchObject({
      text: 'hello',
      sessionId: 'claude-session',
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: 0.01,
        reported: { usage: success.usage },
      },
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
    ).toMatchObject({
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
    ).toMatchObject({
      text: '',
      sessionId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
    });
  });

  it.each([
    [[{ type: 'turn.failed', error: { message: 'quota exhausted' } }], 'quota exhausted'],
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
      harness.invoke(
        { ...request('claude', directory), options: { prompt } },
        testInvocation(signal),
      ),
    ).resolves.toMatchObject({ text: 'hello' });
    const invocation: unknown = JSON.parse(
      await readFile(join(directory, 'invocation.json'), 'utf8'),
    );
    expect(invocation).toEqual({
      prompt,
      args: [
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'dontAsk',
        '--tools',
        '',
        '--max-turns',
        '10',
        '--max-budget-usd',
        '0.5',
        '--no-session-persistence',
        '--restricted',
        '--strict-mcp-config',
      ],
    });
    await expect(stat(join(directory, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([true, false])(
    'passes Claude tools and explicit/inferred permissions (narrow=%s)',
    async (narrow) => {
      const { binary, directory } = await fixture(`const fs = require('node:fs');
      fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
      console.log(${JSON.stringify(JSON.stringify({ ...success, structured_output: { answer: 42 } }))});`);
      const schema = { type: 'object', properties: { answer: { type: 'number' } } };
      const result = await new CliHarness({ claudeBinary: binary }).invoke(
        {
          harness: 'claude',
          cwd: directory,
          outputSchema: schema,
          options: {
            prompt: 'answer',
            tools: ['Read', 'Glob'],
            ...(narrow ? { allowedTools: ['Read'] } : {}),
            maxTurns: 1,
            maxBudgetUsd: 0.1,
            model: 'test-model',
          },
        },
        testInvocation(signal),
      );
      expect(result.text).toBe('{"answer":42}');
      const args: unknown = JSON.parse(await readFile(join(directory, 'args.json'), 'utf8'));
      expect(args).toEqual(
        expect.arrayContaining([
          'Read,Glob',
          '--allowedTools',
          narrow ? 'Read' : 'Read,Glob',
          '--json-schema',
          JSON.stringify(schema),
          '--model',
          'test-model',
          '0.1',
          '1',
        ]),
      );
    },
  );

  it('passes Codex defaults and parses a real JSONL subprocess', async () => {
    const { binary, directory } =
      await fixture(`const fs = require('node:fs'); fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
      console.log(${JSON.stringify(jsonl(codexSuccess))});`);
    await expect(
      new CliHarness({ codexBinary: binary }).invoke(
        request('codex', directory),
        testInvocation(signal),
      ),
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
      '--ignore-user-config',
      '--ignore-rules',
      '--',
      '-',
    ]);
  });

  it('writes a private Codex schema, passes options, and removes the schema afterward', async () => {
    const { binary, directory } =
      await fixture(`const fs = require('node:fs'); const args = process.argv.slice(2);
      const path = args[args.indexOf('--output-schema') + 1];
      fs.writeFileSync('invocation.json', JSON.stringify({ args, path, schema: JSON.parse(fs.readFileSync(path)), mode: fs.statSync(path).mode & 511 }));
      console.log(${JSON.stringify(jsonl([{ type: 'item.completed', item: { type: 'agent_message', text: '{}' } }, { type: 'turn.completed' }]))});`);
    const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
    await new CliHarness({ codexBinary: binary }).invoke(
      {
        harness: 'codex',
        cwd: directory,
        outputSchema: schema,
        options: {
          prompt: 'hello',
          sandbox: 'workspace-write',
          effort: 'low',
          skipGitRepoCheck: true,
          model: 'test-model',
        },
      },
      testInvocation(signal),
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
        {
          ...request('codex', directory),
          outputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        testInvocation(signal),
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
        testInvocation(signal),
      ),
    ).rejects.toThrow('Check the executable, PATH');
    const { binary } = await fixture('');
    await chmod(binary, 0o600);
    const launch = new CliHarness({ codexBinary: binary }).invoke(
      request('codex'),
      testInvocation(signal),
    );
    await expect(launch).rejects.toThrow('Cannot start');
    const error: unknown = await launch.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EACCES', phase: 'spawn' });
    expect(errorKind(error)).toBe('process');
  });

  it.each([
    [
      "process.stderr.write('authentication needed'); process.exit(2)",
      'stderr: authentication needed',
    ],
    ["process.kill(process.pid, 'SIGTERM')", 'SIGTERM'],
    ["console.log('not JSON')", 'malformed JSON'],
    [
      `console.log(${JSON.stringify(JSON.stringify({ ...success, is_error: true }))}); process.exitCode = 1`,
      'claude error: hello [exit code 1]',
    ],
  ])('rejects failed subprocesses and invalid protocols', async (script, expected) => {
    const { binary } = await fixture(script);
    await expect(
      new CliHarness({ claudeBinary: binary }).invoke(request('claude'), testInvocation(signal)),
    ).rejects.toThrow(expected);
  });

  it('enforces the combined stdout and stderr byte limit', async () => {
    const { binary } = await fixture(
      "process.stdout.write('x'.repeat(40)); process.stderr.write('x'.repeat(40)); setInterval(() => {}, 1000)",
    );
    await expect(
      new CliHarness({ claudeBinary: binary, maxStreamBytes: 64 }).invoke(
        request('claude'),
        testInvocation(signal),
      ),
    ).rejects.toThrow('maxStreamBytes (64 bytes)');
  });

  it('kills a process that ignores SIGTERM after its deadline', async () => {
    const { binary } = await fixture(
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    );
    await expect(
      new CliHarness({ claudeBinary: binary, killGraceMs: 20 }).invoke(
        { ...request('claude'), options: { prompt: 'hi', timeoutMs: 150 } },
        testInvocation(signal),
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
      testInvocation(controller.signal),
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
        testInvocation(controller.signal),
      ),
    ).rejects.toThrow('already stopped');
  });

  it('validates resource limits before execution', async () => {
    expect(() => new CliHarness({ maxOutputBytes: 0 })).toThrow('maxOutputBytes');
    expect(() => new CliHarness({ killGraceMs: Number.POSITIVE_INFINITY })).toThrow('killGraceMs');
    expect(() => new CliHarness({ killGraceMs: 2_147_483_648 })).toThrow('must not exceed');
    await expect(
      new CliHarness().invoke(request('claude', 'relative'), testInvocation(signal)),
    ).rejects.toThrow('absolute path');
    await expect(
      new CliHarness().invoke(
        { ...request('claude'), options: { prompt: '', timeoutMs: 0 } },
        testInvocation(signal),
      ),
    ).rejects.toThrow('timeoutMs');
    await expect(
      new CliHarness().invoke(
        { ...request('claude'), options: { prompt: '', timeoutMs: 2_147_483_648 } },
        testInvocation(signal),
      ),
    ).rejects.toThrow('must not exceed');
    await expect(
      new CliHarness().invoke(
        {
          harness: 'claude',
          cwd: process.cwd(),
          outputSchema: null,
          options: { prompt: '', maxTurns: 0 },
        },
        testInvocation(signal),
      ),
    ).rejects.toThrow('maxTurns');
    await expect(
      new CliHarness().invoke(
        {
          harness: 'claude',
          cwd: process.cwd(),
          outputSchema: null,
          options: { prompt: '', maxBudgetUsd: 0 },
        },
        testInvocation(signal),
      ),
    ).rejects.toThrow('maxBudgetUsd');
  });

  it('signals pre-launch validation failures as configuration errors', async () => {
    const harness = new CliHarness({
      claudeBinary: '/missing/claude',
      codexBinary: '/missing/codex',
    });
    const tuple = { type: 'array', prefixItems: [{ type: 'string' }] };
    for (const invalid of [
      request('claude', 'relative'),
      { ...request('claude'), options: { prompt: '', timeoutMs: 0 } },
      { ...request('claude'), outputSchema: { type: 'array', items: { type: 'string' } } },
      { ...request('codex'), outputSchema: tuple },
      { ...request('claude'), options: { prompt: '', tools: ['Read'], allowedTools: ['Bash'] } },
    ]) {
      await expect(harness.invoke(invalid, testInvocation(signal))).rejects.toBeInstanceOf(
        ConfigurationError,
      );
    }
    // Launch failures after validation remain ordinary effect failures.
    await expect(
      harness.invoke(request('claude'), testInvocation(signal)),
    ).rejects.not.toBeInstanceOf(ConfigurationError);
  });
});

describe('HarnessStream tool-use count', () => {
  async function count(
    harness: 'claude' | 'codex',
    lines: readonly object[],
    structured = false,
  ): Promise<unknown> {
    const stream = new HarnessStream(harness, structured, 1024 * 1024, testInvocation());
    await stream.stdout(Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join('')));
    await stream.finish();
    return stream.diagnostics('')['toolUses'];
  }
  const block = (id: string, name = 'Read') => ({ type: 'tool_use', id, name, input: {} });
  const assistant = (...content: object[]) => ({ type: 'assistant', message: { content } });

  it('counts every Claude tool_use block once by ID, across messages', async () => {
    expect(await count('claude', [])).toBe(0);
    expect(
      await count('claude', [
        assistant({ type: 'text', text: 'two tools' }, block('a'), block('b', 'Grep')),
        assistant(block('a')),
        assistant(block('c', 'StructuredOutput')),
      ]),
    ).toBe(3);
  });

  it('excludes StructuredOutput only for a structured call', async () => {
    expect(await count('claude', [assistant(block('s', 'StructuredOutput'))], true)).toBe(0);
    expect(await count('claude', [assistant(block('s', 'StructuredOutput'))], false)).toBe(1);
  });

  it('counts each distinct Codex tool item once, on first sight', async () => {
    const item = (type: string, event: string, id?: string) => ({
      type: event,
      item: { ...(id === undefined ? {} : { id }), type, text: 'x' },
    });
    expect(
      await count('codex', [
        item('command_execution', 'item.started', 'i1'),
        item('command_execution', 'item.completed', 'i1'),
        item('file_change', 'item.completed', 'i2'),
        item('mcp_tool_call', 'item.started', 'i3'),
        item('web_search', 'item.completed', 'i4'),
        item('command_execution', 'item.started'),
        item('command_execution', 'item.completed'),
        item('agent_message', 'item.completed', 'i5'),
        item('reasoning', 'item.completed', 'i6'),
      ]),
    ).toBe(5);
  });
});

describe('HarnessStream progress summaries', () => {
  // The 100 ms progress throttle and the thinking collapse both read performance.now(); each line
  // is fed alone with the fake clock advanced past the throttle unless a test sets the gap.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function summaries(
    harness: 'claude' | 'codex',
    lines: readonly object[],
    { structured = false, gapMs = 200 }: { structured?: boolean; gapMs?: number } = {},
  ): Promise<string[]> {
    const seen: string[] = [];
    const stream = new HarnessStream(harness, structured, 1024 * 1024, {
      ...testInvocation(),
      onProgress: (event) => seen.push(event.summary),
    });
    for (const line of lines) {
      vi.advanceTimersByTime(gapMs);
      await stream.stdout(Buffer.from(`${JSON.stringify(line)}\n`));
    }
    await stream.finish();
    return seen;
  }
  const tool = (name: string, input: unknown, id = name) => ({
    type: 'tool_use',
    id,
    name,
    input,
  });
  const assistant = (...content: object[]) => ({ type: 'assistant', message: { content } });
  const claude = async (...content: object[]) =>
    (await summaries('claude', [assistant(...content)]))[0];

  it('names the Claude tool target from allowlisted input keys only', async () => {
    const longPath = `/work/${'deeply/nested/'.repeat(8)}src/harnesses/stream.ts`;
    const edit = await claude(
      tool('Edit', { file_path: longPath, old_string: 'SECRET-OLD', new_string: 'SECRET-NEW' }),
    );
    expect(edit).toMatch(/^Claude tool: Edit ….*\/src\/harnesses\/stream\.ts$/u);
    expect(Array.from((edit ?? '').slice('Claude tool: Edit '.length))).toHaveLength(80);
    expect(edit).not.toContain('SECRET');

    const command = `npm run check -- ${'--flag '.repeat(30)}`;
    const bash = await claude(tool('Bash', { command, description: 'Run the checks' }));
    expect(bash).toMatch(/^Claude tool: Bash npm run check -- --flag .*…$/u);
    expect(Array.from((bash ?? '').slice('Claude tool: Bash '.length))).toHaveLength(80);

    expect(await claude(tool('Bash', { command: 'git status\nrm -rf /tmp/x\tz' }))).toBe(
      'Claude tool: Bash git status',
    );
    expect(await claude(tool('Grep', { pattern: 'class\\s+Harness', path: 'src' }))).toBe(
      'Claude tool: Grep class\\s+Harness',
    );
    expect(await claude(tool('Write', { file_path: 'a.txt', content: 'SECRET-CONTENT' }))).toBe(
      'Claude tool: Write a.txt',
    );
    expect(await claude(tool('Write', { content: 'SECRET-CONTENT' }))).toBe('Claude tool: Write');
    expect(
      await claude(tool('mcp__db__query', { arguments: { token: 'SECRET' }, sql: 'SECRET' })),
    ).toBe('Claude tool: mcp__db__query');
    // MCP arguments never reach progress, even under a key a built-in tool's target comes from.
    for (const input of [
      { query: 'SELECT secret' },
      { command: 'SECRET command', file_path: '/SECRET/path', url: 'https://SECRET.example' },
    ])
      expect(await claude(tool('mcp__db__query', input))).toBe('Claude tool: mcp__db__query');
    expect(await claude(tool('WebSearch', { query: 'vitest fake timers' }))).toBe(
      'Claude tool: WebSearch vitest fake timers',
    );
    expect(await claude(tool('Read', { file_path: 'src/index.ts' }))).toBe(
      'Claude tool: Read src/index.ts',
    );
    expect(await claude(tool('Task', { prompt: 'SECRET prompt', description: 'Explore' }))).toBe(
      'Claude tool: Task Explore',
    );
  });

  it('strips URL credentials, queries and fragments', async () => {
    expect(
      await claude(
        tool('WebFetch', { url: 'https://user:pw@example.com/a/b?token=SECRET#frag', prompt: 'x' }),
      ),
    ).toBe('Claude tool: WebFetch https://example.com/a/b');
    expect(await claude(tool('WebFetch', { url: 'https://[bad' }))).toBe('Claude tool: WebFetch');
  });

  it('omits the StructuredOutput payload and counts further tool calls', async () => {
    expect(
      (
        await summaries('claude', [assistant(tool('StructuredOutput', { command: 'payload' }))], {
          structured: true,
        })
      )[0],
    ).toBe('Claude tool: StructuredOutput');
    expect(
      await claude(
        { type: 'text', text: 'two tools' },
        tool('Read', { file_path: 'README.md' }, 'a'),
        tool('Grep', { pattern: 'x' }, 'b'),
      ),
    ).toBe('Claude tool: Read README.md (+1 more)');
  });

  it('ignores malformed Claude inputs without failing the call', async () => {
    expect(await claude(tool('Bash', { command: 42, description: ['x'] }))).toBe(
      'Claude tool: Bash',
    );
    expect(await claude(tool('Bash', 'not an object'))).toBe('Claude tool: Bash');
    expect(await claude(tool('Bash', { command: ' \n ' }))).toBe('Claude tool: Bash');
  });

  it('names Codex command, file, MCP and search targets', async () => {
    const item = (type: string, fields: object) => ({
      type: 'item.started',
      item: { id: type, type, ...fields },
    });
    expect(
      await summaries('codex', [
        item('command_execution', { command: "/bin/zsh -lc 'git status'" }),
        item('command_execution', { command: ['bash', '-c', 'npm test'] }),
        item('command_execution', { command: 'ls -la' }),
        item('file_change', {
          changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'b.ts' }, { path: 'c.ts' }],
        }),
        item('file_change', { changes: [{ path: 'only.ts', diff: 'SECRET' }] }),
        item('mcp_tool_call', { server: 'github', tool: 'get_issue', arguments: { t: 'SECRET' } }),
        item('web_search', { query: 'vitest fake performance' }),
        item('reasoning', { text: 'SECRET' }),
      ]),
    ).toEqual([
      'Codex command_execution: item.started git status',
      'Codex command_execution: item.started npm test',
      'Codex command_execution: item.started ls -la',
      'Codex file_change: item.started src/a.ts (+2 more)',
      'Codex file_change: item.started only.ts',
      'Codex mcp_tool_call: item.started github/get_issue',
      'Codex web_search: item.started vitest fake performance',
      'Codex reasoning: item.started',
    ]);
  });

  it('keeps the Codex summary unchanged when no target field is usable', async () => {
    const item = (type: string, fields: object = {}) => ({
      type: 'item.completed',
      item: { type, ...fields },
    });
    expect(
      await summaries('codex', [
        item('command_execution'),
        item('command_execution', { command: 7 }),
        item('command_execution', { command: [{ argv: 'x' }] }),
        item('file_change', { changes: [{ diff: 'x' }, { path: 'b.ts' }] }),
        item('file_change', { changes: 'x' }),
        item('mcp_tool_call', { arguments: { t: 'SECRET' } }),
        item('web_search', { query: 5 }),
      ]),
    ).toEqual([
      'Codex command_execution: item.completed',
      'Codex command_execution: item.completed',
      'Codex command_execution: item.completed',
      'Codex file_change: item.completed',
      'Codex file_change: item.completed',
      'Codex mcp_tool_call: item.completed',
      'Codex web_search: item.completed',
    ]);
  });

  describe('thinking_tokens collapse', () => {
    const thinking = (estimated?: number) => ({
      type: 'system',
      subtype: 'thinking_tokens',
      ...(estimated === undefined ? {} : { estimated_tokens: estimated }),
    });

    it('reports the first line of a burst, then one per 10 s', async () => {
      const lines = Array.from({ length: 21 }, (_, index) => thinking(100 * (index + 1)));
      expect(await summaries('claude', lines, { gapMs: 1000 })).toEqual([
        'Claude: thinking (~100 tokens)',
        'Claude: thinking (~1100 tokens)',
        'Claude: thinking (~2100 tokens)',
      ]);
      expect(
        await summaries(
          'claude',
          Array.from({ length: 10 }, () => thinking(5)),
          { gapMs: 1000 },
        ),
      ).toEqual(['Claude: thinking (~5 tokens)']);
    });

    it('starts a new burst after any other progress line', async () => {
      expect(
        await summaries(
          'claude',
          [thinking(1), thinking(2), assistant(tool('Read', { file_path: 'a' })), thinking(3)],
          { gapMs: 1000 },
        ),
      ).toEqual([
        'Claude: thinking (~1 tokens)',
        'Claude tool: Read a',
        'Claude: thinking (~3 tokens)',
      ]);
    });

    it('falls back to a plain summary without a usable estimate', async () => {
      expect(
        await summaries('claude', [
          thinking(),
          { type: 'system', subtype: 'hook_started' },
          { ...thinking(), estimated_tokens: -1 },
        ]),
      ).toEqual(['Claude: thinking', 'Claude: hook_started', 'Claude: thinking']);
    });
  });
});
