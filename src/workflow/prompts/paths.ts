import { posix } from 'node:path';

// ADR 0064 section 1: template names are POSIX paths relative to the prompt root, and include,
// extends and import targets resolve relative to the including file. The renderer's path-join
// callback, its loader and the load-time checks all use these two functions, so they cannot
// disagree about where a target points.

/**
 * The root-relative name a target written in `parent` refers to. An absolute target, or one with a
 * backslash or NUL, is returned unchanged for {@link templateNameProblem} to refuse, since the
 * engine falls back to the raw target when its join callback throws. @internal
 */
export function joinTemplateName(target: string, parent: string): string {
  if (target.startsWith('/') || target.includes('\\') || target.includes('\0')) return target;
  return posix.normalize(posix.join(posix.dirname(parent), target));
}

/**
 * Why `name` cannot name a template under the root, or null when it can: an empty, absolute,
 * backslashed or NUL-containing name, or one that normalizes to the root itself or outside it.
 * @internal
 */
export function templateNameProblem(name: string): string | null {
  if (name === '') return 'is empty';
  if (name.includes('\0')) return 'contains a NUL character';
  if (name.includes('\\')) return 'contains a backslash; template paths use / separators';
  if (posix.isAbsolute(name) || /^[A-Za-z]:/u.test(name))
    return 'is absolute; template paths are relative to the prompt root';
  const normalized = posix.normalize(name);
  if (normalized === '..' || normalized.startsWith('../'))
    return 'resolves outside the prompt root';
  if (normalized === '.' || normalized.endsWith('/')) return 'names a directory';
  return null;
}
