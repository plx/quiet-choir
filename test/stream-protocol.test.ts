import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  ClaudeProtocol,
  CodexProtocol,
  parseClaude,
  parseCodex,
  type ProtocolOutcome,
} from '../src/harnesses/protocol.js';
import { HarnessError } from '../src/index.js';
import { errorKind } from '../src/workflow/runtime/step-error.js';
import { irrelevantLine, ProtocolLines } from '../src/harnesses/lines.js';

it.each([
  'claude-text-success',
  'claude-structured-success',
  'claude-turn-limit',
  'claude-api-error',
  'codex-text-success',
  'codex-structured-success',
  'codex-invalid-schema',
  'codex-reconnect-success',
])(
  'consumes captured %s incrementally and ignores unrelated events after the result',
  async (name) => {
    const fixture = JSON.parse(
      await readFile(new URL(`./fixtures/harness-stream/${name}.json`, import.meta.url), 'utf8'),
    ) as { stdout: string; structured: boolean };
    const state = name.startsWith('claude')
      ? new ClaudeProtocol(fixture.structured)
      : new CodexProtocol();
    let firstSession: string | null = null;
    for (const line of fixture.stdout.split('\n').filter(Boolean)) {
      state.feed(JSON.parse(line) as Record<string, unknown>);
      firstSession ??= state.sessionId;
    }
    expect(firstSession).toBeTruthy();
    state.feed({ type: 'system', subtype: 'session_state_changed' });
    if (name.startsWith('codex'))
      state.feed({ type: 'thread.started', thread_id: 'later-unrelated-thread' });
    const outcome = state.finish();
    if (name.endsWith('success')) {
      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') throw new Error('Expected captured success');
      expect(outcome.response.sessionId).toBe(firstSession);
      expect(outcome.response.usage.inputTokens).toBeGreaterThan(0);
      if (fixture.structured)
        expect(JSON.parse(outcome.response.text)).toEqual({ answer: 'captured answer' });
      else expect(outcome.response.text).toContain('hello from captured');
      if (name.includes('reconnect'))
        expect(outcome.response.warnings?.some((value) => value.includes('Reconnecting'))).toBe(
          true,
        );
    } else {
      expect(outcome.kind).toBe('failure');
      if (outcome.kind !== 'failure') throw new Error('Expected captured failure');
      expect(outcome.failure.sessionId).toBe(firstSession);
    }
    expect(state.retainedBytes).toBeLessThan(8192);
    if (name.startsWith('claude'))
      expect(parseClaude(fixture.stdout, fixture.structured)).toEqual(outcome);
  },
);

it('frames split UTF-8, CRLF and a final line without newline', async () => {
  const lines: string[] = [];
  const reader = new ProtocolLines(
    1024,
    (line) => {
      lines.push(line.trim());
    },
    () => false,
  );
  const bytes = Buffer.from('\r\n{"text":"é🙂"}\r\n{"last":true}');
  for (const byte of bytes) await reader.feed(Uint8Array.of(byte));
  await reader.finish();
  expect(lines).toEqual(['{"text":"é🙂"}', '{"last":true}']);
});

it('discards a nine-MiB command line while preserving the final message and usage', async () => {
  const state = new CodexProtocol();
  let skipped = 0;
  const reader = new ProtocolLines(
    1024,
    (line) => {
      state.feed(JSON.parse(line) as Record<string, unknown>);
    },
    (prefix) => {
      if (!irrelevantLine('codex', prefix)) return false;
      skipped++;
      return true;
    },
  );
  await reader.feed(
    Buffer.from(
      '{"type":"thread.started","thread_id":"early"}\n{"type":"item.completed","item":{"id":"1","type":"command_execution","aggregated_output":"',
    ),
  );
  const block = Buffer.from('x'.repeat(65536));
  for (let i = 0; i < 144; i++) await reader.feed(block);
  await reader.feed(
    Buffer.from(
      '"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"final"}}\n{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}\n',
    ),
  );
  await reader.finish();
  expect(skipped).toBe(1);
  expect(state.finish()).toMatchObject({
    kind: 'success',
    response: { text: 'final', sessionId: 'early', usage: { inputTokens: 2, outputTokens: 1 } },
  });
  expect(state.retainedBytes).toBeLessThan(1024);
});

it('fails oversized essential or unclassifiable lines instead of silently dropping answers', async () => {
  for (const prefix of [
    '{"type":"result","result":"',
    '{"type":"item.completed","item":{"type":"agent_message","text":"',
    '{"type":"unknown","text":"',
  ]) {
    const reader = new ProtocolLines(
      128,
      () => undefined,
      (value) => irrelevantLine('codex', value) || irrelevantLine('claude', value),
    );
    await expect(reader.feed(Buffer.from(prefix + 'x'.repeat(256)))).rejects.toMatchObject({
      code: 'QUIET_CHOIR_OUTPUT_LIMIT',
      message: expect.stringContaining('maxRetainedBytes') as unknown,
    });
  }
  expect(
    irrelevantLine(
      'codex',
      '{"text":"\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"command_execution\\"}',
    ),
  ).toBe(false);
});

