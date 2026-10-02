/**
 * Dry-run synthesis of worktree isolation and integration (ADR 0016, #148).
 *
 * A rehearsal never creates refs, worktrees, objects or cache directories. The only Git it runs is
 * `rev-parse`, through a read-only {@link WorktreeGit} that refuses every other command before it
 * reaches the process runner, to resolve the repository and the base commit a real run would pin.
 * A fresh isolated agent call is planned in an absolute placeholder directory that is never created
 * and returns an unchanged change; a merge whose inputs are all unchanged changes returns the real
 * no-op integration (`commit` is the target's current commit). Everything else that touches Git
 * stays refused by the replay decision.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { WorktreeGit, commitId } from '../../worktrees/git.js';
import { CheckpointError } from './checkpoint.js';
import { ConfigurationError } from './configuration-error.js';
import type { ProcessRunner } from './exec-model.js';
import { digest } from './json.js';
import type { HarnessInvocation, StepContext } from './model.js';
import type { AttemptRecord, RunRecord, StepRecord } from './record.js';
import type { RunOptions } from './runner.js';
import type {
  MergeOptions,
  MergeResult,
  WorktreeBase,
  WorktreeChange,
  WorktreeHandle,
  WorktreeIsolation,
  WorktreePolicy,
} from './worktree-model.js';
import type { WorktreeStep } from './worktree-schema.js';
import { worktreeIsolationSchema } from './worktree-schema.js';
import {
  defaultWorktreeRoot,
  isolatedCwdOutsideMessage,
  rootInsideCheckoutMessage,
  unresolvedBaseMessage,
  within,
  type WorktreeLease,
} from './worktrees.js';

/** One synthesized worktree effect, as reported to `RunOptions.rehearsal.onWorktree`. @internal */
export type RehearsalWorktreeEvent = Parameters<
  NonNullable<NonNullable<RunOptions['rehearsal']>['onWorktree']>
>[0];

/** The base reported outside a Git working tree: forty zeros, never a real commit. @internal */
export const placeholderCommit = '0'.repeat(40);

/** Whether a dry-run synthesizes this isolation: fresh per-call isolation, never a handle. @internal */
export function canSynthesizeIsolation(isolation: WorktreeIsolation): boolean {
  return typeof isolation === 'string' || !('id' in isolation);
}

/** Whether a dry-run synthesizes this merge: every input is an unchanged change. @internal */
export function canSynthesizeMerge(inputs: readonly (WorktreeChange | WorktreeHandle)[]): boolean {
  return inputs.every((input) => !('id' in input) && input.commit === null);
}

/** Read-only base resolution and synthesis for one rehearsal run. @internal */
export class WorktreeRehearsal {
  private readonly git: WorktreeGit | undefined;
  private repository: Promise<string | null> | undefined;
  private readonly revisions = new Map<string, Promise<string | null>>();

  public constructor(
    private readonly record: RunRecord,
    runner: ProcessRunner | undefined,
    private readonly policy: WorktreePolicy,
    private readonly save: () => Promise<void>,
    private readonly invocation: (
      id: string,
      context: Omit<StepContext, 'exec'>,
    ) => HarnessInvocation,
    private readonly runSignal?: AbortSignal,
  ) {
    this.git = runner === undefined ? undefined : new WorktreeGit(runner, true);
  }

  /**
   * The canonical repository top level, or null when there is no process runner, the cwd is not in
   * a Git working tree, Git is missing, or the runner answers with nothing (a synthesizing runner).
   * Memoized per run, so concurrent isolated calls share one spawn.
   */
  private repo(invocation: HarnessInvocation): Promise<string | null> {
    const git = this.git;
    if (!git) return Promise.resolve(null);
    const shared = { ...invocation, signal: this.runSignal ?? invocation.signal };
    this.repository ??= (async () => {
      let top: string;
      try {
        top = await git.text(this.record.cwd, ['rev-parse', '--show-toplevel'], shared);
      } catch (cause) {
        if (cause instanceof CheckpointError || shared.signal.aborted) throw cause;
        return null;
      }
      return top && isAbsolute(top) ? realpath(top) : null;
    })().catch((error: unknown) => {
      this.repository = undefined;
      throw error;
    });
    return this.repository;
  }

