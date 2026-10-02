import type { WorktreePolicy } from './worktree-model.js';

// The one validator of worktree policy, shared by `RunOptions.worktrees`, a definition's `worktrees`
// field and the CLI's worktree flags. Pure: no I/O, and no run store import, because model files
// that workflow type checks load must stay free of the store (#287).

/** The accepted cache retention modes. @internal */
export const worktreeKeepModes = ['all', 'failed', 'none'] as const;

/** Throw unless `value` is a keep mode; `label` names the field or flag. @internal */
export function checkWorktreeKeep(
  value: unknown,
  label: string,
): asserts value is WorktreePolicy['keep'] & string {
  if (typeof value !== 'string' || !(worktreeKeepModes as readonly string[]).includes(value))
    throw new Error(`${label} must be all, failed, or none.`);
}

/** Throw unless `value` is a nonempty path without NUL; `label` names the field or flag. @internal */
export function checkWorktreeRoot(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new Error(`${label} must be a nonempty path.`);
}

/**
 * Validate a worktree policy object and return it typed. Unknown fields are left alone, as they
 * always were for `RunOptions.worktrees`. `label` prefixes every message, e.g. `worktrees`. @internal
 */
export function checkWorktreePolicy(value: unknown, label = 'worktrees'): WorktreePolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  const policy = value as Record<string, unknown>;
  if (policy['keep'] !== undefined) checkWorktreeKeep(policy['keep'], `${label}.keep`);
  if (policy['root'] !== undefined) checkWorktreeRoot(policy['root'], `${label}.root`);
  if (policy['setup'] !== undefined && typeof policy['setup'] !== 'function')
    throw new Error(`${label}.setup must be a function.`);
  const exclude = policy['captureExclude'];
  if (
    exclude !== undefined &&
    (!Array.isArray(exclude) ||
      !exclude.every(
        (pattern: unknown) => typeof pattern === 'string' && !!pattern && !pattern.includes('\0'),
      ))
  )
    throw new Error(`${label}.captureExclude must be an array of nonempty patterns without NUL.`);
  return value;
}

/**
 * The policy a run uses: the root definition's fields, each replaced by the options' field of the
 * same name when that one is not undefined. Neither input is modified. @internal
 */
export function effectiveWorktreePolicy(
  definition: WorktreePolicy | undefined,
  options: WorktreePolicy | undefined,
): WorktreePolicy {
  const merged: Record<string, unknown> = { ...definition };
  for (const [key, value] of Object.entries(options ?? {}))
    if (value !== undefined) merged[key] = value;
  return merged;
}