async function capture(name: string): Promise<{ stdout: string; stderr: string }> {
  return JSON.parse(
    await readFile(new URL(`./fixtures/harness/${name}.json`, import.meta.url), 'utf8'),
  ) as { stdout: string; stderr: string };
}

function codex(events: readonly Record<string, unknown>[]): ProtocolOutcome {
  const state = new CodexProtocol();
  for (const event of events) state.feed(event);
  return state.finish();
}

function failureKind(outcome: ProtocolOutcome): string | undefined {
  if (outcome.kind !== 'failure') throw new Error(`Expected a failure, got ${outcome.kind}`);
  return outcome.failure.kind;
}

const started = { type: 'thread.started', thread_id: 'thread' };
const reconnect = (n: number) => ({
  type: 'error',
  message: `Reconnecting... ${String(n)}/3 (rate limit exceeded: Rate limit reached)`,
});

it('classifies captured Codex rate limits and invalid requests in the protocol layer', async () => {
  expect(failureKind(parseCodex((await capture('codex-rate-limit')).stdout))).toBe('rate-limit');
  const effort = parseCodex((await capture('codex-invalid-effort')).stdout);
  expect(failureKind(effort)).toBe('invalid-request');
  // The outer envelope's generic `"type": "error"` does not mask the innermost type.
  expect(effort).toMatchObject({ failure: { apiStatus: 400 } });
});

it('classifies a notice-only Codex failure after rate-limit reconnects as rate-limit', () => {
  expect(failureKind(codex([started, reconnect(1), reconnect(2), reconnect(3)]))).toBe(
    'rate-limit',
  );
  // An unrelated reconnect reason, or a missing prefix, is not a rate limit.
  expect(
    failureKind(
      codex([started, { type: 'error', message: 'Reconnecting... 1/3 (stream closed)' }]),
    ),
  ).toBeUndefined();
  expect(
    failureKind(
      codex([started, { type: 'error', message: 'Retrying... 1/3 (rate limit exceeded: x)' }]),
    ),
  ).toBeUndefined();
});

it('keeps a different terminal error after rate-limit reconnects unclassified by prose', () => {
  const outcome = codex([
    started,
    reconnect(1),
    reconnect(2),
    { type: 'turn.failed', error: { message: 'stream disconnected before completion' } },
  ]);
  expect(failureKind(outcome)).toBeUndefined();
  // Only a fixed prefix counts: the phrase quoted later in an unrelated error does not.
  expect(
    failureKind(
      codex([
        started,
        {
          type: 'turn.failed',
          error: { message: 'tool failed: output said "rate limit exceeded"' },
        },
      ]),
    ),
  ).toBeUndefined();
  expect(
    failureKind(
      codex([started, { type: 'turn.failed', error: { message: 'Rate Limit Exceeded: quota' } }]),
    ),
  ).toBe('rate-limit');
});

it('classifies a Codex rate limit through HarnessError while plain messages stay unknown', () => {
  const outcome = codex([
    started,
    { type: 'turn.failed', error: { message: 'rate limit exceeded' } },
  ]);
  if (outcome.kind !== 'failure') throw new Error('Expected failure');
  const error = new HarnessError({
    harness: 'codex',
    exit: { code: 1, signal: null },
    failure: outcome.failure,
    reason: outcome.failure.reason,
    stderr: '',
    stdout: '',
  });
  expect(errorKind(error)).toBe('rate-limit');
  expect(errorKind(new Error('rate limit exceeded: Rate limit reached'))).toBe('unknown');
});

it("classifies Claude's unrecognized-model stderr tag as invalid-request", async () => {
  const unknown = await capture('claude-unknown-model');
  const envelope = JSON.parse(unknown.stdout) as Record<string, unknown>;
  // Without a status, only the CLI's own stderr tag classifies the failure.
  delete envelope['api_error_status'];
  const state = new ClaudeProtocol(false);
  state.feed(envelope);
  expect(failureKind(state.finish())).toBeUndefined();
  expect(failureKind(state.finish(unknown.stderr))).toBe('invalid-request');
  expect(failureKind(state.finish('log: [claude-code:unrecognized_model] quoted'))).toBeUndefined();
  expect(failureKind(state.finish('other warning\n[claude-code:unrecognized_model] {}'))).toBe(
    'invalid-request',
  );
});

it('classifies the live rate-limit capture exactly as the same stream without its rate_limit_event', async () => {
  const { stdout } = await capture('claude-rate-limit-success');
  const lines = stdout.split('\n').filter(Boolean);
  const events = lines.filter((line) => line.includes('"type":"rate_limit_event"'));
  expect(events).toHaveLength(1);
  const feed = (input: readonly string[]): ProtocolOutcome => {
    const state = new ClaudeProtocol(false);
    for (const line of input) state.feed(JSON.parse(line) as Record<string, unknown>);
    return state.finish();
  };
  const outcome = feed(lines);
  expect(outcome).toMatchObject({ kind: 'success', response: { text: 'ok' } });
  expect(outcome).toEqual(feed(lines.filter((line) => !events.includes(line))));
  expect(parseClaude(stdout, false)).toEqual(outcome);
});
