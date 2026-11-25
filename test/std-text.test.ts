// quiet-choir/std text helpers: the stable prompt layout (whose context takes any JSON value, checked
// at runtime), Markdown building blocks, byte- and character-safe clipping, cleaning terminal output,
// and the report renderers. Prompt text is step identity, so the expected strings here are golden.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { definePrompts, z } from '../src/index.js';
import type { ChecklistEntry, ChecklistResult, GateResult } from '../src/std/gates.js';
import * as text from '../src/std/text.js';
import type { ChecklistReport, GateReport } from '../src/std/text.js';
import type { Commit, Finding, Plan, Remediation } from '../src/std/types.js';

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

describe('brief context as a JSON value', () => {
  /** A result typed by an interface, with read-only arrays and an optional member. */
  interface Report {
    readonly title: string;
    readonly files: readonly string[];
    readonly rows: readonly (readonly [string, number])[];
    readonly note?: string | undefined;
  }

  it('accepts read-only arrays and interface values, and renders them as before', () => {
    const files: readonly string[] = Object.freeze(['src/a.ts', 'src/b.ts']);
    expect(text.brief({ task: 'T', context: files })).toBe(
      text.brief({ task: 'T', context: ['src/a.ts', 'src/b.ts'] }),
    );
    const report: Report = { title: 'R', files, rows: [['a', 1]], note: undefined };
    expect(text.brief({ task: 'T', context: report })).toBe(
      [
        'T',
        '',
        '## Context',
        '',
        '```json',
        '{',
        '  "title": "R",',
        '  "files": [',
        '    "src/a.ts",',
        '    "src/b.ts"',
        '  ],',
        '  "rows": [',
        '    [',
        '      "a",',
        '      1',
        '    ]',
        '  ]',
        '}',
        '```',
      ].join('\n'),
    );
    // A value reached twice without a cycle is plain JSON; a null-prototype object is too.
    const shared = { a: 1 };
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { b: true });
    expect(text.brief({ task: 'T', context: { x: shared, y: shared, bare } })).toContain(
      '"y": {\n    "a": 1\n  }',
    );
  });

  it('typechecks a pattern result typed by an interface', () => {
    // Compiles only because context takes any JSON value, not just JsonValue.
    const prompt = (result: GateResult, entries: readonly ChecklistEntry[]): string =>
      text.brief({ task: 'Summarize the gate.', context: { result, entries } });
    expect(prompt).toBeTypeOf('function');
  });

  it.each([
    [{ score: Number.NaN }, '$.score: NaN is not a finite number'],
    [[1, Infinity], '$[1]: Infinity is not a finite number'],
    [{ run: () => 1 }, '$.run: a function is not a JSON value'],
    [{ id: Symbol('x') }, '$.id: a symbol is not a JSON value'],
    [{ big: 1n }, '$.big: a bigint is not a JSON value'],
    [{ when: new Date(0) }, '$.when: only plain objects are JSON, not class instances'],
    [new Map([['a', 1]]), '$: only plain objects are JSON, not class instances'],
    [{ list: ['a', undefined] }, '$.list[1]: an array cannot contain undefined'],
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test.
    [[1, , 3], '$[1]: an array cannot have holes'],
  ] as const)('refuses a context that is not JSON (%#)', (context, where) => {
    expect(() => text.brief({ task: 'T', context })).toThrow(
      new TypeError(`A brief's context is not JSON at ${where}.`),
    );
  });

  it('refuses a cycle', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = { back: cyclic };
    expect(() => text.brief({ task: 'T', context: cyclic })).toThrow(
      new TypeError(`A brief's context is not JSON at $.self.back: the value contains a cycle.`),
    );
  });
});

