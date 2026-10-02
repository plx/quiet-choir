import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkedDefinition } from '../src/workflow/runtime/definition.js';
import {
  checkWorktreePolicy,
  effectiveWorktreePolicy,
} from '../src/workflow/runtime/worktree-policy.js';
import type { WorktreePolicy } from '../src/index.js';

const setup = () => undefined;
const other = () => undefined;

describe('checkWorktreePolicy', () => {
  it.each([
    ['a non-object', 'all', 'worktrees must be an object.'],
    ['an array', [], 'worktrees must be an object.'],
    ['an unknown keep', { keep: 'some' }, 'worktrees.keep must be all, failed, or none.'],
    ['a numeric keep', { keep: 1 }, 'worktrees.keep must be all, failed, or none.'],
    ['an empty root', { root: '' }, 'worktrees.root must be a nonempty path.'],
    ['a NUL root', { root: 'a\0b' }, 'worktrees.root must be a nonempty path.'],
    ['a numeric root', { root: 7 }, 'worktrees.root must be a nonempty path.'],
    ['a non-function setup', { setup: 'npm ci' }, 'worktrees.setup must be a function.'],
    [
      'a string captureExclude',
      { captureExclude: '*.log' },
      'worktrees.captureExclude must be an array of nonempty patterns without NUL.',
    ],
    [
      'a non-string pattern',
      { captureExclude: ['*.log', 3] },
      'worktrees.captureExclude must be an array of nonempty patterns without NUL.',
    ],
    [
      'an empty pattern',
      { captureExclude: [''] },
      'worktrees.captureExclude must be an array of nonempty patterns without NUL.',
    ],
    [
      'a NUL pattern',
      { captureExclude: ['a\0'] },
      'worktrees.captureExclude must be an array of nonempty patterns without NUL.',
    ],
  ])('rejects %s', (_label, value, message) => {
    expect(() => checkWorktreePolicy(value)).toThrow(message);
  });

  it.each([
    ['an empty policy', {}],
    ['every field', { keep: 'all', root: '/tmp/x', setup, captureExclude: ['**/*.log', 'tmp/**'] }],
    ['a relative root', { root: 'caches' }],
    ['each keep mode', { keep: 'none' }],
    ['an empty captureExclude', { captureExclude: [] }],
  ])('accepts %s', (_label, value) => {
    expect(checkWorktreePolicy(value)).toBe(value);
  });

  it('prefixes messages with the label', () => {
    expect(() => checkWorktreePolicy({ keep: 'x' }, 'Workflow w worktrees')).toThrow(
      'Workflow w worktrees.keep must be all, failed, or none.',
    );
  });
});

describe('effectiveWorktreePolicy', () => {
  const cases: [string, WorktreePolicy | undefined, WorktreePolicy | undefined, WorktreePolicy][] =
    [
      ['neither', undefined, undefined, {}],
      ['definition only', { keep: 'all', setup }, undefined, { keep: 'all', setup }],
      ['options only', undefined, { root: '/r' }, { root: '/r' }],
      [
        'field by field',
        { keep: 'all', setup, captureExclude: ['a'] },
        { setup: other, root: '/r' },
        { keep: 'all', setup: other, captureExclude: ['a'], root: '/r' },
      ],
      [
        'undefined option fields keep the definition',
        { keep: 'all', root: '/d' },
        // A JavaScript caller can pass explicit undefined, which exact optional types forbid.
        { keep: undefined, root: undefined, captureExclude: ['b'] } as unknown as WorktreePolicy,
        { keep: 'all', root: '/d', captureExclude: ['b'] },
      ],
    ];
  it.each(cases)('%s', (_label, definition, options, expected) => {
    expect(effectiveWorktreePolicy(definition, options)).toEqual(expected);
  });

  it('does not modify its inputs', () => {
    const definition: WorktreePolicy = { keep: 'all' };
    effectiveWorktreePolicy(definition, { keep: 'none' });
    expect(definition).toEqual({ keep: 'all' });
  });
});

describe('definition-level worktrees', () => {
  const base = {
    name: 'w',
    version: '1',
    input: z.null(),
    output: z.null(),
    run: () => Promise.resolve(null),
  };
  it.each([
    [
      'a bad keep',
      { keep: 'sometimes' },
      'Workflow w worktrees.keep must be all, failed, or none.',
    ],
    ['an empty root', { root: '' }, 'Workflow w worktrees.root must be a nonempty path.'],
    ['a non-function setup', { setup: true }, 'Workflow w worktrees.setup must be a function.'],
    [
      'a non-string captureExclude entry',
      { captureExclude: [1] },
      'Workflow w worktrees.captureExclude must be an array of nonempty patterns without NUL.',
    ],
    ['a non-object', 'all', 'Workflow w worktrees must be an object.'],
  ])('rejects %s at load', (_label, worktrees, message) => {
    expect(() => checkedDefinition({ ...base, worktrees })).toThrow(message);
  });

  it('accepts a valid declaration and an absent one', () => {
    expect(() =>
      checkedDefinition({ ...base, worktrees: { keep: 'all', setup, captureExclude: ['*.log'] } }),
    ).not.toThrow();
    expect(() => checkedDefinition(base)).not.toThrow();
  });
});
