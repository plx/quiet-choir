import { appendFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, vi } from 'vitest';

import {
  AttemptTranscript,
  readAttemptTranscript,
} from '../src/workflow/runtime/agent-transcript.js';
import { it } from './setup/state-dir.js';

async function decode(
  path: string,
  stream: 'stdout' | 'stderr',
  maxLineBytes?: number,
): Promise<{ text: Buffer; bytes: number; truncated: boolean; chunks: number }> {
  const chunks: Uint8Array[] = [];
  const result = await readAttemptTranscript(
    path,
    stream,
    (chunk) => {
      chunks.push(chunk);
    },
    maxLineBytes,
  );
  return { text: Buffer.concat(chunks), ...result, chunks: chunks.length };
}

describe('readAttemptTranscript', () => {
  it('decodes each stream in order, keeping a UTF-8 character split across chunks', async ({
    stateDir,
  }) => {
    const transcript = await AttemptTranscript.create(stateDir, 'task', 1, 'claude');
    const line = Buffer.from('{"type":"assistant","text":"café \u{1F642}"}\n', 'utf8');
    const emoji = line.indexOf(0xf0);
    // Split inside the 4-byte emoji and interleave stderr between the halves.
    await transcript.write('stdout', line.subarray(0, emoji + 2));
    await transcript.write('stderr', Buffer.from('warning: one\n'));
    await transcript.write('stdout', line.subarray(emoji + 2));
    await transcript.write('stderr', Buffer.from('warning: two\n'));
    await transcript.close();
    const path = transcript.snapshot().path;

    const stdout = await decode(path, 'stdout');
    expect(stdout.text.equals(line)).toBe(true);
    expect(stdout).toMatchObject({ bytes: line.length, truncated: false, chunks: 2 });
    expect(JSON.parse(stdout.text.toString('utf8'))).toEqual({
      type: 'assistant',
      text: 'café \u{1F642}',
    });
    const stderr = await decode(path, 'stderr');
    expect(stderr.text.toString('utf8')).toBe('warning: one\nwarning: two\n');
    expect(stderr.truncated).toBe(false);
  });

  it('reports the truncation marker', async ({ stateDir }) => {
    const transcript = await AttemptTranscript.create(stateDir, 'task', 1, 'codex', 256);
    await transcript.write('stdout', Buffer.from('x'.repeat(1000)));
    await transcript.close();
    expect(transcript.snapshot().truncated).toBe(true);
    const result = await decode(transcript.snapshot().path, 'stdout');
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.text.toString('utf8')).toBe('x'.repeat(result.bytes));
  });

  it('throws on a malformed line, naming it', async ({ stateDir }) => {
    const path = join(stateDir, 'bad.jsonl');
    const good = `${JSON.stringify({ stream: 'stdout', base64: Buffer.from('ok').toString('base64') })}\n`;
    const cases: [string, RegExp][] = [
      [`${good}not json\n`, /line 2 .* is not valid JSON/u],
      [`${good}${good}{"stream":"stdin","base64":""}\n`, /line 3 .* is not a transcript entry/u],
      [`{"stream":"stdout","base64":"!!"}\n`, /line 1 .* is not a transcript entry/u],
      [`{"stream":"stdout","base64":"","extra":1}\n`, /line 1 .* is not a transcript entry/u],
      [`[]\n`, /line 1 .* is not a transcript entry/u],
      [`\n`, /line 1 .* is not valid JSON/u],
      [
        `${good}{"type":"truncated","reason":"maxTranscriptBytes"}\n${good}`,
        /line 3 .* follows the truncation marker/u,
      ],
      [`${good}{"stream":"stdout","base64":"b2`, /line 2 .* is not valid JSON/u],
      // Padding only at the end, at most two, and a whole number of 4-character quanta.
      ...['AB=C', '=ABC', 'A===', '====', 'b2s=b2s=', 'b2s', 'b2s==', 'YQ=='.repeat(2)].map(
        (base64): [string, RegExp] => [
          `${JSON.stringify({ stream: 'stdout', base64 })}\n`,
          /line 1 .* is not a transcript entry/u,
        ],
      ),
    ];
    for (const [text, error] of cases) {
      await writeFile(path, text);
      await expect(decode(path, 'stdout')).rejects.toThrow(error);
    }
    await writeFile(path, good);
    await appendFile(
      path,
      `${JSON.stringify({ stream: 'stderr', base64: Buffer.from('x'.repeat(30)).toString('base64') })}\n`,
    );
    await expect(decode(path, 'stdout', 40)).rejects.toThrow(/line 2 .* is longer than 40 bytes/u);
    expect((await decode(path, 'stdout', 4096)).text.toString('utf8')).toBe('ok');
  });

  it('decodes a single multi-megabyte chunk and every padding length', async ({ stateDir }) => {
    const transcript = await AttemptTranscript.create(stateDir, 'task', 1, 'claude');
    const large = Buffer.alloc(4 * 1024 * 1024);
    for (let index = 0; index < large.length; index++) large[index] = (index * 131) % 251;
    await transcript.write('stdout', large);
    for (const tail of ['a', 'ab', 'abc']) await transcript.write('stdout', Buffer.from(tail));
    await transcript.close();
    const result = await decode(transcript.snapshot().path, 'stdout');
    expect(result).toMatchObject({ bytes: large.length + 6, truncated: false, chunks: 4 });
    expect(result.text.equals(Buffer.concat([large, Buffer.from('aababc')]))).toBe(true);
  });

  it('stops on an aborted signal even when no entry of the stream is passed on', async ({
    stateDir,
  }) => {
    const path = join(stateDir, 'stdout-only.jsonl');
    const line = `${JSON.stringify({ stream: 'stdout', base64: Buffer.from('out').toString('base64') })}\n`;
    await writeFile(path, line.repeat(1000));
    const onChunk = vi.fn();
    const signal = AbortSignal.abort(new Error('stop reading'));
    await expect(readAttemptTranscript(path, 'stderr', onChunk, undefined, signal)).rejects.toThrow(
      'stop reading',
    );
    // Aborted mid-read by a callback that does not throw: the read still rejects.
    const controller = new AbortController();
    const stopping = readAttemptTranscript(
      path,
      'stdout',
      () => {
        controller.abort(new Error('stop after one'));
      },
      undefined,
      controller.signal,
    );
    await expect(stopping).rejects.toThrow('stop after one');
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('refuses a symlinked transcript file', async ({ stateDir }) => {
    const target = join(stateDir, 'real.jsonl');
    await writeFile(target, `${JSON.stringify({ stream: 'stdout', base64: '' })}\n`);
    const link = join(stateDir, 'link.jsonl');
    await symlink(target, link);
    await expect(decode(link, 'stdout')).rejects.toMatchObject({ code: 'ELOOP' });
  });
});
