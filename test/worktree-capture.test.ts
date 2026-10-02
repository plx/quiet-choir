import { describe, expect, it } from 'vitest';
import {
  capturePathspecs,
  capturedSymlinks,
  rawTreeChanges,
  symlinkEscapes,
  untrackedPaths,
} from '../src/workflow/runtime/worktree-capture.js';

const oid = 'a'.repeat(40);
const zero = '0'.repeat(40);

describe('untrackedPaths', () => {
  it.each([
    ['nothing', '', []],
    ['a file', '?? node_modules\0', ['node_modules']],
    ['a collapsed directory without its slash', '?? deps/\0?? a.txt\0', ['deps', 'a.txt']],
    ['names with spaces and newlines', '?? my file\0?? line\nbreak\0', ['my file', 'line\nbreak']],
    ['non-untracked entries ignored', ' M file.txt\0A  new.ts\0?? setup.out\0', ['setup.out']],
    ['a rename source field skipped', 'R  renamed.txt\0original.txt\0?? x\0', ['x']],
    ['a missing trailing NUL', '?? last', ['last']],
  ])('%s', (_label, output, expected) => {
    expect(untrackedPaths(output)).toEqual(expected);
  });
});

describe('capturePathspecs', () => {
  it.each([
    ['everything', [], [], '.\0'],
    [
      'literal setup paths',
      ['node_modules', 'a*b'],
      [],
      '.\0:(exclude,literal,top)node_modules\0:(exclude,literal,top)a*b\0',
    ],
    [
      'glob patterns after setup paths',
      ['deps'],
      ['**/*.log', 'tmp/**'],
      '.\0:(exclude,literal,top)deps\0:(exclude,glob,top)**/*.log\0:(exclude,glob,top)tmp/**\0',
    ],
  ])('%s', (_label, setup, patterns, expected) => {
    expect(capturePathspecs(setup, patterns)).toBe(expected);
  });
});

describe('rawTreeChanges and capturedSymlinks', () => {
  const output = [
    `:000000 120000 ${zero} ${oid} A`,
    'link',
    `:100644 100644 ${oid} ${oid} M`,
    'src/b.ts',
    `:100644 120000 ${oid} ${oid} T`,
    'became link',
    `:120000 120000 ${oid} ${oid} M`,
    'dir/moved link',
    `:120000 000000 ${oid} ${zero} D`,
    'gone',
    '',
  ].join('\0');

  it('parses modes, status and paths', () => {
    expect(rawTreeChanges(output)).toEqual([
      { oldMode: '000000', newMode: '120000', oid, status: 'A', path: 'link' },
      { oldMode: '100644', newMode: '100644', oid, status: 'M', path: 'src/b.ts' },
      { oldMode: '100644', newMode: '120000', oid, status: 'T', path: 'became link' },
      { oldMode: '120000', newMode: '120000', oid, status: 'M', path: 'dir/moved link' },
      { oldMode: '120000', newMode: '000000', oid: zero, status: 'D', path: 'gone' },
    ]);
  });

  it('keeps added, modified and type-changed symlinks only', () => {
    expect(capturedSymlinks(rawTreeChanges(output)).map(({ path }) => path)).toEqual([
      'link',
      'became link',
      'dir/moved link',
    ]);
  });

  it('skips malformed fields', () => {
    expect(rawTreeChanges('garbage\0:1 2\0path\0')).toEqual([]);
  });
});

describe('symlinkEscapes', () => {
  it.each([
    ['an absolute target', 'link', '/tmp/elsewhere', true],
    ['a Windows drive target', 'link', 'C:\\deps', true],
    ['a parent of a top-level link', 'link', '../outside', true],
    ['climbing out from a nested link', 'a/b/link', '../../../x', true],
    ['two levels up from a one-level link', 'a/rel', '../../outside', true],
    ['a sibling', 'link', 'file.txt', false],
    ['a dot target', 'link', '.', false],
    ['the root from a nested link', 'a/b/link', '../../file', false],
    ['within a nested directory', 'a/link', '../b/./c', false],
    ['down then up inside', 'link', 'x/../y', false],
    ['an empty target', 'link', '', false],
  ])('%s', (_label, link, target, expected) => {
    expect(symlinkEscapes(link, target)).toBe(expected);
  });
});
