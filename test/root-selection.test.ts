import { describe, expect, it } from 'vitest';

import {
  allowedRootEntry,
  blockingLimit,
  rootDecision,
  type RootDecision,
  type RootEntry,
  type RootObservation,
} from '../src/workflow/loader/root-selection.js';

// Project-root removal as a pure table: no XDG directory, walk or rmdir.
const dir = (...segments: string[]): RootEntry => ({ segments, kind: 'directory' });
const file = (...segments: string[]): RootEntry => ({ segments, kind: 'file' });
const other = (...segments: string[]): RootEntry => ({ segments, kind: 'other' });
const namespace = 'run-1-00000000-0000-4000-8000-000000000000';

/** The layout a registered root keeps once its runs are gone. */
const registeredLayout: RootEntry[] = [
  file('project.json'),
  dir('runs'),
  file('runs', '.gitignore'),
  dir('worktrees'),
  dir('worktrees', namespace),
  dir('worktrees', namespace, 'a'.repeat(64)),
];

function observation(overrides: Partial<RootObservation> = {}): RootObservation {
  return { registered: true, keptRuns: [], inUse: [], entries: registeredLayout, ...overrides };
}

const verdict = (decision: RootDecision) => `${decision.kind}:${decision.reason}`;

describe('rootDecision', () => {
  it.each<[string, Partial<RootObservation>, string]>([
    ['a registered root with only its layout', {}, 'remove:missing-cwd'],
    [
      'a registered root with only project.json',
      { entries: [file('project.json')] },
      'remove:missing-cwd',
    ],
    ['an empty unregistered root', { registered: false, entries: [] }, 'remove:empty'],
    [
      'an unregistered root with only empty worktree directories',
      {
        registered: false,
        entries: [dir('worktrees'), dir('worktrees', namespace), dir('worktrees', namespace, 'x')],
      },
      'remove:empty',
    ],
    ['a registered root with a kept run', { keptRuns: ['run-1'] }, 'keep:runs-kept'],
    ['a namespace a held run still names', { inUse: [namespace] }, 'keep:in-use'],
    [
      'an unregistered root with a namespace in use',
      { registered: false, entries: [dir('worktrees')], inUse: [namespace] },
      'keep:in-use',
    ],
    [
      'a file under worktrees/',
      { entries: [...registeredLayout, file('worktrees', namespace, 'x')] },
      'keep:files',
    ],
    [
      'an unknown top-level file',
      { entries: [...registeredLayout, file('.DS_Store')] },
      'keep:files',
    ],
    [
      'an unknown top-level directory',
      { entries: [...registeredLayout, dir('cache')] },
      'keep:files',
    ],
    [
      'an unknown directory under runs/',
      { entries: [...registeredLayout, dir('runs', 'run-2')] },
      'keep:files',
    ],
    [
      'a file under runs/',
      { entries: [...registeredLayout, file('runs', 'run-2.json')] },
      'keep:files',
    ],
    [
      'a directory named .gitignore',
      { entries: [dir('runs'), dir('runs', '.gitignore')] },
      'keep:files',
    ],
    ['a directory named project.json', { entries: [dir('project.json')] }, 'keep:files'],
    ['a symbolic link at the top', { entries: [...registeredLayout, other('link')] }, 'keep:files'],
    [
      'a symbolic link deep in worktrees/',
      { entries: [...registeredLayout, other('worktrees', namespace, 'link')] },
      'keep:files',
    ],
    ['worktrees/ as a symbolic link', { entries: [other('worktrees')] }, 'keep:files'],
    ['a runs/ that is a file', { entries: [file('runs')] }, 'keep:files'],
    [
      'an unregistered root with a file',
      { registered: false, entries: [dir('worktrees'), file('worktrees', 'x')] },
      'keep:files',
    ],
    [
      'an unregistered root with an invalid project.json',
      { registered: false, entries: [file('project.json')] },
      'keep:files',
    ],
    [
      'an unregistered root with runs/',
      { registered: false, entries: [dir('runs')] },
      'keep:files',
    ],
  ])('%s', (_name, overrides, expected) => {
    expect(verdict(rootDecision(observation(overrides)))).toBe(expected);
  });

  it('applies the first matching reason: kept runs, then namespaces in use, then files', () => {
    const everything = observation({
      keptRuns: ['run-1'],
      inUse: [namespace],
      entries: [...registeredLayout, file('stray')],
    });
    expect(verdict(rootDecision(everything))).toBe('keep:runs-kept');
    expect(verdict(rootDecision({ ...everything, keptRuns: [] }))).toBe('keep:in-use');
    expect(verdict(rootDecision({ ...everything, keptRuns: [], inUse: [] }))).toBe('keep:files');
    // An unregistered root's runs/ is never scanned, so kept runs cannot apply to it.
    expect(
      verdict(rootDecision({ registered: false, keptRuns: ['run-1'], inUse: [], entries: [] })),
    ).toBe('remove:empty');
  });

  it('reports the blocking entries, at most the limit', () => {
    const strays = Array.from({ length: blockingLimit + 5 }, (_, index) =>
      file(`stray-${String(index)}`),
    );
    const decision = rootDecision(observation({ entries: [...registeredLayout, ...strays] }));
    expect(decision).toMatchObject({ kind: 'keep', reason: 'files' });
    expect(decision.kind === 'keep' && decision.blocking).toEqual(
      strays.slice(0, blockingLimit).map((entry) => entry.segments),
    );
    expect(rootDecision(observation({ keptRuns: ['b', 'a'] }))).toEqual({
      kind: 'keep',
      reason: 'runs-kept',
      blocking: [
        ['runs', 'b'],
        ['runs', 'a'],
      ],
    });
    expect(rootDecision(observation({ inUse: [namespace] }))).toEqual({
      kind: 'keep',
      reason: 'in-use',
      blocking: [['worktrees', namespace]],
    });
  });

  it('allows only the known layout, by kind', () => {
    for (const entry of registeredLayout) expect(allowedRootEntry(true, entry)).toBe(true);
    expect(allowedRootEntry(false, file('project.json'))).toBe(false);
    expect(allowedRootEntry(false, dir('runs'))).toBe(false);
    expect(allowedRootEntry(false, file('runs', '.gitignore'))).toBe(false);
    expect(allowedRootEntry(false, dir('worktrees', namespace))).toBe(true);
    expect(allowedRootEntry(true, file('runs', '.gitignore', 'x'))).toBe(false);
    expect(allowedRootEntry(true, file('project.json', 'x'))).toBe(false);
  });
});
