import type { StepContext } from './model.js';

/** A ref resolved once, or an explicitly pinned commit. */
export type WorktreeBase =
  | string
  | {
      /** Full Git commit object ID. */
      readonly commit: string;
    };

/** A run-owned shared checkout, returned by ctx.worktree and safe to checkpoint as JSON. */
export interface WorktreeHandle {
  /** Opaque identity belonging to the creating run. */
  readonly id: string;
  /** Cache path, rebuilt from the pinned snapshot when missing. */
  readonly path: string;
  /** Original resolved commit; never re-resolved from a moving ref on resume. */
  readonly base: string;
}

/** Per-call fresh isolation, or serialization on a previously created shared handle. */
export type WorktreeIsolation =
  | 'worktree'
  | {
      /** Create a fresh detached worktree for each attempt. */
      readonly kind: 'worktree';
      /** Ref or commit to pin before the first invocation; default HEAD. */
      readonly base?: WorktreeBase;
    }
  | WorktreeHandle;

/** A captured change remains usable after its cache directory has been removed. */
export interface WorktreeChange {
  /** Commit from which this change was captured. */
  readonly base: string;
  /** Snapshot commit, or null when the tree is unchanged. */
  readonly commit: string | null;
  /** Run-owned ref keeping the snapshot reachable, or null for an unchanged tree. */
  readonly ref: string | null;
  /** Changes relative to base; renamed entries name the destination. */
  readonly files: readonly {
    /** Repository-relative path. */
    readonly path: string;
    /** Git change category. */
    readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  }[];
}

/** Initial base for a run-owned shared handle. */
export interface WorktreeCreateOptions {
  /** Resolve once before creating the cache, default HEAD. */
  readonly base?: WorktreeBase;
}

/** Live dependency-provisioning context; setup is not a durable workflow callback. */
export interface WorktreeSetupContext extends StepContext {
  /** Absolute root of the isolated checkout. */
  readonly path: string;
  /** Pinned commit used to prepare this checkout. */
  readonly base: string;
  /** Owning workflow run. */
  readonly runId: string;
  /** Fully qualified durable effect ID. */
  readonly stepId: string;
}

/** Run-wide cache policy, independent of the semantic identity of an isolated call. */
export interface WorktreePolicy {
  /** Cache container; defaults to project-specific state outside the checkout. */
  readonly root?: string;
  /** Keep all caches, failed attempts until run completion (default), or none after draining. */
  readonly keep?: 'all' | 'failed' | 'none';
  /** Provision ignored dependencies after creation/reset; honor the supplied cancellation signal. */
  readonly setup?: (context: WorktreeSetupContext) => void | Promise<void>;
}

/** Explicit integration policy; only checkout targets modify the caller's working tree. */
export interface MergeOptions {
  /** Reapply each snapshot in order, retain merge parents, or squash into one commit. Default rebase. */
  readonly strategy?: 'rebase' | 'merge' | 'squash';
  /** Return conflict data (default), or reject without publishing the integration target. */
  readonly onConflict?: 'report' | 'fail';
  /** Publish a run-owned ref by default, an unoccupied branch, or the explicitly selected checkout. */
  readonly target?:
    | 'ref'
    | 'checkout'
    | {
        /** Branch name under refs/heads; cannot be checked out in any worktree. */
        readonly branch: string;
      };
}

/** Ordered, durable integration outcome. */
export interface MergeResult {
  /** Last clean integration commit, including all successfully applied inputs. */
  readonly commit: string;
  /** Successfully applied input commits, in caller-supplied order. */
  readonly merged: readonly string[];
  /** Inputs that could not be integrated; file lists can be empty for directory-level conflicts. */
  readonly conflicts: readonly {
    /** Source snapshot which conflicted. */
    readonly commit: string;
    /** Conflicted paths reported by Git, never inferred from marker text. */
    readonly files: readonly string[];
  }[];
}
