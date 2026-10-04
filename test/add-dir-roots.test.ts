// Bounding call-site Claude addDirs by declared profile roots (#171, ADR 0054): pure table tests
// with an injected canonicalizer, plus real temporary symlinks for the filesystem path.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  boundCallAddDirs,
  canonicalPath,
  canonicalRoots,
  hasParentSegment,
  insideRoots,
  within,
} from '../src/workflow/runtime/add-dir-roots.js';

describe('hasParentSegment', () => {
  it.each([
    ['..', true],
    ['../x', true],
    ['a/../b', true],
    ['/root/..', true],
    ['a\\..\\b', true],
    ['..foo', false],
    ['a/..b/c', false],
    ['a/b..', false],
    ['/root/pr-1', false],
    ['.', false],
  ])('%s -> %s', (path, expected) => {
    expect(hasParentSegment(path)).toBe(expected);
  });
});

describe('within', () => {
  it.each([
    ['/root', '/root', true],
    ['/root', '/root/pr-1', true],
    ['/root', '/root/a/b', true],
    ['/root', '/root/..foo', true],
    ['/root', '/root2', false],
    ['/root', '/root2/x', false],
    ['/root', '/', false],
    ['/root/a', '/root', false],
    ['/root', '/other', false],
    ['/', '/anything', true],
  ])('%s contains %s: %s', (root, dir, expected) => {
    expect(within(root, dir)).toBe(expected);
  });
});

// A modeled filesystem: /link -> /outside and /alias -> /real; everything else is literal.
const links: Readonly<Record<string, string>> = { '/r/link': '/outside', '/alias': '/real' };
const modeled = (path: string): string => {
  for (const [from, to] of Object.entries(links))
    if (path === from || path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return path;
};

describe('boundCallAddDirs (modeled filesystem)', () => {
  const bound = (dirs: string[], roots: string[], callCwd = '/work', rootCwd = '/work') =>
    boundCallAddDirs({ profile: 'reader', dirs, roots, callCwd, rootCwd, canonical: modeled });

  it.each([
    ['an equal path', ['/r'], ['/r'], ['/r']],
    ['a nested path', ['/r/pr-1'], ['/r'], ['/r/pr-1']],
    ['a relative call path against callCwd', ['pr-1'], ['/r'], ['/r/pr-1'], '/r'],
    ['a relative root against rootCwd', ['/work/runs/pr-1'], ['runs'], ['/work/runs/pr-1']],
    ['a root that is itself a symlink', ['/real/x'], ['/alias'], ['/real/x']],
    ['a call path through the root symlink', ['/alias/x'], ['/alias'], ['/real/x']],
    ['the second of two roots', ['/s/x'], ['/r', '/s'], ['/s/x']],
  ])('accepts %s', (_label, dirs, roots, expected, callCwd = '/work') => {
    expect(bound(dirs, roots, callCwd)).toEqual(expected);
  });

  it.each([
    ['a .. escape', ['/r/../outside'], "has a '..' segment"],
    ['a .. inside the root', ['/r/a/../b'], "has a '..' segment"],
    ['a relative .. escape', ['../outside'], "has a '..' segment"],
    ['an absolute path outside', ['/outside'], '(canonical /outside) is outside'],
    ['a sibling prefix', ['/r2/x'], '(canonical /r2/x) is outside'],
    ['a symlink out of the root', ['/r/link'], '(canonical /outside) is outside'],
    ['a path below a symlink out of the root', ['/r/link/sub'], '(canonical /outside/sub)'],
    ['a relative path resolving outside', ['elsewhere'], '(canonical /work/elsewhere)'],
  ])('rejects %s, naming the path, the profile and the roots', (_label, dirs, text) => {
    expect(() => bound(dirs, ['/r'])).toThrow(text);
    expect(() => bound(dirs, ['/r'])).toThrow(JSON.stringify(dirs[0]));
    expect(() => bound(dirs, ['/r'])).toThrow('Profile reader claude.addDirRoots ["/r"]');
  });

  it('rejects the whole call when any entry is outside', () => {
    expect(() => bound(['/r/ok', '/outside'], ['/r'])).toThrow('"/outside"');
  });

  it('reports a root that cannot be resolved', () => {
    const failing = (path: string): string => {
      if (path === '/r') throw new Error('boom');
      return path;
    };
    expect(() =>
      boundCallAddDirs({
        profile: 'reader',
        dirs: ['/r/x'],
        roots: ['/r'],
        callCwd: '/',
        rootCwd: '/',
        canonical: failing,
      }),
    ).toThrow('Profile reader claude.addDirRoots: cannot resolve a root: boom');
  });

  it('checks containment of an absolute directory for child delegation', () => {
    expect(insideRoots('/r/pr-1', ['/r'], '/', modeled)).toBe(true);
    expect(insideRoots('/r/link/x', ['/r'], '/', modeled)).toBe(false);
    expect(insideRoots('/r/a/../b', ['/r'], '/', modeled)).toBe(false);
    expect(canonicalRoots(['runs', '/alias'], '/work', modeled)).toEqual(['/work/runs', '/real']);
  });
});

describe('canonicalPath and boundCallAddDirs (real filesystem)', () => {
  let base: string;
  let root: string;
  let outside: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'choir-add-dir-roots-'));
    root = join(base, 'root');
    outside = join(base, 'outside');
    mkdirSync(join(root, 'existing'), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'link'));
    symlinkSync(root, join(base, 'alias'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const real = () => realpathSync.native(root);

  it('resolves existing paths, nonexistent tails and symlinked ancestors', () => {
    // macOS tmpdir is a /var -> /private/var symlink; both sides canonicalize to the real path.
    expect(canonicalPath(join(root, 'existing'))).toBe(join(real(), 'existing'));
    expect(canonicalPath(join(root, 'missing', 'deeper'))).toBe(join(real(), 'missing', 'deeper'));
    expect(canonicalPath(join(root, 'link', 'later'))).toBe(
      join(realpathSync.native(outside), 'later'),
    );
    expect(canonicalPath(join(base, 'alias', 'x'))).toBe(join(real(), 'x'));
  });

  it('refuses a dangling symlink, whose target could later appear outside the root', () => {
    symlinkSync(join(outside, 'not-yet'), join(root, 'dangling'));
    expect(() => canonicalPath(join(root, 'dangling', 'x'))).toThrow(
      'is a symbolic link whose target does not exist',
    );
    expect(() =>
      boundCallAddDirs({
        profile: 'reader',
        dirs: [join(root, 'dangling')],
        roots: [root],
        callCwd: base,
        rootCwd: base,
      }),
    ).toThrow('cannot be resolved within Profile reader claude.addDirRoots');
  });

  it('accepts present and absent directories inside a root and rejects a symlink out of it', () => {
    const bound = (dirs: string[], roots = [root]) =>
      boundCallAddDirs({ profile: 'reader', dirs, roots, callCwd: base, rootCwd: base });
    expect(bound([join(root, 'existing'), join(root, 'pr-1')])).toEqual([
      join(real(), 'existing'),
      join(real(), 'pr-1'),
    ]);
    expect(bound(['root/pr-2'])).toEqual([join(real(), 'pr-2')]);
    expect(bound([join(root, 'pr-3')], ['alias'])).toEqual([join(real(), 'pr-3')]);
    expect(() => bound([join(root, 'link')])).toThrow('is outside');
    expect(() => bound([join(root, 'link', 'sub')])).toThrow('is outside');
    expect(() => bound([outside])).toThrow('is outside');
    expect(() => bound(['outside'])).toThrow('is outside');
  });
});
