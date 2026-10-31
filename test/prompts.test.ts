// Prompt templates (ADR 0064 sections 1-2, #581): definePrompts over minijinja-js behind the
// engine adapter. Rendered text is step identity, so the goldens below are a gate like
// test/schema-identity.test.ts: an engine bump, settings change or front-matter change that moves
// them needs an explicit decision, not a refreshed expectation.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Minijinja from 'minijinja-js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as host from '../src/index.js';
import { definePrompts, PromptError, z } from '../src/index.js';
import * as std from '../src/std/index.js';
import { FailureOrigins } from '../src/workflow/runtime/fan-out.js';
import { checkPromptSets } from '../src/workflow/prompts/check.js';
import { createPromptEnvironment, renderString } from '../src/workflow/prompts/engine.js';
import {
  isPrompt,
  promptOptionsAsText,
  promptSetDescriptor,
} from '../src/workflow/prompts/prompt.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(repository, 'test/fixtures/prompts');

const Thread = z.object({ author: z.string(), body: z.string() });
const Issue = z.object({ number: z.number().int(), title: z.string() });
const entries = {
  Review: {
    file: 'Review.md',
    params: z.object({
      repo: z.string(),
      issue: Issue,
      diff: z.string(),
      threads: z.array(Thread),
    }),
  },
  Whitespace: {
    file: 'Whitespace.md',
    params: z.object({ items: z.array(z.object({ name: z.string(), bold: z.boolean() })) }),
  },
  Bomb: { file: 'Bomb.md', params: z.object({}) },
  Optional: {
    file: 'Optional.md',
    params: z.object({ name: z.string(), greeting: z.string().optional() }),
  },
};
const reviewParams = {
  repo: 'plx/quiet-choir',
  issue: { number: 581, title: 'Add <definePrompts>' },
  diff: '-old line\n+new line',
  threads: [
    { author: 'amy', body: '  Is the loader confined?  ' },
    { author: 'bo', body: 'nit: naming' },
  ],
};
const reviewGolden = [
  '# Review of #581: Add <definePrompts>',
  '',
  'You are reviewing a change to plx/quiet-choir. Report <b>blocking</b> problems first.',
  '',
  '## Open threads',
  '',
  '- amy: Is the loader confined?',
  '- bo: nit: naming',
  '',
  '## Issue',
  '',
  '```json',
  '{',
  '  "number": 581,',
  '  "title": "Add \\u003cdefinePrompts\\u003e"',
  '}',
  '```',
  '',
  '## Diff',
  '',
  '    -old line',
  '    +new line',
].join('\n');

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
/** A temporary prompt root with `files`, inside a parent directory that also holds `outside.md`. */
async function root(files: Readonly<Record<string, string>>): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'choir-prompts-'));
  directories.push(parent);
  await writeFile(join(parent, 'outside.md'), 'outside the root');
  const directory = join(parent, 'prompts');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), text);
  }
  await mkdir(directory, { recursive: true });
  return directory;
}
/** Render one template file under a fresh root, returning the thrown error. */
async function renderError(
  files: Readonly<Record<string, string>>,
  file = 'Main.md',
  params: z.ZodObject = z.object({}),
  values: object = {},
): Promise<PromptError> {
  const prompts = definePrompts(await root(files), { Main: { file, params } });
  try {
    prompts.Main(values as never);
  } catch (error) {
    expect(error).toBeInstanceOf(PromptError);
    return error as PromptError;
  }
  throw new Error('Expected a PromptError.');
}

