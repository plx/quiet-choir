// Bounded call-site Claude directories under strict profiles (#171, ADR 0054). A profile declares
// claude.addDirRoots; a call's addDirs entry is accepted only when its canonical path equals or
// sits inside a canonical root. Kept free of the run store and the profile resolver so it can be
// table-tested with an injected canonicalizer.
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Canonicalize an absolute path; injectable so table tests can model a filesystem. @internal */
export type Canonicalize = (path: string) => string;

/**
 * The real path of the deepest existing ancestor of an absolute path, followed by the remaining
 * nonexistent segments, so a directory a later step creates can still be named while an existing
 * symlink is followed. A dangling symlink on the path is an error: its target could be created
 * outside a root later. Other filesystem errors, such as a symlink loop, are thrown. @internal
 */
export function canonicalPath(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw cause;
      if (exists(current))
        throw new Error(`${current} is a symbolic link whose target does not exist.`, { cause });
      const parent = dirname(current);
      if (parent === current) throw cause;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether a path names a `..` segment, in either separator style. @internal */
export function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]/u).includes('..');
}

/** Whether an absolute directory equals or sits inside an absolute root. @internal */
export function within(root: string, dir: string): boolean {
  const rel = relative(root, dir);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Declared roots resolved against the run's working directory, then canonicalized. @internal */
export function canonicalRoots(
  roots: readonly string[],
  rootCwd: string,
  canonical: Canonicalize = canonicalPath,
): string[] {
  return roots.map((root) => canonical(resolve(rootCwd, root)));
}

/** Whether an absolute directory's canonical form lies inside one of the canonical roots. @internal */
export function insideRoots(
  dir: string,
  roots: readonly string[],
  rootCwd: string,
  canonical: Canonicalize = canonicalPath,
): boolean {
  if (hasParentSegment(dir)) return false;
  const target = canonical(dir);
  return canonicalRoots(roots, rootCwd, canonical).some((root) => within(root, target));
}

/**
 * Check call-site `addDirs` against a profile's declared roots and return their canonical absolute
 * paths, in order. A `..` segment is refused before resolution, because a lexical normalize would
 * hide a symlink escape. Entries resolve against the call's working directory and roots against the
 * run's; both sides are canonicalized. Errors name the entry, its canonical form, the profile and
 * the canonical roots. @internal
 */
export function boundCallAddDirs(input: {
  readonly profile: string;
  readonly dirs: readonly string[];
  readonly roots: readonly string[];
  readonly callCwd: string;
  readonly rootCwd: string;
  readonly canonical?: Canonicalize;
}): string[] {
  const canonical = input.canonical ?? canonicalPath;
  const where = `Profile ${input.profile} claude.addDirRoots`;
  let roots: string[];
  try {
    roots = canonicalRoots(input.roots, input.rootCwd, canonical);
  } catch (cause) {
    throw new Error(`${where}: cannot resolve a root: ${message(cause)}`, { cause });
  }
  const listed = JSON.stringify(roots);
  return input.dirs.map((dir) => {
    if (hasParentSegment(dir))
      throw new Error(
        `Call-site addDirs entry ${JSON.stringify(dir)} has a '..' segment; ${where} ${listed} admit only paths without '..'.`,
      );
    let target: string;
    try {
      target = canonical(resolve(input.callCwd, dir));
    } catch (cause) {
      throw new Error(
        `Call-site addDirs entry ${JSON.stringify(dir)} cannot be resolved within ${where} ${listed}: ${message(cause)}`,
        { cause },
      );
    }
    if (!roots.some((root) => within(root, target)))
      throw new Error(
        `Call-site addDirs entry ${JSON.stringify(dir)} (canonical ${target}) is outside ${where} ${listed}.`,
      );
    return target;
  });
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
