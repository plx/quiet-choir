// quiet-choir/std text helpers: the stable prompt layout, Markdown building blocks, byte- and
// character-safe clipping, and cleaning terminal output. Prompt text is step identity, so the
// expected strings here are golden.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { definePrompts, z } from '../src/index.js';
import * as text from '../src/std/text.js';

describe('brief', () => {
  it('renders every section in the std layout', () => {
    expect(
      text.brief({
        task: 'Review the change.',
        context: { files: ['src/a.ts'], base: 'main' },
        guidance: ['Report demonstrable defects.', 'An empty list is valid.'],
        output: 'The findings.',
      }),
    ).toBe(
      [
        'Review the change.',
        '',
        '## Context',
        '',
        '```json',
        '{',
        '  "files": [',
        '    "src/a.ts"',
        '  ],',
        '  "base": "main"',
        '}',
        '```',
        '',
        '## Guidance',
        '',
        '- Report demonstrable defects.',
        '- An empty list is valid.',
        '',
        '## Output',
        '',
        'The findings.',
      ].join('\n'),
    );
  });

  it('inserts string context as written and omits absent sections', () => {
    expect(text.brief({ task: 'Do it.' })).toBe('Do it.');
    expect(text.brief({ task: 'Do it.', context: 'Plain\ncontext', guidance: [] })).toBe(
      'Do it.\n\n## Context\n\nPlain\ncontext',
    );
    expect(text.brief({ task: 'Do it.', output: 'Text.' })).toBe('Do it.\n\n## Output\n\nText.');
    expect(text.brief({ task: 'Do it.', context: null })).toBe(
      'Do it.\n\n## Context\n\n```json\nnull\n```',
    );
  });

  it('fences JSON context that itself contains a fence', () => {
    expect(text.brief({ task: 'T', context: ['```'] })).toBe(
      'T\n\n## Context\n\n````json\n[\n  "```"\n]\n````',
    );
  });

  it('is deterministic and rejects a blank task', () => {
    const parts = { task: 'T', context: { b: 1, a: 2 }, guidance: ['g'] };
    expect(text.brief(parts)).toBe(text.brief({ ...parts }));
    expect(() => text.brief({ task: ' \n' })).toThrow(
      new TypeError('A brief needs a nonblank task.'),
    );
  });
});

describe('Markdown blocks', () => {
  it('builds sections', () => {
    expect(text.section('Plan', 'body')).toBe('## Plan\n\nbody');
    expect(() => text.section('a\nb', 'body')).toThrow(TypeError);
  });

  it('builds bulleted and numbered lists with indented continuation lines', () => {
    expect(text.bullets(['a', 'b'])).toBe('- a\n- b');
    expect(text.bullets([])).toBe('(none)');
    expect(text.bullets([], 'nothing')).toBe('nothing');
    expect(text.bullets(['one\ntwo\n\nthree'])).toBe('- one\n  two\n\n  three');
    expect(text.numbered(['a', 'b'])).toBe('1. a\n2. b');
    expect(text.numbered([])).toBe('(none)');
    const ten = Array.from({ length: 10 }, (_, index) => `i${String(index)}`);
    ten[9] = 'last\nmore';
    expect(text.numbered(ten).split('\n').slice(-2)).toEqual(['10. last', '    more']);
  });

  it('fences with a fence longer than any backtick run', () => {
    expect(text.fence('x')).toBe('```\nx\n```');
    expect(text.fence('a ``` b', 'ts')).toBe('````ts\na ``` b\n````');
    expect(text.fence('`````', 'md')).toBe('``````md\n`````\n``````');
    expect(() => text.fence('x', 'a`b')).toThrow(TypeError);
    expect(() => text.fence('x', 'a\nb')).toThrow(TypeError);
  });
});

