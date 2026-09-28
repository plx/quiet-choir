import type { MergeResult, WorktreeChange, WorktreeHandle } from './worktree-model.js';
import { z } from 'zod';

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const text = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'NUL is not allowed');
/** @internal */
export const worktreeBaseSchema = z.union([text, z.strictObject({ commit: oid })]);
/** @internal */
export const worktreeHandleSchema = z.strictObject({ id: text, path: text, base: oid });
/** @internal */
export const worktreeIsolationSchema = z.union([
  z.literal('worktree'),
  z.strictObject({ kind: z.literal('worktree'), base: worktreeBaseSchema.optional() }),
  worktreeHandleSchema,
]);
/** @internal */
export const worktreeCreateSchema = z.strictObject({ base: worktreeBaseSchema.optional() });
/** @internal */
export const worktreeChangeSchema = z.strictObject({
  base: oid,
  commit: oid.nullable(),
  ref: text.nullable(),
  files: z.array(
    z.strictObject({ path: text, status: z.enum(['added', 'modified', 'deleted', 'renamed']) }),
  ),
});
/** @internal */
export const worktreeStepSchema = worktreeChangeSchema.extend({
  path: text,
  handleId: text.nullable(),
});
/** Persisted worktree diagnostics, independent of agent output shape. */
export interface WorktreeStep {
  /** Original resolved commit, pinned before the first invocation. */
  base: string;
  /** Captured commit, or null when unchanged from base. */
  commit: string | null;
  /** Owned pin, or null when no new commit was needed. */
  ref: string | null;
  /** File changes relative to the original base. */
  files: WorktreeChange['files'];
  /** Disposable absolute checkout root. */
  path: string;
  /** Shared handle identity, or null for a fresh per-call checkout. */
  handleId: string | null;
}

/** @internal */
export const worktreeLedgerSchema = z.object({
  namespace: z.uuid(),
  repo: text,
  root: text,
  caches: z.record(
    text,
    z.object({
      path: text,
      stepId: text,
      attempt: z.number().int().positive(),
      state: z.enum(['planned', 'ready', 'removed']),
      outcome: z.enum(['running', 'completed', 'failed']),
    }),
  ),
  handles: z.record(
    text,
    z.object({
      handle: worktreeHandleSchema,
      latest: oid,
      ref: text,
    }),
  ),
  refs: z.record(text, oid),
});
/** Runtime-owned cache and ref ledger, serialized with the run. */
export interface WorktreeLedger {
  /** Unique per-run namespace, also distinct across separate state containers. */
  readonly namespace: string;
  /** Canonical source checkout root. */
  readonly repo: string;
  /** Canonical cache container, pinned on first live use. */
  readonly root: string;
  /** Owned directories keyed by their path digest. */
  readonly caches: Record<
    string,
    {
      /** Absolute checkout root. */
      readonly path: string;
      /** Latest effect using this cache. */
      readonly stepId: string;
      /** Latest attempt using this cache. */
      readonly attempt: number;
      /** Last saved directory lifecycle; inspect also checks current existence. */
      state: 'planned' | 'ready' | 'removed';
      /** Last effect outcome, used by automatic retention policy. */
      outcome: 'running' | 'completed' | 'failed';
    }
  >;
  /** Shared checkout identities and latest committed snapshots. */
  readonly handles: Record<
    string,
    {
      /** Stable JSON handle belonging to this run. */
      readonly handle: WorktreeHandle;
      /** Latest completed tree commit, including the original base when unchanged. */
      latest: string;
      /** Ref keeping that snapshot reachable. */
      ref: string;
    }
  >;
  /** Owned ref names and expected commit IDs; clean --refs uses compare-and-delete. */
  readonly refs: Record<string, string>;
}

/** @internal */
export const mergeOptionsSchema = z.strictObject({
  strategy: z.enum(['rebase', 'merge', 'squash']).optional(),
  onConflict: z.enum(['report', 'fail']).optional(),
  target: z.union([z.enum(['ref', 'checkout']), z.strictObject({ branch: text })]).optional(),
});
/** @internal */
export const mergeResultSchema = z.object({
  commit: oid,
  merged: z.array(oid),
  conflicts: z.array(z.object({ commit: oid, files: z.array(text) })),
});

/** @internal */
export const mergePreparationSchema = z.object({
  base: oid,
  ref: text,
  target: z.enum(['ref', 'branch', 'checkout']),
  expected: oid.nullable(),
  checkoutBranch: text.nullable(),
  changes: z.array(worktreeChangeSchema),
  date: z.iso.datetime(),
  result: mergeResultSchema.optional(),
});
/** Resolved integration inputs and publication intent, pinned across interrupted attempts. */
export interface MergePreparation {
  /** Resolved starting commit; never re-resolved on retry. */
  readonly base: string;
  /** Target ref, or HEAD for explicit checkout publication. */
  readonly ref: string;
  /** Publication mode. */
  readonly target: 'ref' | 'branch' | 'checkout';
  /** Expected prior target value; null requires that the ref is absent. */
  readonly expected: string | null;
  /** Expected checkout branch; null represents detached HEAD. */
  readonly checkoutBranch: string | null;
  /** Source changes, with shared handles resolved while holding their locks. */
  readonly changes: readonly WorktreeChange[];
  /** Fixed commit date across retries and resumes. */
  readonly date: string;
  /** Computed clean result saved before target publication. */
  result?: MergeResult;
}
