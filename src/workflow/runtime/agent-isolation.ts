import { z } from 'zod';
import type { WorktreeIsolation } from './worktree-model.js';
import { worktreeIsolationSchema } from './worktree-schema.js';

/** Native configuration loading policy, independent of Git checkout and OS sandbox selection. */
export type HarnessIsolation = 'restricted' | 'inherit';
/** Configuration mode, or the original shorthand for a runtime-owned worktree. */
export type AgentIsolation = HarnessIsolation | WorktreeIsolation;
/** Explicit checkout selection; true creates a fresh worktree from HEAD per attempt. */
export type AgentWorktree = true | WorktreeIsolation;

/** Configuration mode validator. @internal */
export const harnessIsolationSchema = z.enum(['restricted', 'inherit']);
/** Public isolation shorthand validator. @internal */
export const agentIsolationSchema = z.union([harnessIsolationSchema, worktreeIsolationSchema]);
/** Independent checkout selection validator. @internal */
export const agentWorktreeSchema = z.union([z.literal(true), worktreeIsolationSchema]);

/** Separate the legacy checkout shorthand before combining profile/call layers. @internal */
export function isolationParts<
  T extends {
    readonly isolation?: AgentIsolation | undefined;
    readonly worktree?: AgentWorktree | undefined;
  },
>(
  options: T,
): Omit<T, 'isolation' | 'worktree'> & { isolation?: HarnessIsolation; worktree?: AgentWorktree } {
  const { isolation, worktree, ...rest } = options;
  const checkout = worktree === undefined ? {} : { worktree };
  if (isolation === undefined) return { ...rest, ...checkout };
  if (isolation === 'restricted' || isolation === 'inherit')
    return { ...rest, ...checkout, isolation };
  if (worktree !== undefined)
    throw new Error('Choose worktree or a worktree isolation shorthand, not both.');
  return { ...rest, worktree: isolation };
}

/**
 * Split the legacy worktree shorthand out of `isolation` and apply the `restricted` default, before
 * fingerprinting or planning. Throws when both `worktree` and a worktree shorthand are given.
 */
export function resolveIsolation<
  T extends {
    /** Configuration mode or legacy worktree shorthand. */
    readonly isolation?: AgentIsolation | undefined;
    /** Explicit checkout selection. */
    readonly worktree?: AgentWorktree | undefined;
  },
>(
  options: T,
): Omit<T, 'isolation' | 'worktree'> & {
  /** Resolved configuration mode, `restricted` by default. */
  isolation: HarnessIsolation;
  /** Checkout selection, from `worktree` or the legacy shorthand. */
  worktree?: AgentWorktree;
} {
  const parts = isolationParts(options);
  return { ...parts, isolation: parts.isolation ?? 'restricted' };
}