describe('promptText', () => {
  it('returns a string as is and a rendered prompt as its text', async () => {
    expect(text.promptText('hello')).toBe('hello');
    const root = await mkdtemp(join(tmpdir(), 'choir-std-text-'));
    try {
      await writeFile(join(root, 'greet.md'), 'Hello, {{name}}.');
      const prompts = definePrompts(root, {
        Greet: { file: 'greet.md', params: z.object({ name: z.string() }) },
      });
      const rendered = prompts.Greet({ name: 'Ada' });
      expect(text.promptText(rendered)).toBe(rendered.text);
      expect(text.promptText(rendered)).toContain('Ada');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('clipping', () => {
  it('returns text that fits unchanged', () => {
    expect(text.clip('hello', 5)).toBe('hello');
    expect(text.clip('', 0)).toBe('');
  });

  it('clips on whole UTF-8 characters and appends the marker within the budget', () => {
    const marker = '\n… (clipped)';
    const markerBytes = Buffer.byteLength(marker);
    expect(text.clip('abcdefghijklmnopqrstuvwxyz', markerBytes + 3)).toBe(`abc${marker}`);
    // 'é' is two bytes: a budget of 3 keeps one 'é', never half of the second.
    expect(text.clip('é'.repeat(20), markerBytes + 3)).toBe(`é${marker}`);
    // '😀' is four bytes and two UTF-16 units.
    expect(text.clip('😀😀', 7, '|')).toBe('😀|');
    expect(text.clip('😀😀', 4, '|')).toBe('|');
    for (let max = 1; max < 30; max++) {
      const clipped = text.clip('aé😀b€'.repeat(4), max, '~');
      expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(max);
      expect(clipped.endsWith('~')).toBe(true);
      expect(Buffer.from(clipped).toString('utf8')).toBe(clipped);
    }
  });

  it('rejects a marker larger than the budget and bad sizes', () => {
    expect(() => text.clip('abcdef', 2, '...')).toThrow(
      'The clip marker needs 3 bytes, more than maxBytes (2).',
    );
    expect(text.clip('ab', 2, '...')).toBe('ab');
    expect(() => text.clip('a', -1)).toThrow(TypeError);
  });

  it('keeps a tail without splitting a surrogate pair', () => {
    expect(text.tail('abcdef', 3)).toBe('def');
    expect(text.tail('abc', 5)).toBe('abc');
    expect(text.tail('abc', 0)).toBe('');
    expect(text.tail('a😀b', 2)).toBe('b');
    expect(text.tail('a😀b', 3)).toBe('😀b');
    expect(() => text.tail('a', 1.5)).toThrow(TypeError);
  });
});

describe('cleaning and naming', () => {
  it('strips ANSI escape sequences', () => {
    const esc = '\u001b';
    const colored = `${esc}[1;31mError${esc}[0m: ${esc}[2Kdone`;
    expect(text.stripAnsi(colored)).toBe('Error: done');
    const link = `${esc}]8;;https://example.com${esc}\\site${esc}]8;;${esc}\\ and ${esc}]0;title\u0007x`;
    expect(text.stripAnsi(link)).toBe('site and x');
    expect(text.stripAnsi(`a${esc}(Bb${esc}7c\u009b31md`)).toBe('abcd');
    expect(text.stripAnsi('plain [1m text')).toBe('plain [1m text');
  });

  it('slugs text', () => {
    expect(text.slug('Fix: the Bug in Café!')).toBe('fix-the-bug-in-cafe');
    expect(text.slug('  --Already-slugged--  ')).toBe('already-slugged');
    expect(text.slug('a'.repeat(10) + ' ' + 'b'.repeat(10), 12)).toBe('aaaaaaaaaa-b');
    expect(text.slug('a'.repeat(10) + ' ' + 'b'.repeat(10), 11)).toBe('aaaaaaaaaa');
    expect(text.slug('日本語')).toBe('');
    expect(() => text.slug('x', 0)).toThrow(TypeError);
  });

  it('takes the first sentence of the first paragraph', () => {
    expect(text.firstSentence('Fixes the parser. Also adds tests.')).toBe('Fixes the parser.');
    expect(text.firstSentence('  Wrapped\n  sentence here! Next.')).toBe('Wrapped sentence here!');
    expect(text.firstSentence('Version 1.2 is out')).toBe('Version 1.2 is out');
    expect(text.firstSentence('fix: subject line\n\nBody text. More.')).toBe('fix: subject line');
    expect(text.firstSentence('Why? Because.')).toBe('Why?');
    expect(text.firstSentence('  ')).toBe('');
  });
});
