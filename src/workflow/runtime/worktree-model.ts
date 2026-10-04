import type { ErrorMode, StepContext } from './model.js';

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

/**
 * Base for a run-owned checkout: a shared handle from `ctx.worktree`, or a fresh per-attempt agent
 * checkout (`worktree: { base }`).
 */
export interface WorktreeCreateOptions {
  /** Ref or commit, resolved once and pinned before the checkout is first used; default HEAD. */
  readonly base?: WorktreeBase;
}

/**
 * Live dependency-provisioning context; setup is not a durable workflow callback, so it has no
 * `exec`.
 */
export interface WorktreeSetupContext extends Omit<StepContext, 'exec'> {
  /** Absolute root of the isolated checkout. */
  readonly path: string;
  /** Pinned commit used to prepare this checkout. */
  readonly base: string;
  /** Owning workflow run. */
  readonly runId: string;
  /** Fully qualified durable effect ID. */
  readonly stepId: string;
}

/**
 * Run-wide cache policy, independent of the semantic identity of an isolated call. It can be
 * declared on the root workflow definition (`defineWorkflow({ worktrees })`) and supplied as
 * `RunOptions.worktrees` (the CLI's `--worktree-keep` and `--worktree-root`); a field the options
 * set replaces the definition's field. No field enters step identity or the workflow fingerprint.
 */
export interface WorktreePolicy {
  /**
   * Cache container; defaults to project-specific state outside the checkout. A run pins its root on
   * first live use; a different root on a later resume is reported as a worktree warning and ignored.
   */
  readonly root?: string;
  /** Keep all caches, failed attempts until run completion (default), or none after draining. */
  readonly keep?: 'all' | 'failed' | 'none';
  /**
   * Provision dependencies after creation/reset; honor the supplied cancellation signal. Untracked,
   * non-ignored paths that setup creates (as `git status --untracked-files=normal` lists them, so a
   * new directory counts as one path) are recorded and left out of capture; tracked files that setup
   * modifies are captured.
   */
  readonly setup?: (context: WorktreeSetupContext) => void | Promise<void>;
  /**
   * Git glob pathspecs, relative to the repository root, that capture never stages: `tmp/**`
   * matches everything under `tmp`, and `*.log` matches top-level logs only, because `*` stays
   * within one directory (prefix `**` and a slash to match at any depth). A matching tracked file
   * keeps the content it had before the call in the captured snapshot.
   */
  readonly captureExclude?: readonly string[];
}

/**
 * Message and identity for the commits an integration creates, so a published branch can back a
 * pull request. Isolated-attempt snapshot commits always keep the fixed `quiet-choir` identity.
 */
export interface MergeCommitOptions {
  /**
   * Message of the final commit: the squash commit, or the last clean integrate commit for
   * `rebase` and `merge`. Intermediate commits keep their generated messages. It must contain
   * non-whitespace text and no NUL. When nothing merges (unchanged inputs, or every input
   * conflicted) no commit is created and this has no effect.
   */
  readonly message: string;
  /**
   * Author and committer of every commit the merge creates. `'quiet-choir'` (the default) is
   * `quiet-choir <quiet-choir@localhost>`. `'git-config'` reads `git var GIT_AUTHOR_IDENT` and
   * `GIT_COMMITTER_IDENT` in the repository, which come from `user.name` and `user.email` in git
   * config because quiet-choir strips every `GIT_*` variable from git's environment; it fails the
   * step when git cannot produce an identity, with no fallback. An explicit name and email are
   * used for both author and committer and may not contain newlines, NUL or angle brackets. The
   * identity is resolved once when the merge is prepared and recorded, so a retry or resume
   * reproduces the same commit ID.
   */
  readonly author?:
    | 'quiet-choir'
    | 'git-config'
    | {
        /** Author and committer name. */
        readonly name: string;
        /** Author and committer email, without angle brackets. */
        readonly email: string;
      };
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
  /**
   * Message and author for the integration commits; omitted keeps the generated messages and the
   * fixed `quiet-choir` identity. Supplying it changes the step identity.
   */
  readonly commit?: MergeCommitOptions;
  /**
   * Throw failures by default, or save the final failure and return it as `Settled`, such as an
   * `onConflict: 'fail'` conflict, a dirty checkout target or a target that moved. Cancellation,
   * configuration and checkpoint failures still reject. `'return'` changes the step identity.
   */
  readonly onError?: ErrorMode | undefined;
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
