import type { JsonValue } from './model.js';
import type { WorktreeIsolation } from './worktree-model.js';
import { worktreeIsolationSchema } from './worktree-schema.js';

/** Logical isolation identity never includes a disposable checkout path. @internal */
export function isolationIdentity(value: WorktreeIsolation): JsonValue {
  const isolation = worktreeIsolationSchema.parse(value);
  if (typeof isolation === 'object' && 'id' in isolation)
    return { id: isolation.id, base: isolation.base };
  return {
    kind: 'worktree',
    base: typeof isolation === 'string' ? 'HEAD' : (isolation.base ?? 'HEAD'),
  };
}
