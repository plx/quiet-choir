// Load-time prompt checks (ADR 0064 section 3, #581): checkPromptSets on temporary template roots.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { definePrompts, z } from '../src/index.js';
import { checkPromptSets, promptRootFiles } from '../src/workflow/prompts/check.js';
import { promptSetDescriptor } from '../src/workflow/prompts/prompt.js';
import { scanTemplate } from '../src/workflow/prompts/scan.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function root(files: Readonly<Record<string, string>>): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'choir-prompt-check-'));
  directories.push(parent);
  await writeFile(join(parent, 'outside.md'), 'outside');
  const directory = join(parent, 'prompts');
  await mkdir(directory);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), text);
  }
  return directory;
}
/** Check one entry `Main` over `Main.md` with `params`. */
async function check(
  files: Readonly<Record<string, string>>,
  params: z.ZodObject = z.object({}),
  description?: string,
) {
  const directory = await root(files);
  const set = definePrompts(directory, {
    Main: { file: 'Main.md', params, ...(description === undefined ? {} : { description }) },
  });
  const descriptor = promptSetDescriptor(set);
  if (!descriptor) throw new Error('Expected a prompt set descriptor.');
  const result = checkPromptSets([descriptor]);
  return { directory, ...result, entry: result.sets[0]?.entries[0] };
}