describe('report renderers', () => {
  const finding: Finding = {
    title: 'Off-by-one in the pager',
    file: 'src/pager.ts',
    line: 12,
    severity: 'high',
    evidence: 'src/pager.ts:12 compares with <=.',
    failureScenario: 'A page size of 10 returns 11 items.',
  };

  it('renders findings as a numbered list, with the fix of a remediation', () => {
    const remediation: Remediation = {
      ...finding,
      title: 'Unchecked path',
      file: 'odd `name`.ts',
      line: null,
      severity: 'critical',
      evidence: 'Line one.\nLine two.',
      fix: 'Validate the path first.',
    };
    expect(text.findings([finding, remediation])).toBe(
      [
        '1. **high**: Off-by-one in the pager (`src/pager.ts:12`)',
        '   - Evidence: src/pager.ts:12 compares with <=.',
        '   - Failure scenario: A page size of 10 returns 11 items.',
        '2. **critical**: Unchecked path (``odd `name`.ts``)',
        '   - Evidence: Line one.',
        '     Line two.',
        '   - Failure scenario: A page size of 10 returns 11 items.',
        '   - Fix: Validate the path first.',
      ].join('\n'),
    );
    expect(text.findings([])).toBe('No findings.');
  });

  it('renders a checklist result with its verdict and each criterion', () => {
    const report: ChecklistReport = {
      verdict: 'not-done',
      results: [
        {
          criterion: { id: 'C1', criterion: 'Invalid input is rejected.', how: '' },
          result: { status: 'pass', evidence: 'test/cli.test.ts:40 expects the message.' },
        },
        {
          criterion: { id: 'C2', criterion: 'The flag is documented.', how: 'Read README.md.' },
          result: { status: 'fail', evidence: 'README.md does not mention --flag.' },
        },
        { criterion: { id: 'C3', criterion: 'It is fast.', how: '' }, result: null },
      ],
    };
    expect(text.checklist(report)).toBe(
      [
        'Verdict: **not-done** (1 of 3 criteria passed)',
        '',
        '- **C1** (pass): Invalid input is rejected.',
        '  Evidence: test/cli.test.ts:40 expects the message.',
        '- **C2** (fail): The flag is documented.',
        '  Evidence: README.md does not mention --flag.',
        '- **C3** (no result): It is fast.',
        '  The checker call failed.',
      ].join('\n'),
    );
    expect(text.checklist({ verdict: 'done', results: report.results.slice(0, 1) })).toMatch(
      /^Verdict: \*\*done\*\* \(1 of 1 criterion passed\)\n\n- \*\*C1\*\* \(pass\)/u,
    );
  });

  it('renders a gate result with its decision and each dimension', () => {
    const report: GateReport = {
      decision: 'conditional-go',
      assessments: [
        {
          key: 'tests',
          disposition: 'pass',
          assessment: {
            status: 'pass',
            summary: 'The suite covers the flag.',
            evidence: ['test/cli.test.ts:40 checks the flag.'],
          },
        },
        {
          key: 'docs',
          disposition: 'downgraded',
          assessment: { status: 'blocker', summary: 'No changelog entry.', evidence: [] },
        },
        { key: 'security', disposition: 'failed', assessment: null },
      ],
    };
    expect(text.gate(report)).toBe(
      [
        'Decision: **conditional-go**',
        '',
        '- **tests** (pass): The suite covers the flag.',
        '  - test/cli.test.ts:40 checks the flag.',
        '- **docs** (downgraded): No changelog entry.',
        '- **security** (failed): The assessor call failed.',
      ].join('\n'),
    );
  });

  it('renders a plan with its steps, risks and checks', () => {
    const value: Plan = {
      summary: 'Add a pager to the list endpoint.',
      steps: [
        {
          id: 'S1',
          description: 'Accept page and size parameters.',
          files: ['src/list.ts', 'test/list.test.ts'],
        },
        { id: 'S2', description: 'Document them.\nIn the README.', files: [] },
      ],
      risks: [],
      checks: ['npm test'],
    };
    expect(text.plan(value)).toBe(
      [
        'Add a pager to the list endpoint.',
        '',
        '**Steps**',
        '',
        '1. **S1**: Accept page and size parameters.',
        '   Files: `src/list.ts`, `test/list.test.ts`',
        '2. **S2**: Document them.',
        '   In the README.',
        '',
        '**Risks**',
        '',
        '(none)',
        '',
        '**Checks**',
        '',
        '- npm test',
      ].join('\n'),
    );
  });

  it('renders commits with their short IDs, subjects, authors and days', () => {
    const list: Commit[] = [
      {
        sha: 'a'.repeat(40),
        shortSha: 'aaaaaaa',
        author: 'Ada Lovelace',
        date: '2026-01-31T09:30:00+01:00',
        subject: 'Add the pager',
      },
      { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', author: 'B', date: 'x', subject: '' },
    ];
    expect(text.commits(list)).toBe(
      [
        '- `aaaaaaa` Add the pager (Ada Lovelace, 2026-01-31)',
        '- `bbbbbbb` (no subject) (B, x)',
      ].join('\n'),
    );
    expect(text.commits([])).toBe('No commits.');
  });

  it('accepts the results the std patterns return', () => {
    // Type-level: the pattern results are the report types, so a renderer takes one as is.
    const checklist = (result: ChecklistResult): string => text.checklist(result);
    const gate = (result: GateResult): string => text.gate(result);
    expect([checklist, gate]).toHaveLength(2);
  });
});
