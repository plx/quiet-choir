import { z } from 'zod';
import type { WorktreeCreateOptions, WorktreeHandle } from './worktree-model.js';
import { legacyWorktreeIsolationSchema, worktreeSelectionSchema } from './worktree-schema.js';

/** Native configuration loading policy, independent of Git checkout and OS sandbox selection. */
export type HarnessIsolation = 'restricted' | 'inherit';
/**
 * Agent checkout selection: `true` creates a fresh detached worktree from HEAD for each attempt,
 * `{ base }` pins another ref or commit for those fresh checkouts, and a `ctx.worktree` handle
 * serializes the call on that shared checkout.
 */
export type AgentWorktree = true | WorktreeCreateOptions | WorktreeHandle;

/** Configuration mode validator. @internal */
export const harnessIsolationSchema = z.enum(['restricted', 'inherit']);
/**
 * Call-site isolation validator: a configuration mode, or a pre-#340 worktree selection that still
 * runs for compatibility. @internal
 */
export const agentIsolationSchema = z.union([
  harnessIsolationSchema,
  legacyWorktreeIsolationSchema,
]);
/** Checkout selection validator, accepting the pre-#340 spellings for compatibility. @internal */
export const agentWorktreeSchema = worktreeSelectionSchema;

/**
 * Public checkout form of any accepted selection, legacy spellings included. An invalid value passes
 * through unchanged, so option validation reports it with the call's other issues.
 */
function publicWorktree(value: unknown): AgentWorktree {
  const parsed = worktreeSelectionSchema.safeParse(value);
  if (!parsed.success) return value as AgentWorktree;
  const selection = parsed.data;
  if (selection === true || selection === 'worktree') return true;
  if ('id' in selection) return selection;
  return selection.base === undefined ? {} : { base: selection.base };
}

/**
 * Separate a legacy checkout selection out of `isolation` and normalize both checkout sources to the
 * public `AgentWorktree` form, before combining profile/call layers. Throws when both are given.
 * @internal
 */
export function isolationParts<T extends object>(
  options: T,
): Omit<T, 'isolation' | 'worktree'> & { isolation?: HarnessIsolation; worktree?: AgentWorktree } {
  const { isolation, worktree, ...rest } = options as T & {
    readonly isolation?: unknown;
    readonly worktree?: unknown;
  };
  const checkout = worktree === undefined ? {} : { worktree: publicWorktree(worktree) };
  if (isolation === undefined) return { ...rest, ...checkout };
  if (isolation === 'restricted' || isolation === 'inherit')
    return { ...rest, ...checkout, isolation };
  if (worktree !== undefined)
    throw new Error(
      'Choose worktree or a legacy worktree isolation value, not both; use worktree: true | { base } | handle.',
    );
  return { ...rest, worktree: publicWorktree(isolation) };
}

/**
 * Apply the `restricted` configuration-mode default and normalize the checkout selection, before
 * fingerprinting or planning. Values written before `worktree` became the only checkout selector
 * (`isolation: 'worktree'`, a handle or `{ kind: 'worktree' }` in `isolation`, and those forms in
 * `worktree`) are still accepted at runtime and normalized; supplying both a `worktree` and such an
 * `isolation` value throws.
 */
export function resolveIsolation<
  T extends {
    /** Configuration mode. */
    readonly isolation?: HarnessIsolation | undefined;
    /** Checkout selection. */
    readonly worktree?: AgentWorktree | undefined;
  },
>(
  options: T,
): Omit<T, 'isolation' | 'worktree'> & {
  /** Resolved configuration mode, `restricted` by default. */
  isolation: HarnessIsolation;
  /** Normalized checkout selection. */
  worktree?: AgentWorktree;
} {
  const parts = isolationParts(options);
  return { ...parts, isolation: parts.isolation ?? 'restricted' };
}