describe('checkPromptSets errors', () => {
  it.for([
    [
      'an undeclared variable',
      { 'Main.md': 'Hi {{ name }} and {{ nmae }}' },
      z.object({ name: z.string() }),
      'Prompt Main (Main.md): reads variable nmae, which its params schema does not declare',
    ],
    [
      'a nested path missing from a plain object schema',
      { 'Main.md': '{{ issue.number }} {{ issue.titel }}' },
      z.object({ issue: z.object({ number: z.number(), title: z.string() }).optional() }),
      'Prompt Main (Main.md): reads issue.titel, which its params schema does not declare',
    ],
    [
      'a computed include',
      { 'Main.md': 'a\n{% include name %}' },
      z.object({ name: z.string() }),
      'Prompt Main (Main.md): Main.md:2: {% include name %} has a computed or list target',
    ],
    [
      'a list include',
      { 'Main.md': '{% include ["a.md", "b.md"] %}', 'a.md': '' },
      z.object({}),
      '{% include ["a.md", "b.md"] %} has a computed or list target',
    ],
    [
      'a concatenated include',
      { 'Main.md': '{% include "a" ~ ".md" %}', 'a.md': '' },
      z.object({}),
      'must have exactly one string literal target',
    ],
    [
      'ignore missing',
      { 'Main.md': '{%- include "a.md" ignore missing -%}', 'a.md': '' },
      z.object({}),
      'Main.md:1: {% include "a.md" ignore missing %} uses ignore missing',
    ],
    [
      'an include that escapes the root',
      { 'Main.md': '{% include "../outside.md" %}' },
      z.object({}),
      'Main.md:1: include target "../outside.md" resolves outside the prompt root',
    ],
    [
      'an absolute extends target',
      { 'Main.md': '{% extends "/etc/base.md" %}' },
      z.object({}),
      'extends target "/etc/base.md" is absolute',
    ],
    [
      'a missing include',
      { 'Main.md': '{% include "_fragments/none.md" %}' },
      z.object({}),
      'Main.md:1: include target "_fragments/none.md" (_fragments/none.md) does not exist',
    ],
    [
      'the random filter',
      { 'Main.md': '{{ items | random }}' },
      z.object({ items: z.array(z.string()) }),
      'Main.md:1: {{ items | random }} uses the random filter',
    ],
    [
      'a random filter block',
      { 'Main.md': '{% filter random %}ab{% endfilter %}' },
      z.object({}),
      'uses the random filter',
    ],
    [
      'randrange',
      { 'Main.md': 'x\n\n{{ randrange(10) }}' },
      z.object({}),
      'Main.md:3: {{ randrange(10) }} names randrange',
    ],
    [
      'lipsum',
      { 'Main.md': '{% set filler = lipsum(2) %}{{ filler }}' },
      z.object({}),
      'names lipsum',
    ],
    [
      'lipsum in a fragment',
      { 'Main.md': '{% include "_fragments/a.md" %}', '_fragments/a.md': '\n{{ lipsum() }}' },
      z.object({}),
      'Prompt Main (Main.md): _fragments/a.md:2: {{ lipsum() }} names lipsum',
    ],
    [
      'a bad front matter key',
      { 'Main.md': '---\ntitle: Main\n---\nbody' },
      z.object({}),
      'Prompt Main (Main.md): Main.md:2: front matter may hold only a description key',
    ],
    [
      'an unparsable fragment',
      { 'Main.md': '{% include "_fragments/a.md" %}', '_fragments/a.md': 'ok\n{% for %}' },
      z.object({}),
      'syntax error',
    ],
    ['a missing entry file', {}, z.object({}), 'template file Main.md does not exist under'],
    ['a syntax error', { 'Main.md': '{{ a +  }}' }, z.object({}), 'Prompt Main (Main.md): '],
  ] as const)('reports %s', async ([, files, params, message]) => {
    const { errors } = await check(files, params);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining(message)]));
  });

  it('refuses a symlinked fragment that leaves the root', async () => {
    const directory = await root({ 'Main.md': '{% include "_fragments/link.md" %}' });
    await mkdir(join(directory, '_fragments'));
    await symlink(join(directory, '..', 'outside.md'), join(directory, '_fragments', 'link.md'));
    const descriptor = promptSetDescriptor(
      definePrompts(directory, { Main: { file: 'Main.md', params: z.object({}) } }),
    );
    if (!descriptor) throw new Error('Expected a descriptor.');
    expect(checkPromptSets([descriptor]).errors).toEqual([
      expect.stringMatching(
        /^Prompt Main \(Main\.md\): _fragments\/link\.md: .*outside the prompt root/u,
      ),
    ]);
  });

  it('aggregates every error of every entry and set', async () => {
    const first = await root({ 'A.md': '{{ a }}', 'B.md': '{{ b | random }}' });
    const second = await root({ 'C.md': '{% include x %}' });
    const sets = [
      definePrompts(first, {
        A: { file: 'A.md', params: z.object({}) },
        B: { file: 'B.md', params: z.object({ b: z.string() }) },
      }),
      definePrompts(second, { C: { file: 'C.md', params: z.object({ x: z.string() }) } }),
    ].map((set) => promptSetDescriptor(set));
    if (sets.some((set) => set === undefined)) throw new Error('Expected descriptors.');
    const { errors } = checkPromptSets(sets as never);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/^Prompt A \(A\.md\): reads variable a/u);
    expect(errors[1]).toMatch(/^Prompt B \(B\.md\): B\.md:1: .* random/u);
    expect(errors[2]).toMatch(/^Prompt C \(C\.md\): C\.md:1: .*computed/u);
  });
});