describe('rendering (ADR 0064 section 1)', () => {
  it('renders include, tojson and indent to the exact golden, across fresh environments', () => {
    const first = definePrompts(fixtures, entries);
    const prompt = first.Review(reviewParams);
    expect(prompt).not.toBeInstanceOf(Promise);
    expect(prompt.text).toBe(reviewGolden);
    expect(first.Review(reviewParams).text).toBe(reviewGolden);
    expect(definePrompts(fixtures, entries).Review(reviewParams).text).toBe(reviewGolden);
    expect(definePrompts(pathToFileURL(fixtures), entries).Review(reviewParams).text).toBe(
      reviewGolden,
    );
  });

  it('returns a frozen, branded Prompt whose string form is its text', () => {
    const prompt = definePrompts(fixtures, entries).Review(reviewParams);
    expect(Object.keys(prompt)).toEqual(['text', 'template', 'params']);
    expect(prompt.template).toBe('Review');
    expect(String(prompt)).toBe(prompt.text);
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- the behavior under test
    expect(`${prompt}`).toBe(prompt.text);
    expect(prompt.params).toEqual(reviewParams);
    expect(Object.isFrozen(prompt)).toBe(true);
    expect(Reflect.get(prompt, Symbol.for('quiet-choir.prompt'))).toBe(true);
    expect(Object.getOwnPropertySymbols(prompt)).toEqual([]);
    expect(isPrompt(prompt)).toBe(true);
    expect(isPrompt({ text: 'x', template: 'X', params: {} })).toBe(false);
  });

  it('strips front matter and the trailing newline, trims block lines and never escapes HTML', () => {
    const prompts = definePrompts(fixtures, entries);
    const review = prompts.Review(reviewParams).text;
    expect(review).not.toContain('---');
    expect(review).not.toContain('description:');
    expect(review.startsWith('# Review')).toBe(true);
    expect(
      prompts.Whitespace({
        items: [
          { name: 'a', bold: true },
          { name: 'b', bold: false },
        ],
      }).text,
      // The file ends in two newlines; only the final one is dropped.
    ).toBe('Items:\n  - <b>a</b> & co\n  - b\nDone.\n');
  });

  it('removes random, randrange and lipsum, so a direct render fails with unknown filter or function', () => {
    expect(() => renderString('{{ [1, 2] | random }}', {})).toThrow(/unknown filter/u);
    expect(() => renderString('{{ randrange(3) }}', {})).toThrow(/unknown function/u);
    expect(() => renderString('{{ lipsum() }}', {})).toThrow(/unknown function/u);
    expect(renderString('{{ [1, 2] | join(",") }}', {})).toBe('1,2');
  });

  it('fails a loop bomb on fuel instead of hanging', () => {
    const started = Date.now();
    try {
      definePrompts(fixtures, entries).Bomb({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PromptError);
      expect(error).toMatchObject({ kind: 'OutOfFuel', prompt: 'Bomb', file: 'Bomb.md' });
      expect((error as Error).message).toMatch(/^Prompt Bomb \(Bomb\.md\): .*fuel/u);
    }
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

// The recipes of docs/prompts.md#whitespace, rendered. Like the goldens above, they gate an engine
// upgrade or settings change: a render that moves needs an explicit decision and a docs update.
describe('whitespace recipes (docs/prompts.md)', () => {
  const criteria = z.object({ criteria: z.array(z.string()) });
  const listed = { criteria: ['Download works', 'Headers'] };
  const compactList = 'Acceptance criteria:\n{% for c in criteria %}\n- {{ c }}\n{% endfor %}\n';
  const conditional = 'Intro.\n\n{% if extra %}\nOptional paragraph.\n\n{% endif %}\nAfter.\n';
  const location = z.object({ file: z.string(), line: z.number(), evidence: z.string() });
  const at = { file: 'a.ts', line: 5, evidence: 'x' };
  const dims = z.object({ dims: z.array(z.string()) });
  const note = 'Fragment paragraph.\n';
  it.for([
    [
      'a compact list',
      { 'Main.md': `${compactList}\nAfter.\n` },
      criteria,
      listed,
      'Acceptance criteria:\n- Download works\n- Headers\n\nAfter.',
    ],
    [
      'blank-separated blocks',
      {
        'Main.md':
          'Intro paragraph.\n\n{% for e in evidence %}\n<evidence>{{ e }}</evidence>\n\n{% endfor %}\nAfter.\n',
      },
      z.object({ evidence: z.array(z.string()) }),
      { evidence: ['1', '2'] },
      'Intro paragraph.\n\n<evidence>1</evidence>\n\n<evidence>2</evidence>\n\nAfter.',
    ],
    [
      'a conditional paragraph that is present',
      { 'Main.md': conditional },
      z.object({ extra: z.boolean() }),
      { extra: true },
      'Intro.\n\nOptional paragraph.\n\nAfter.',
    ],
    [
      'a conditional paragraph that is absent',
      { 'Main.md': conditional },
      z.object({ extra: z.boolean() }),
      { extra: false },
      'Intro.\n\nAfter.',
    ],
    [
      'a tag that ends a line',
      {
        'Main.md':
          'Location: {{ file }}{% if line %}:{{ line }}{% endif %}\nEvidence: {{ evidence }}\n',
      },
      location,
      at,
      'Location: a.ts:5Evidence: x',
    ],
    [
      'a tag that ends a line with +%}',
      {
        'Main.md':
          'Location: {{ file }}{% if line %}:{{ line }}{% endif +%}\nEvidence: {{ evidence }}\n',
      },
      location,
      at,
      'Location: a.ts:5\nEvidence: x',
    ],
    ['a comment that ends a line', { 'Main.md': 'A{# note #}\nB\n' }, z.object({}), {}, 'AB'],
    [
      'a one-line if',
      {
        'Main.md':
          "Dims: {% if dims %}{{ dims | join(', ') }}{% else %}none{% endif %}\n\nNext paragraph.\n",
      },
      dims,
      { dims: ['tests'] },
      'Dims: tests\nNext paragraph.',
    ],
    [
      'an inline if expression',
      { 'Main.md': "Dims: {{ dims | join(', ') if dims else 'none' }}\n\nNext paragraph.\n" },
      dims,
      { dims: ['tests'] },
      'Dims: tests\n\nNext paragraph.',
    ],
    [
      'an include with no blank line after it',
      {
        'Main.md': 'Intro.\n\n{% include "_fragments/note.md" %}\nNext paragraph.\n',
        '_fragments/note.md': note,
      },
      z.object({}),
      {},
      'Intro.\n\nFragment paragraph.Next paragraph.',
    ],
    [
      'a plain include',
      {
        'Main.md': 'Intro.\n\n{% include "_fragments/note.md" %}\n\nNext paragraph.\n',
        '_fragments/note.md': note,
      },
      z.object({}),
      {},
      'Intro.\n\nFragment paragraph.\nNext paragraph.',
    ],
    [
      'an include with +%}',
      {
        'Main.md': 'Intro.\n\n{% include "_fragments/note.md" +%}\n\nNext paragraph.\n',
        '_fragments/note.md': note,
      },
      z.object({}),
      {},
      'Intro.\n\nFragment paragraph.\n\nNext paragraph.',
    ],
    [
      'an include with +%} in a loop',
      {
        'Main.md':
          '## Threads\n\n{% for t in threads %}\n{% include "_fragments/thread.md" +%}\n{% endfor %}\n\n## Next\n',
        '_fragments/thread.md': '- {{ t }}\n',
      },
      z.object({ threads: z.array(z.string()) }),
      { threads: ['a', 'b'] },
      '## Threads\n\n- a\n- b\n\n## Next',
    ],
    [
      'a plain include of a fragment ending in a block tag',
      {
        'Main.md': 'Intro.\n\n{% include "_fragments/criteria.md" %}\n\nNext.\n',
        '_fragments/criteria.md': compactList,
      },
      criteria,
      listed,
      'Intro.\n\nAcceptance criteria:\n- Download works\n- Headers\n\nNext.',
    ],
    [
      'an include with +%} of a fragment ending in a block tag',
      {
        'Main.md': 'Intro.\n\n{% include "_fragments/criteria.md" +%}\n\nNext.\n',
        '_fragments/criteria.md': compactList,
      },
      criteria,
      listed,
      'Intro.\n\nAcceptance criteria:\n- Download works\n- Headers\n\n\nNext.',
    ],
    [
      'a dashed loop',
      { 'Main.md': 'Acceptance criteria:\n{%- for c in criteria %}\n- {{ c }}\n{%- endfor %}\n' },
      criteria,
      listed,
      'Acceptance criteria:- Download works- Headers',
    ],
  ] as const)('renders %s', async ([, files, params, values, expected]) => {
    const prompts = definePrompts(await root(files), { Main: { file: 'Main.md', params } });
    expect(prompts.Main(values as never).text).toBe(expected);
  });
});

// The null and fencing advice of docs/prompts.md#template-language-and-fixed-settings, rendered.
// Like the recipes above, a render that moves on an engine upgrade needs a docs update.
describe('null and fencing recipes (docs/prompts.md)', () => {
  it('prints null as None, which default keeps and a none test, or and default(_, true) replace', async () => {
    const lines = [
      '{{ x }}',
      "{{ x | default('u') }}",
      "{{ x | default('u', true) }}",
      "{{ x or 'u' }}",
      '{% if x is not none %}{{ x }}{% else %}u{% endif +%}',
      '{{ x | tojson }}',
    ];
    const prompts = definePrompts(await root({ 'Main.md': `${lines.join('\n')}\n` }), {
      Main: { file: 'Main.md', params: z.object({ x: z.string().nullable() }) },
    });
    expect(prompts.Main({ x: null }).text).toBe('None\nNone\nu\nu\nu\nnull');
  });

  it.for(['', 0, false])('replaces %j with or and default(_, true) too', async (x) => {
    const prompts = definePrompts(
      await root({ 'Main.md': "{{ x or 'u' }} {{ x | default('u', true) }}" }),
      {
        Main: {
          file: 'Main.md',
          params: z.object({ x: z.union([z.string(), z.number(), z.boolean()]) }),
        },
      },
    );
    expect(prompts.Main({ x }).text).toBe('u u');
  });

  it('fences a closing tag with tojson(indent=2), std.exec.json escaped, or replace', async () => {
    const v = [{ s: "a </items> b & it's" }];
    const prompts = definePrompts(
      await root({
        'Data.md': '<items>\n{{ v | tojson(indent=2) }}\n</items>\n',
        'Prose.md': '<items>{{ t | replace("</items", "<\\\\/items") }}</items>\n',
        'Single.md': '<items>{{ t | replace("</items", "<\\/items") }}</items>\n',
      }),
      {
        Data: { file: 'Data.md', params: z.object({ v: z.array(z.object({ s: z.string() })) }) },
        Prose: { file: 'Prose.md', params: z.object({ t: z.string() }) },
        Single: { file: 'Single.md', params: z.object({ t: z.string() }) },
      },
    );
    const escaped = std.exec
      .json(v)
      .replace(/[<>&']/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const data = prompts.Data({ v }).text;
    expect(data).toBe(`<items>\n${escaped}\n</items>`);
    expect(data.split('</items>')).toHaveLength(2);
    const t = 'a </items> b';
    expect(prompts.Prose({ t }).text).toBe('<items>a <\\/items> b</items>');
    // One backslash is a template string escape for a plain slash, so nothing is replaced.
    expect(prompts.Single({ t }).text).toBe('<items>a </items> b</items>');
  });
});

describe('authoring errors (ADR 0064 section 2)', () => {
  it('rejects an unknown parameter key and an invalid value before rendering', () => {
    const prompts = definePrompts(fixtures, entries);
    expect(() => prompts.Optional({ name: 'x', extra: 1 } as never)).toThrow(
      /^Prompt Optional \(Optional\.md\): invalid parameters: .*extra/u,
    );
    try {
      prompts.Optional({ name: 3 } as never);
    } catch (error) {
      expect(error).toMatchObject({ kind: 'InvalidParams', prompt: 'Optional', line: null });
    }
  });

  it('reports a schema Zod cannot parse synchronously as invalid parameters', () => {
    const prompts = definePrompts(fixtures, {
      Optional: {
        file: 'Optional.md',
        params: z.object({
          // eslint-disable-next-line @typescript-eslint/require-await -- the refinement must be async
          name: z.string().refine(async () => true),
          greeting: z.string().optional(),
        }),
      },
    });
    try {
      prompts.Optional({ name: 'Ada', greeting: 'Hi' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PromptError);
      expect(error).toMatchObject({ kind: 'InvalidParams', prompt: 'Optional', line: null });
      expect((error as Error).message).toMatch(
        /^Prompt Optional \(Optional\.md\): invalid parameters: /u,
      );
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
  });

  it('fails a missing variable under strict undefined, naming the template and line', () => {
    try {
      definePrompts(fixtures, entries).Optional({ name: 'Ada' });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ kind: 'UndefinedError', prompt: 'Optional', line: 2 });
      expect((error as Error).message).toMatch(/^Prompt Optional \(Optional\.md\): undefined/u);
    }
    expect(definePrompts(fixtures, entries).Optional({ name: 'Ada', greeting: 'Hi' }).text).toBe(
      'Hello Ada.\nHi',
    );
  });

  it('keeps engine line numbers right after front matter', async () => {
    const error = await renderError({
      'Main.md': '---\ndescription: lines\n\n---\nline five\n{{ missing }}\n',
    });
    expect(error).toMatchObject({ kind: 'UndefinedError', line: 6 });
    expect(error.message).toContain('Main.md:6');
  });

  it('reports a syntax error naming the prompt and file', async () => {
    const error = await renderError({ 'Main.md': 'one\n{% if %}\n' });
    expect(error).toMatchObject({ kind: 'SyntaxError', prompt: 'Main', file: 'Main.md', line: 2 });
    expect(error.message).toMatch(/^Prompt Main \(Main\.md\): syntax error/u);
    expect(error.message).not.toContain('\n');
  });

  it('confines includes to the root: .., absolute and symlinked targets are refused', async () => {
    const up = await renderError({ 'Main.md': '{% include "../outside.md" %}' });
    expect(up).toMatchObject({ kind: 'TemplateRefused', file: '../outside.md' });
    expect(up.message).toMatch(/^Prompt Main \(Main\.md\): .*resolves outside the prompt root/u);
    const nested = await renderError({
      'Main.md': '{% include "_fragments/a.md" %}',
      '_fragments/a.md': '{% include "../../outside.md" %}',
    });
    expect(nested).toMatchObject({ kind: 'TemplateRefused', file: '../outside.md' });
    const absolute = await renderError({ 'Main.md': '{% include "/etc/hosts" %}' });
    expect(absolute).toMatchObject({ kind: 'TemplateRefused' });
    expect(absolute.message).toContain('is absolute');
    const directory = await root({ 'Main.md': '{% include "_fragments/link.md" %}' });
    await mkdir(join(directory, '_fragments'));
    await symlink(join(directory, '..', 'outside.md'), join(directory, '_fragments', 'link.md'));
    const linked = definePrompts(directory, { Main: { file: 'Main.md', params: z.object({}) } });
    expect(() => linked.Main({})).toThrow(/resolves outside the prompt root/u);
  });

  it('follows a symlink that stays inside the root, and resolves targets from the including file', async () => {
    const directory = await root({
      'Main.md': 'A{% include "_fragments/a.md" %}',
      '_fragments/a.md': 'B{% include "b.md" %}',
      '_fragments/b.md': 'C',
    });
    await symlink(join(directory, 'Main.md'), join(directory, 'Alias.md'));
    const prompts = definePrompts(directory, {
      Main: { file: 'Main.md', params: z.object({}) },
      Alias: { file: './Alias.md', params: z.object({}) },
    });
    expect(prompts.Main({}).text).toBe('ABC');
    expect(prompts.Alias({}).text).toBe('ABC');
  });

  it('reports a missing template or include as TemplateNotFound', async () => {
    const missing = await renderError({}, 'Nope.md');
    expect(missing).toMatchObject({ kind: 'TemplateNotFound', prompt: 'Main', file: 'Nope.md' });
    const include = await renderError({ 'Main.md': '{% include "_fragments/none.md" %}' });
    expect(include).toMatchObject({ kind: 'TemplateNotFound' });
    expect(include.message).toContain('_fragments/none.md');
  });

  it.for([
    ['another key', '---\ntitle: x\n---\nbody', /may hold only a description key/u],
    ['an unterminated block', '---\ndescription: x\n\n', /is not closed by a --- line/u],
    ['prose before the closing line', '---\ndescription: x\nbody\n---\n', /not "body"/u],
    ['a numeric description', '---\ndescription: 42\n---\n', /must be a nonempty string/u],
    ['a boolean description', '---\ndescription: true\n---\n', /must be a nonempty string/u],
    ['a list description', '---\ndescription: [a, b]\n---\n', /must be a nonempty string/u],
    ['an empty description', '---\ndescription:\n---\n', /must be a nonempty string/u],
    ['a repeated description', '---\ndescription: a\ndescription: b\n---\n', /repeats/u],
    ['a bad quoted string', '---\ndescription: "a\n---\n', /double-quoted/u],
  ] as const)('refuses front matter with %s', async ([, source, pattern]) => {
    const error = await renderError({ 'Main.md': source });
    expect(error).toMatchObject({ kind: 'InvalidFrontMatter', prompt: 'Main', file: 'Main.md' });
    expect(error.message).toMatch(/^Prompt Main \(Main\.md\): front matter /u);
    expect(error.message).toMatch(pattern);
  });

  it('accepts a plain or JSON-quoted description and renders nothing of it', async () => {
    const directory = await root({
      'A.md': '---\ndescription: Review: the diff\n---\nA',
      'B.md': '---\n\ndescription: "Quoted: \\"yes\\""\n\n---\n{{ x }}',
      'C.md': '--- not front matter\nC',
    });
    const prompts = definePrompts(directory, {
      B: { file: 'B.md', params: z.object({ x: z.string() }) },
      C: { file: 'C.md', params: z.object({}) },
    });
    expect(prompts.B({ x: 'b' }).text).toBe('b');
    expect(prompts.C({}).text).toBe('--- not front matter\nC');
    // `Review: the diff` holds ": ", which YAML would not read as a plain scalar.
    const plain = await renderError({ 'Main.md': '---\ndescription: Review: the diff\n---\nA' });
    expect(plain.kind).toBe('InvalidFrontMatter');
  });
});

describe('definePrompts arguments', () => {
  const params = z.object({});
  it.for([
    [
      'a relative root',
      () => definePrompts('prompts', { A: { file: 'A.md', params } }),
      /must be absolute/u,
    ],
    ['a non-file URL', () => definePrompts(new URL('https://example.com/p'), {}), /file: URL/u],
    [
      'a bad name',
      () => definePrompts('/p', { 'review-x': { file: 'A.md', params } }),
      /identifier/u,
    ],
    [
      'a leading digit',
      () => definePrompts('/p', { '1A': { file: 'A.md', params } }),
      /identifier/u,
    ],
    [
      'a leading underscore',
      () => definePrompts('/p', { _A: { file: 'A.md', params } }),
      /identifier/u,
    ],
    [
      'non-object params',
      () => definePrompts('/p', { A: { file: 'A.md', params: z.string() as never } }),
      /zod 4 object schema/u,
    ],
    [
      'plain-object params',
      () => definePrompts('/p', { A: { file: 'A.md', params: {} as never } }),
      /zod 4 object schema/u,
    ],
    [
      'a non-markdown file',
      () => definePrompts('/p', { A: { file: 'A.txt', params } }),
      /ending in \.md/u,
    ],
    [
      'an escaping file',
      () => definePrompts('/p', { A: { file: '../A.md', params } }),
      /outside the prompt root/u,
    ],
    [
      'an absolute file',
      () => definePrompts('/p', { A: { file: '/p/A.md', params } }),
      /is absolute/u,
    ],
    [
      'a backslashed file',
      () => definePrompts('/p', { A: { file: 'a\\A.md', params } }),
      /backslash/u,
    ],
    [
      'an unknown entry key',
      () => definePrompts('/p', { A: { file: 'A.md', params, descripton: 'x' } as never }),
      /unknown key descripton/u,
    ],
    [
      'an empty description',
      () => definePrompts('/p', { A: { file: 'A.md', params, description: ' ' } }),
      /nonempty string/u,
    ],
    ['a non-object entry', () => definePrompts('/p', { A: 'A.md' as never }), /must be an object/u],
    [
      'a malformed percent escape in a file: root',
      () => definePrompts('file:///tmp/%ZZ', { A: { file: 'A.md', params } }),
      /is not a valid file: URL/u,
    ],
    [
      'an encoded separator in a file: URL root',
      () => definePrompts(new URL('file:///tmp/%2F'), { A: { file: 'A.md', params } }),
      /is not a valid file: URL/u,
    ],
    [
      'a file: root naming a host',
      () => definePrompts('file://host/x', { A: { file: 'A.md', params } }),
      /is not a valid file: URL/u,
    ],
  ] as const)('rejects %s', ([, define, pattern]) => {
    try {
      define();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PromptError);
      expect(error).toMatchObject({ kind: 'InvalidDefinition' });
      expect((error as Error).message).toMatch(pattern);
    }
  });

  it('touches no file until the first render', () => {
    const prompts = definePrompts('/nonexistent/quiet-choir/prompts', {
      A: { file: 'A.md', params: z.object({}), description: 'never read' },
    });
    expect(Object.keys(prompts)).toEqual(['A']);
    expect(Object.isFrozen(prompts)).toBe(true);
    expect(() => prompts.A({})).toThrow(/prompt root .* does not exist/u);
  });
});

describe('Prompt values across module instances (ADR 0028)', () => {
  let second: typeof host;
  beforeAll(async () => {
    vi.resetModules();
    second = await import('../src/index.js');
  });

  it('recognizes a PromptError and a Prompt made by another copy, and treats the error as fatal', () => {
    const error = new second.PromptError('Prompt A (A.md): x', {
      prompt: 'A',
      file: 'A.md',
      kind: 'SyntaxError',
      line: 1,
    });
    expect(error).toBeInstanceOf(PromptError);
    const origins = new FailureOrigins();
    expect(origins.isFatal(error)).toBe(true);
    expect(origins.isFatal(new Error('wrapped', { cause: error }))).toBe(true);
    expect(origins.isFatal(new Error('plain'))).toBe(false);
    const prompt = second.definePrompts(fixtures, entries).Optional({ name: 'x', greeting: 'y' });
    expect(isPrompt(prompt)).toBe(true);
    expect(promptOptionsAsText({ prompt, appendSystemPrompt: prompt, model: 'm' })).toEqual({
      prompt: 'Hello x.\ny',
      appendSystemPrompt: 'Hello x.\ny',
      model: 'm',
    });
  });
});

describe('engine lifetime', () => {
  // The engine's WebAssembly memory is freed explicitly; the loader the engine keeps reaches only the
  // source reader, so it cannot hold a dropped environment alive either.
  const { Environment } = createRequire(import.meta.url)('minijinja-js') as typeof Minijinja;
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('frees a disposed environment and creates a fresh engine on the next render', () => {
    const free = vi.spyOn(Environment.prototype, 'free');
    const environment = createPromptEnvironment(fixtures);
    environment.dispose();
    expect(free).not.toHaveBeenCalled();
    expect(environment.render('Optional.md', { name: 'a', greeting: 'b' })).toBe('Hello a.\nb');
    environment.dispose();
    expect(free).toHaveBeenCalledTimes(1);
    environment.dispose();
    expect(free).toHaveBeenCalledTimes(1);
    expect(environment.render('Optional.md', { name: 'c', greeting: 'd' })).toBe('Hello c.\nd');
    environment.dispose();
    expect(free).toHaveBeenCalledTimes(2);
  });

  it('frees every validation environment and the one-off string environment', () => {
    const free = vi.spyOn(Environment.prototype, 'free');
    const descriptor = promptSetDescriptor(definePrompts(fixtures, entries));
    if (!descriptor) throw new Error('Expected a prompt set descriptor.');
    expect(checkPromptSets([descriptor, descriptor]).errors).toEqual([]);
    expect(free).toHaveBeenCalledTimes(2);
    expect(renderString('{{ 1 + 1 }}', {})).toBe('2');
    expect(() => renderString('{{ missing.key }}', {})).toThrow();
    expect(free).toHaveBeenCalledTimes(4);
  });
});

describe('lazy engine load', () => {
  // A child process, so no other test has loaded the engine. measured: 0.6 s alone, 2.1 s in the
  // full coverage run (tsx startup and the WebAssembly compile dominate).
  it('loads minijinja-js only on the first render', { timeout: 20_000 }, () => {
    const script = [
      "import { createRequire } from 'node:module';",
      `const index = await import(${JSON.stringify(join(repository, 'src/index.ts'))});`,
      `const engine = await import(${JSON.stringify(join(repository, 'src/workflow/prompts/engine.ts'))});`,
      `const require = createRequire(${JSON.stringify(join(repository, 'src/index.ts'))});`,
      "const loaded = () => Object.keys(require.cache).some((key) => key.includes('minijinja-js'));",
      `const prompts = index.definePrompts(${JSON.stringify(fixtures)}, { Optional: { file: 'Optional.md', params: index.z.object({ name: index.z.string(), greeting: index.z.string() }) } });`,
      'const before = [engine.engineLoaded(), loaded()];',
      "const text = prompts.Optional({ name: 'a', greeting: 'b' }).text;",
      'console.log(JSON.stringify({ before, after: [engine.engineLoaded(), loaded()], text }));',
    ].join('\n');
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(JSON.parse(output)).toEqual({
      before: [false, false],
      after: [true, true],
      text: 'Hello a.\nb',
    });
  });
});
