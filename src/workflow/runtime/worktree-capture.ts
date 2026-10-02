// Pure helpers for worktree capture: what setup left behind, which paths `git add` stages, and
// which captured symlinks point outside the repository. No I/O; the caller runs Git.

/**
 * The untracked paths in `git status --porcelain -z` output, in Git's order. Only `??` entries are
 * kept; an untracked directory listed as `dir/` (as `--untracked-files=normal` collapses it) is
 * returned without its trailing slash. @internal
 */
export function untrackedPaths(output: string): string[] {
  const fields = output.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? '';
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    // A rename or copy entry carries its source path in the next field.
    if (status.includes('R') || status.includes('C')) {
      index++;
      continue;
    }
    if (status !== '??') continue;
    const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
    if (trimmed) paths.push(trimmed);
  }
  return paths;
}

/**
 * The NUL-separated pathspec list for `git add --all --pathspec-from-file=- --pathspec-file-nul`:
 * everything (`.`), minus each setup path taken literally and each capture pattern as a glob, all
 * relative to the repository root. Passed on stdin, so the list never meets the argument limit.
 * @internal
 */
export function capturePathspecs(
  setupPaths: readonly string[],
  captureExclude: readonly string[],
): string {
  return [
    '.',
    ...setupPaths.map((path) => `:(exclude,literal,top)${path}`),
    ...captureExclude.map((pattern) => `:(exclude,glob,top)${pattern}`),
  ]
    .map((spec) => `${spec}\0`)
    .join('');
}

/** One entry of `git diff-tree -r -z --no-renames` raw output. @internal */
export interface RawTreeChange {
  /** Mode in the first tree, `000000` when added. */
  readonly oldMode: string;
  /** Mode in the second tree, `120000` for a symlink, `000000` when deleted. */
  readonly newMode: string;
  /** Object ID in the second tree. */
  readonly oid: string;
  /** Single-letter Git status such as A, M, T or D. */
  readonly status: string;
  /** Repository-relative path. */
  readonly path: string;
}

/**
 * Parse `git diff-tree -r -z --no-renames` raw output (`:old new oldOid newOid S\0path\0`).
 * Malformed fields are skipped. @internal
 */
export function rawTreeChanges(output: string): RawTreeChange[] {
  const fields = output.split('\0');
  const changes: RawTreeChange[] = [];
  for (let index = 0; index + 1 < fields.length; index++) {
    const meta = fields[index] ?? '';
    if (!meta.startsWith(':')) continue;
    const [oldMode, newMode, , oid, status] = meta.slice(1).split(' ');
    const path = fields[index + 1] ?? '';
    index++;
    if (!oldMode || !newMode || !oid || !status || !path) continue;
    changes.push({ oldMode, newMode, oid, status: status.slice(0, 1), path });
  }
  return changes;
}

/** Captured symlinks: added, modified or type-changed entries whose new mode is 120000. @internal */
export function capturedSymlinks(changes: readonly RawTreeChange[]): RawTreeChange[] {
  return changes.filter(
    (change) => change.newMode === '120000' && ['A', 'M', 'T'].includes(change.status),
  );
}

/**
 * Whether a symlink at repository-relative `linkPath` with `target` points outside the repository,
 * judged lexically (no filesystem access): an absolute target always does, and a relative one does
 * when its `..` segments climb above the root from the link's directory. @internal
 */
export function symlinkEscapes(linkPath: string, target: string): boolean {
  if (target.startsWith('/') || target.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(target))
    return true;
  const stack = linkPath.split('/').slice(0, -1);
  for (const segment of target.split(/[\\/]/u)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!stack.length) return true;
      stack.pop();
    } else stack.push(segment);
  }
  return false;
}