describe('checkPromptSets results', () => {
  it('reports variables and description, and warns on an unused key but not one a fragment reads', async () => {
    const { errors, entry } = await check(
      {
        'Main.md':
          '---\ndescription: From front matter\n---\n# {{ title }}\n{% for thread in threads %}{% include "_fragments/thread.md" %}{% endfor %}',
        // The fragment reads its includer's loop variable and a key the entry never names.
        '_fragments/thread.md': '- {{ thread.body }} ({{ footer }})',
      },
      z.object({
        title: z.string(),
        threads: z.array(z.object({ body: z.string() })),
        footer: z.string(),
        unused: z.number().optional(),
      }),
    );
    expect(errors).toEqual([]);
    expect(entry).toEqual({
      name: 'Main',
      file: 'Main.md',
      description: 'From front matter',
      variables: ['threads', 'title'],
      warnings: [
        'Prompt Main (Main.md): parameter unused is never read by the template or its includes',
      ],
    });
  });

  it('prefers the entry description, and counts an extends parent but not an imported macro', async () => {
    const { errors, entry } = await check(
      {
        'Main.md':
          '---\ndescription: ignored\n---\n{% extends "_fragments/base.md" %}{% block body %}{{ body }}{% endblock %}',
        '_fragments/base.md':
          '{% from "macros.md" import shout %}{{ heading }}\n{% block body %}{% endblock %}{{ shout(heading) }}',
        '_fragments/macros.md':
          '{% macro shout(text) %}{{ text | upper }}{{ macroOnly }}{% endmacro %}',
      },
      z.object({ body: z.string(), heading: z.string(), macroOnly: z.string() }),
      'From the entry',
    );
    expect(errors).toEqual([]);
    expect(entry?.description).toBe('From the entry');
    expect(entry?.warnings).toEqual([
      'Prompt Main (Main.md): parameter macroOnly is never read by the template or its includes',
    ]);
  });

  it('accepts engine globals, loop variables, prose about random, and tags inside comments and raw blocks', async () => {
    const { errors, entry } = await check(
      {
        'Main.md': [
          'Pick a random reviewer; randrange and lipsum are only words here.',
          '{# {% include name %} {{ x | random }} #}',
          '{% raw %}{% include computed %}{{ lipsum() }}{% endraw %}',
          '{%- raw -%} {% extends x %} {%- endraw -%}',
          '{% for i in range(3) %}{{ loop.index }}{% endfor %}{{ dict(a=1) | tojson }}',
          '{{ "a | random" }}{% set ns = namespace(n=0) %}{{ ns.n }}',
          '{{ issue.labels[0].name }}{{ meta.anything }}{{ open.whatever }}',
        ].join('\n'),
      },
      z.object({
        issue: z.object({ labels: z.array(z.object({ name: z.string() })) }),
        meta: z.record(z.string(), z.string()),
        open: z.object({}).loose(),
      }),
    );
    expect(errors).toEqual([]);
    expect(entry?.variables).toEqual(['issue', 'meta', 'open']);
  });

  it('accepts literal include, import and from forms with context clauses', async () => {
    const { errors } = await check(
      {
        'Main.md': [
          '{%- include "_fragments/a.md" -%}',
          "{% include '_fragments/a.md' without context %}",
          '{% import "_fragments/m.md" as m with context %}',
          '{% from "_fragments/m.md" import hello as hi, other %}',
          '{{ m.hello() }}{{ hi() }}{{ other() }}',
        ].join('\n'),
        '_fragments/a.md': 'a',
        '_fragments/m.md': '{% macro hello() %}h{% endmacro %}{% macro other() %}o{% endmacro %}',
      },
      z.object({}),
    );
    expect(errors).toEqual([]);
  });
});

describe('scanTemplate', () => {
  it('honors whitespace markers, quoted delimiters and line numbers', () => {
    expect(
      scanTemplate(
        'a\n{%- include "x.md" -%}\n{{ "%}" }}{%+ extends \'y.md\' +%}\n{% set s = "{% include z %}" %}',
      ),
    ).toEqual({
      dependencies: [
        { keyword: 'include', target: 'x.md', line: 2 },
        { keyword: 'extends', target: 'y.md', line: 3 },
      ],
      problems: [],
    });
  });

  it('flags a dependency tag with anything computed after its literal', () => {
    expect(scanTemplate('{% import "m.md" %}').problems).toEqual([
      {
        line: 1,
        message:
          '{% import "m.md" %} must have exactly one string literal target, with nothing computed after it',
      },
    ]);
    expect(scanTemplate('{% extends "a.md" if x else "b.md" %}').problems).toHaveLength(1);
  });
});

describe('promptRootFiles', () => {
  it('lists every regular file sorted, without following directory symlinks', async () => {
    const directory = await root({
      'B.md': 'b',
      'A.md': 'a',
      '_fragments/c.md': 'c',
      'notes.txt': 'n',
    });
    await symlink(join(directory, '_fragments'), join(directory, 'linked'));
    expect(promptRootFiles(directory)).toEqual(
      ['A.md', 'B.md', 'notes.txt', '_fragments/c.md'].map((name) => join(directory, name)).sort(),
    );
    expect(promptRootFiles(join(directory, 'missing'))).toEqual([]);
  });
});
