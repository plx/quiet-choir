import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { ClaudeProtocol, CodexProtocol, parseClaude } from '../src/harnesses/protocol.js';
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
