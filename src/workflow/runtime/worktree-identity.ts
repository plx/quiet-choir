import type { JsonValue } from './model.js';
import { resolveWorktree } from './worktree-schema.js';

/**
 * Logical isolation identity never includes a disposable checkout path. Every accepted spelling of a
 * checkout selection, legacy ones included, normalizes to the same identity. @internal
 */
export function isolationIdentity(value: unknown): JsonValue {
  const worktree = resolveWorktree(value);
  if ('id' in worktree) return { id: worktree.id, base: worktree.base };
  return { kind: 'worktree', base: worktree.base ?? 'HEAD' };
}