  /** The commit `revision` names, or null when it does not resolve. Memoized per revision. */
  private revision(
    repo: string,
    revision: string,
    invocation: HarnessInvocation,
  ): Promise<string | null> {
    const git = this.git;
    if (!git) return Promise.resolve(null);
    let resolved = this.revisions.get(revision);
    if (!resolved) {
      const shared = { ...invocation, signal: this.runSignal ?? invocation.signal };
      resolved = (async () => {
        const result = await git.run(
          repo,
          ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`],
          shared,
          { codes: [0, 1, 128] },
        );
        return result.code === 0 ? commitId(result.stdout.trim()) : null;
      })().catch((error: unknown) => {
        this.revisions.delete(revision);
        throw error;
      });
      this.revisions.set(revision, resolved);
    }
    return resolved;
  }

  private async base(
    repo: string,
    base: WorktreeBase | undefined,
    invocation: HarnessInvocation,
  ): Promise<string> {
    const revision = base === undefined ? 'HEAD' : typeof base === 'string' ? base : base.commit;
    const commit = await this.revision(repo, revision, invocation);
    if (commit === null) throw new ConfigurationError(unresolvedBaseMessage(base));
    return commit;
  }

  /** The cache root a real run would use, by path arithmetic only: nothing is created or resolved. */
  private root(repo: string | null): string {
    return this.policy.root === undefined
      ? defaultWorktreeRoot(repo ?? this.record.cwd)
      : resolve(this.record.cwd, this.policy.root);
  }

  /**
   * Plan a fresh isolated attempt without Git: record its base and placeholder directory in the
   * temporary checkpoint and return a lease whose capture reports an unchanged tree.
   */
  public async isolate(
    id: string,
    isolation: WorktreeIsolation,
    logicalCwd: string,
    context: Omit<StepContext, 'exec'>,
    step: StepRecord,
    attempt: AttemptRecord,
  ): Promise<{ lease: WorktreeLease; event: RehearsalWorktreeEvent }> {
    const parsed = worktreeIsolationSchema.parse(isolation);
    if (typeof parsed === 'object' && 'id' in parsed)
      throw new Error('Dry-run never synthesizes isolation on a worktree handle.');
    const invocation = this.invocation(id, context);
    const repo = await this.repo(invocation);
    const root = this.root(repo);
    if (repo !== null && within(repo, root))
      throw new ConfigurationError(rootInsideCheckoutMessage);
    let base: string;
    let baseSource: 'resolved' | 'recorded' | 'placeholder';
    if (step.worktree?.base !== undefined) {
      base = step.worktree.base;
      baseSource = 'recorded';
    } else if (repo === null) {
      base = placeholderCommit;
      baseSource = 'placeholder';
    } else {
      base = await this.base(
        repo,
        typeof parsed === 'string' ? undefined : parsed.base,
        invocation,
      );
      baseSource = 'resolved';
    }
    let inside = '';
    if (repo !== null) {
      const canonical = await realpath(logicalCwd);
      if (!within(repo, canonical)) throw new ConfigurationError(isolatedCwdOutsideMessage);
      inside = relative(repo, canonical);
    }
    const path = join(
      root,
      `${this.record.id}-dry-run`,
      digest(`attempt:${id}:${String(context.attempt)}`),
    );
    const state: WorktreeStep = { base, path, handleId: null, commit: null, ref: null, files: [] };
    step.worktree = attempt.worktree = state;
    await this.save();
    const cwd = resolve(path, inside);
    const none = (): void => {
      /* No cache, handle or lock exists to settle. */
    };
    return {
      lease: {
        cwd,
        capture: () => Promise.resolve(state),
        completed: none,
        failed: none,
        release: none,
      },
      event: { kind: 'isolation', stepId: id, attempt: context.attempt, base, baseSource, cwd },
    };
  }

  /**
   * The real integration result of unchanged inputs: nothing merged, no conflicts, and the target's
   * current commit (an existing branch target, otherwise HEAD).
   */
  public async merge(
    id: string,
    inputs: readonly WorktreeChange[],
    options: MergeOptions,
    context: Omit<StepContext, 'exec'>,
  ): Promise<{ result: MergeResult; event: RehearsalWorktreeEvent }> {
    const target = options.target ?? 'ref';
    const kind = typeof target === 'object' ? 'branch' : target;
    const invocation = this.invocation(id, context);
    const repo = await this.repo(invocation);
    let commit = placeholderCommit;
    if (repo !== null) {
      const branch =
        typeof target === 'object'
          ? await this.revision(repo, `refs/heads/${target.branch}`, invocation)
          : null;
      const head = branch ?? (await this.revision(repo, 'HEAD', invocation));
      if (head === null)
        throw new Error('Merge requires a committed HEAD or existing target branch.');
      for (const input of inputs)
        if ((await this.revision(repo, input.base, invocation)) !== input.base)
          throw new Error('Merge input commit is unavailable in this repository.');
      commit = head;
    }
    return {
      result: { commit, merged: [], conflicts: [] },
      event: {
        kind: 'merge',
        stepId: id,
        attempt: context.attempt,
        commit,
        inputs: inputs.length,
        target: kind,
        baseSource: repo === null ? 'placeholder' : 'resolved',
      },
    };
  }
}
