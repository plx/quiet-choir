/**
 * Dry-run synthesis of worktree isolation and integration (ADR 0016, #148, #310, #312).
 *
 * A rehearsal never creates refs, worktrees or cache directories, and writes no object into the
 * repository. It resolves the repository and the base commit a real run would pin with `rev-parse`,
 * through a read-only {@link WorktreeGit} that refuses every command outside a short exact allowlist
 * before it reaches the process runner. Before a run has a worktree ledger, the first isolation or
 * merge also makes the real ledger's checks through it, with the real messages: Git older than 2.38
 * fails, a cache root inside the checkout (once existing symlinks are resolved) fails, and a
 * checkout with uncommitted changes records the real warning. Every merge first makes the real
 * merge's target checks (`checkMergeTarget`): an invalid branch name, a branch checked out in a
 * worktree or a symbolic-ref branch, and a dirty `checkout` target fail as in a real run. The
 * worktree listing they need waits only for the in-process administration queue, never the
 * repository's lock file. A fresh isolated agent call is planned in an absolute placeholder
 * directory that is never created and returns an unchanged change; a merge whose inputs are all
 * unchanged changes returns the real no-op integration (`commit` is the target's current commit).
 *
 * A merge over captured commits (a completed isolated step replayed by a dry-run resume or reused
 * by a dry-run fork, or a replayed `ctx.worktree` handle from the copied ledger) is previewed with
 * the real integration code (`computeIntegration`). The first such merge creates one temporary
 * object directory for the rest of the rehearsal; from then on every rehearsal Git command runs
 * through a quarantined {@link WorktreeGit} that writes objects only there, reads the repository's
 * objects as an alternate, runs only `rev-parse`, `merge-tree`, `commit-tree` and `var`, and makes
 * Git itself refuse ref updates. {@link WorktreeRehearsal.dispose} removes the directory when the
 * run ends, so a preview's commit exists only during the rehearsal. A configured custom merge
 * driver, or a configured clean, smudge or process filter while `merge.renormalize` is set, refuses
 * the preview before any `merge-tree`, since Git would run it outside the quarantine. So does a
 * partial clone on Git older than 2.44, which ignores `GIT_NO_LAZY_FETCH` and could fetch missing
 * objects from the promisor remote into the repository. Previews into
 * a `branch` or `checkout` target leave an in-memory tip that later previews and fresh isolation
 * bases start from, as they would after the real merge moved the target. Everything else that
 * touches Git (`ctx.worktree`, isolation on a handle) stays refused by the replay decision.
 *
 * The accepted-replay preflight's probe (#217) constructs this class with `synthesizeAll` and no
 * process runner, so it never resolves a repository and issues no Git command at all. It also
 * synthesizes the effects a dry run refuses, so the probe can replay past them to a changed
 * completed step: `ctx.worktree` returns a placeholder handle, an isolation on a handle gets a
 * lease in the handle's (never created) directory that captures an unchanged tree, and any merge
 * reports every captured input commit as merged with no conflicts. The probe reports none of these
 * values, so low-fidelity placeholders (the forty-zero commit, uncreated paths) suffice; they can
 * still steer the copy onto a branch the real run would not take (ADR 0006's path-parity caveat).
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { WorktreeGit, commitId } from '../../worktrees/git.js';
import { CheckpointError } from './checkpoint.js';
import { ConfigurationError } from './configuration-error.js';
import { filePath } from './files.js';
import type { ProcessRunner } from './exec-model.js';
import { digest } from './json.js';
import type { HarnessInvocation, StepContext } from './model.js';
import {
  checkMergeTarget,
  commitTree,
  computeIntegration,
  resolveCommit,
} from './worktree-merge.js';
import type { AttemptRecord, RunRecord, StepRecord } from './record.js';
import type { RunOptions } from './runner.js';
import type {
  MergeOptions,
  MergeResult,
  WorktreeBase,
  WorktreeChange,
  WorktreeHandle,
  WorktreePolicy,
} from './worktree-model.js';
import type { ResolvedWorktree, WorktreeStep } from './worktree-schema.js';
import { resolveWorktree } from './worktree-schema.js';
import {
  defaultWorktreeRoot,
  gitVersionRefusal,
  handleChange,
  isolatedCwdOutsideMessage,
  ownedHandle,
  queueAdministration,
  rootInsideCheckoutMessage,
  uncommittedSourceWarning,
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
export function canSynthesizeIsolation(isolation: ResolvedWorktree): boolean {
  return !('id' in isolation);
}

/** The refusal of a merge preview over captured commits without a repository. @internal */
export const previewNeedsRepositoryMessage =
  'Dry-run needs the Git repository to preview a merge of captured commits or a worktree handle; the workflow cwd is not in a Git working tree, or no process runner resolved it.';

/**
 * The refusal of a merge preview while custom merge drivers are configured: `merge-tree` would run
 * them, and a driver is an arbitrary command that can write outside the quarantine. @internal
 */
export function customMergeDriversMessage(names: readonly string[]): string {
  return `Dry-run cannot preview a merge of captured commits while custom merge drivers are configured (${names.join(', ')}): Git would run them, and they can write outside the preview's quarantine.`;
}

/**
 * The refusal of a merge preview while `merge.renormalize` is set and clean, smudge or process
 * filters are configured: `merge-tree` would run them on every renormalized blob, and a filter is
 * an arbitrary command that can write outside the quarantine. @internal
 */
export function customMergeFiltersMessage(names: readonly string[]): string {
  return `Dry-run cannot preview a merge of captured commits while merge.renormalize is set and filters are configured (${names.join(', ')}): Git would run them, and they can write outside the preview's quarantine.`;
}

/**
 * The refusal of a merge preview in a partial clone on Git older than 2.44: it ignores
 * `GIT_NO_LAZY_FETCH`, so a missing object would be fetched from the promisor remote into the
 * repository. @internal
 */
export function partialCloneGitMessage(version: string): string {
  return `Dry-run cannot preview a merge of captured commits in a partial clone with ${version}: merge previews in a partial clone need Git 2.44 or later, the first to honor GIT_NO_LAZY_FETCH, so the preview cannot fetch missing objects from the promisor remote into the repository.`;
}

/** Whether `git --version` output names Git 2.44 or later, the first to honor `GIT_NO_LAZY_FETCH`. */
function honorsNoLazyFetch(version: string): boolean {
  const match = /^git version (\d+)\.(\d+)/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 2 || (major === 2 && Number(match[2]) >= 44);
}

/** Read-only base resolution and synthesis for one rehearsal run. @internal */
export class WorktreeRehearsal {
  /**
   * The read-only driver, never replaced: the ledger and merge target checks run through it even
   * after a merge preview has swapped {@link git} for the quarantined driver, which refuses them.
   */
  private readonly readOnly: WorktreeGit | undefined;
  /** The read-only driver, replaced by the quarantined one once a merge preview creates it. */
  private git: WorktreeGit | undefined;
  private repository: Promise<string | null> | undefined;
  /** The real ledger's initialization checks (see {@link initialize}), memoized once they pass. */
  private initialization: Promise<void> | undefined;
  /** The canonical cache root (see {@link canonicalRoot}). */
  private canonical: Promise<string> | undefined;
  /** The canonical common Git directory, which keys the in-process administration queue. */
  private commonDir: Promise<string> | undefined;
  private readonly revisions = new Map<string, Promise<string | null>>();
  /** The run's quarantined driver, created by the first merge preview that needs one. */
  private quarantine: Promise<WorktreeGit> | undefined;
  /** The run's partial-clone check (see {@link refuseLazyFetch}), memoized once it passes. */
  private lazyFetch: Promise<void> | undefined;
  /** The quarantine's temporary object directory, removed by {@link dispose}. */
  private objects: string | undefined;
  private disposed = false;
  private readonly runner: ProcessRunner | undefined;
  /**
   * The last previewed commit of each `branch` or `checkout` target, by target ref
   * (`refs/heads/<branch>`, or `HEAD` for a detached checkout), so later previews into the same
   * target build on it as the real merges would. In memory only: no ref is ever written.
   */
  private readonly tips = new Map<string, string>();
  /** The checked-out branch's ref, or `HEAD` when detached; resolved once per run. */
  private checkout: Promise<string> | undefined;
  /**
   * The tail of the run's merge previews, which run one at a time in call order, as real merges do
   * under the run's integration lock, so concurrent previews into one target chain like them.
   */
  private integration: Promise<void> = Promise.resolve();

  /**
   * @param synthesizeAll - Set only for the accepted-replay probe: also synthesize `ctx.worktree`,
   *   isolation on a handle and merges of captured commits or handles. Pass no `runner` with it, so
   *   no Git command can be issued.
   */
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
    private readonly synthesizeAll = false,
  ) {
    this.runner = runner;
    this.readOnly = runner === undefined ? undefined : new WorktreeGit(runner, true);
    this.git = this.readOnly;
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

  /**
   * The checks the real `RunWorktrees.ledger()` makes when it creates a run's ledger, in its order:
   * the Git version (with the shared {@link gitVersionRefusal}), the cache root (outside the
   * checkout) and the source checkout's status (any output records the shared
   * {@link uncommittedSourceWarning}). Only a run without a ledger makes them, since a real run with
   * one recovers it instead. An empty `--version` answer (a synthesizing runner) skips the version
   * check, and a failure to run it is left to the placeholder path that a missing Git already
   * takes. Memoized once it passes, so concurrent effects share one check.
   */
  private initialize(repo: string, invocation: HarnessInvocation): Promise<void> {
    const git = this.readOnly;
    if (!git || this.record.worktrees !== undefined) return Promise.resolve();
    const shared = { ...invocation, signal: this.runSignal ?? invocation.signal };
    this.initialization ??= (async () => {
      let version = '';
      try {
        version = await git.text(this.record.cwd, ['--version'], shared);
      } catch (cause) {
        if (cause instanceof CheckpointError || shared.signal.aborted) throw cause;
      }
      const refusal = version === '' ? null : gitVersionRefusal(version);
      if (refusal !== null) throw new ConfigurationError(refusal);
      if (within(repo, await this.canonicalRoot(repo)))
        throw new ConfigurationError(rootInsideCheckoutMessage);
      const status = await git.text(
        repo,
        ['status', '--porcelain', '--untracked-files=normal', '--no-renames'],
        shared,
      );
      if (status) {
        this.record.worktreeWarnings = [
          ...new Set([...(this.record.worktreeWarnings ?? []), uncommittedSourceWarning]),
        ];
        await this.save();
      }
    })().catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  /**
   * The canonical common Git directory, resolved as the real run resolves the key of its
   * administration lock, so the rehearsal's listing queues behind the same in-process entry.
   * Memoized per run, cleared on failure.
   */
  private commonGitDir(repo: string, invocation: HarnessInvocation): Promise<string> {
    const git = this.readOnly;
    if (!git) return Promise.reject(new Error('Dry-run merge check requires a process runner.'));
    this.commonDir ??= (async () =>
      realpath(
        await git.text(
          repo,
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          invocation,
        ),
      ))().catch((error: unknown) => {
      this.commonDir = undefined;
      throw error;
    });
    return this.commonDir;
  }

  /**
   * The real merge's target checks (`checkMergeTarget`), through the read-only driver. The worktree
   * listing waits for the in-process administration queue only: the repository's lock file would
   * be a write, so a `worktree add` in another process can still race it.
   */
  private async checkTarget(
    repo: string,
    target: NonNullable<MergeOptions['target']>,
    invocation: HarnessInvocation,
  ): Promise<void> {
    const git = this.readOnly;
    if (!git) return;
    // The memoized common directory is shared by every merge, so it runs on the run's signal; the
    // checks themselves follow the merge's scope signal, as the real merge's do.
    const shared = { ...invocation, signal: this.runSignal ?? invocation.signal };
    const kind = typeof target === 'object' ? 'branch' : target;
    const ref = typeof target === 'object' ? `refs/heads/${target.branch}` : 'HEAD';
    await checkMergeTarget(
      {
        git,
        repo,
        administer: async (work) =>
          queueAdministration(await this.commonGitDir(repo, shared), invocation.signal, work),
      },
      kind,
      ref,
      invocation,
    );
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

  /**
   * The ref a `checkout` target moves: the checked-out branch's full ref, or `HEAD` when it is
   * detached (or unborn, when no merge can run anyway). Memoized per run.
   */
  private checkoutRef(repo: string, invocation: HarnessInvocation): Promise<string> {
    const git = this.git;
    if (!git) return Promise.resolve('HEAD');
    const shared = { ...invocation, signal: this.runSignal ?? invocation.signal };
    this.checkout ??= (async () => {
      const result = await git.run(repo, ['rev-parse', '--symbolic-full-name', 'HEAD'], shared, {
        codes: [0, 128],
      });
      const ref = result.stdout.trim();
      return result.code === 0 && ref.startsWith('refs/heads/') ? ref : 'HEAD';
    })().catch((error: unknown) => {
      this.checkout = undefined;
      throw error;
    });
    return this.checkout;
  }

  /** The commit at `ref`: the last preview into it in this rehearsal, otherwise the repository's. */
  private async tip(
    repo: string,
    ref: string,
    invocation: HarnessInvocation,
  ): Promise<string | null> {
    return this.tips.get(ref) ?? this.revision(repo, ref, invocation);
  }

  /** The commit HEAD's branch is at, counting earlier `checkout` previews of this rehearsal. */
  private async headTip(repo: string, invocation: HarnessInvocation): Promise<string | null> {
    const previewed =
      this.tips.size === 0 ? undefined : this.tips.get(await this.checkoutRef(repo, invocation));
    return previewed ?? this.revision(repo, 'HEAD', invocation);
  }

  /**
   * The commit a named base resolves to, counting earlier `branch` and `checkout` previews of this
   * rehearsal: a name for a previewed branch (one only a preview created included), or for a
   * detached `HEAD`, resolves to the previewed tip, as it would after the real merges moved or
   * created it. Anything else resolves in the repository.
   */
  private async named(
    repo: string,
    revision: string,
    invocation: HarnessInvocation,
  ): Promise<string | null> {
    const git = this.git;
    if (!git || this.tips.size === 0) return this.revision(repo, revision, invocation);
    const shared = { ...invocation, signal: this.runSignal ?? invocation.signal };
    const result = await git.run(
      repo,
      ['rev-parse', '--verify', '--quiet', '--symbolic-full-name', '--end-of-options', revision],
      shared,
      { codes: [0, 1, 128] },
    );
    // A branch only a preview created does not resolve in the repository; its name still does.
    const ref =
      result.code === 0
        ? result.stdout.trim()
        : revision.startsWith('refs/')
          ? revision
          : `refs/heads/${revision}`;
    if (ref === 'HEAD') return this.headTip(repo, invocation);
    return this.tips.get(ref) ?? this.revision(repo, revision, invocation);
  }

  /** A fresh isolation's base, from the rehearsal's view of the repository (see {@link named}). */
  private async base(
    repo: string,
    base: WorktreeBase | undefined,
    invocation: HarnessInvocation,
  ): Promise<string> {
    const commit =
      base === undefined
        ? await this.headTip(repo, invocation)
        : typeof base === 'string'
          ? await this.named(repo, base, invocation)
          : await this.revision(repo, base.commit, invocation);
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
   * The cache root with existing symlinks resolved, as the real ledger canonicalizes it before its
   * containment check (`filePath`, which only reads with `realpath` and `lstat` and creates
   * nothing), so a root that reaches the checkout through a symlink fails and one that leaves it
   * through a symlink passes, as in a real run. Memoized per run, cleared on failure.
   */
  private canonicalRoot(repo: string): Promise<string> {
    this.canonical ??= filePath(
      this.record.cwd,
      this.policy.root ?? defaultWorktreeRoot(repo),
      true,
    ).catch((error: unknown) => {
      this.canonical = undefined;
      throw error;
    });
    return this.canonical;
  }

  /**
   * The accepted-replay probe's `ctx.worktree`: a placeholder handle recorded in the temporary
   * checkpoint, without Git. Its directory is never created; its base is a `{ commit }` base's
   * commit, otherwise the placeholder commit.
   */
  public async handle(
    id: string,
    base: WorktreeBase | undefined,
    step: StepRecord,
    attempt: AttemptRecord,
  ): Promise<WorktreeHandle> {
    if (!this.synthesizeAll) throw new Error('Dry-run never synthesizes ctx.worktree.');
    const handle: WorktreeHandle = {
      id: `dry-run:${digest([id, step.fingerprint])}`,
      path: join(this.root(null), `${this.record.id}-dry-run`, digest(`handle:${id}`)),
      base: typeof base === 'object' ? base.commit : placeholderCommit,
    };
    step.worktree = attempt.worktree = {
      base: handle.base,
      path: handle.path,
      handleId: handle.id,
      commit: null,
      ref: null,
      files: [],
    };
    await this.save();
    return handle;
  }

  /**
   * Plan a fresh isolated attempt without Git: record its base and placeholder directory in the
   * temporary checkpoint and return a lease whose capture reports an unchanged tree. Under
   * `synthesizeAll`, an isolation on a handle gets the same kind of lease in the handle's directory.
   */
  public async isolate(
    id: string,
    isolation: ResolvedWorktree,
    logicalCwd: string,
    context: Omit<StepContext, 'exec'>,
    step: StepRecord,
    attempt: AttemptRecord,
  ): Promise<{ lease: WorktreeLease; event: RehearsalWorktreeEvent }> {
    const parsed = resolveWorktree(isolation);
    if ('id' in parsed) {
      if (!this.synthesizeAll)
        throw new Error('Dry-run never synthesizes isolation on a worktree handle.');
      return this.isolateHandle(id, parsed, context, step, attempt);
    }
    const invocation = this.invocation(id, context);
    const repo = await this.repo(invocation);
    if (repo !== null) await this.initialize(repo, invocation);
    if (repo !== null && within(repo, await this.canonicalRoot(repo)))
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
      base = await this.base(repo, parsed.base, invocation);
      baseSource = 'resolved';
    }
    let inside = '';
    if (repo !== null) {
      const canonical = await realpath(logicalCwd);
      if (!within(repo, canonical)) throw new ConfigurationError(isolatedCwdOutsideMessage);
      inside = relative(repo, canonical);
    }
    const path = join(
      this.root(repo),
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

  /** The probe's lease on a handle: its directory as cwd, its base, an unchanged capture. */
  private async isolateHandle(
    id: string,
    handle: WorktreeHandle,
    context: Omit<StepContext, 'exec'>,
    step: StepRecord,
    attempt: AttemptRecord,
  ): Promise<{ lease: WorktreeLease; event: RehearsalWorktreeEvent }> {
    const state: WorktreeStep = {
      base: handle.base,
      path: handle.path,
      handleId: handle.id,
      commit: null,
      ref: null,
      files: [],
    };
    step.worktree = attempt.worktree = state;
    await this.save();
    const none = (): void => {
      /* No cache, handle or lock exists to settle. */
    };
    return {
      lease: {
        cwd: handle.path,
        capture: () => Promise.resolve(state),
        completed: none,
        failed: none,
        release: none,
      },
      event: {
        kind: 'isolation',
        stepId: id,
        attempt: context.attempt,
        base: handle.base,
        baseSource: 'placeholder',
        cwd: handle.path,
      },
    };
  }

  /**
   * Refuse a merge preview in a partial clone (`extensions.partialClone` or a `remote.<name>.promisor`
   * is configured) when Git is older than 2.44: older Git ignores `GIT_NO_LAZY_FETCH`, so a missing
   * object would be fetched from the promisor remote into the repository. Both reads go through the
   * read-only driver before the preview runs any other command; `--version` runs only in a partial
   * clone. Memoized per run once it passes.
   */
  private refuseLazyFetch(repo: string, invocation: HarnessInvocation): Promise<void> {
    const git = this.readOnly;
    if (!git) return Promise.resolve();
    const shared = { ...invocation, signal: this.runSignal ?? invocation.signal };
    this.lazyFetch ??= (async () => {
      const promisors = await git.run(
        repo,
        [
          'config',
          '--name-only',
          '--get-regexp',
          '^(extensions\\.partialclone|remote\\..*\\.promisor)$',
        ],
        shared,
        { codes: [0, 1] },
      );
      if (promisors.code !== 0 || promisors.stdout.trim() === '') return;
      const version = await git.text(repo, ['--version'], shared);
      if (!honorsNoLazyFetch(version))
        throw new ConfigurationError(partialCloneGitMessage(version || 'an unknown Git version'));
    })().catch((error: unknown) => {
      this.lazyFetch = undefined;
      throw error;
    });
    return this.lazyFetch;
  }

  /**
   * The run's quarantined driver: a fresh `0700` temporary object directory with the repository's
   * object directory (read through the read-only driver first) as its alternate. Created once and
   * shared by every later rehearsal Git command, so a preview's commit stays resolvable by later
   * steps of the same rehearsal.
   */
  private quarantined(repo: string, invocation: HarnessInvocation): Promise<WorktreeGit> {
    const { git, runner } = this;
    if (!git || !runner) throw new Error('Dry-run merge preview requires a process runner.');
    if (this.disposed) throw new Error('Dry-run merge preview ran after the rehearsal ended.');
    const shared = { ...invocation, signal: this.runSignal ?? invocation.signal };
    this.quarantine ??= (async () => {
      // Read-only and before any merge-tree: Git would run a configured driver during the preview.
      const drivers = await git.run(
        repo,
        ['config', '--name-only', '--get-regexp', '^merge\\..*\\.driver$'],
        shared,
        { codes: [0, 1] },
      );
      const names = drivers.stdout.split('\n').filter((name) => name !== '');
      if (drivers.code === 0 && names.length)
        throw new ConfigurationError(customMergeDriversMessage(names));
      // With merge.renormalize, merge-tree runs clean and smudge filters, which are commands too.
      const renormalize = await git.run(
        repo,
        ['config', '--type=bool', '--get', 'merge.renormalize'],
        shared,
        { codes: [0, 1] },
      );
      if (renormalize.code === 0 && renormalize.stdout.trim() === 'true') {
        const filters = await git.run(
          repo,
          ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'],
          shared,
          { codes: [0, 1] },
        );
        const commands = filters.stdout.split('\n').filter((name) => name !== '');
        if (filters.code === 0 && commands.length)
          throw new ConfigurationError(customMergeFiltersMessage(commands));
      }
      const alternate = await git.text(
        repo,
        ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
        shared,
      );
      if (!isAbsolute(alternate))
        throw new Error('Git did not report an absolute object directory.');
      const objects = await mkdtemp(join(tmpdir(), 'quiet-choir-rehearsal-objects-'));
      this.objects = objects;
      const quarantined = new WorktreeGit(runner, { quarantine: { objects, alternate } });
      this.git = quarantined;
      return quarantined;
    })().catch((error: unknown) => {
      this.quarantine = undefined;
      throw error;
    });
    return this.quarantine;
  }

  /**
   * Remove the quarantine's temporary object directory, if a merge preview created one. Called once
   * the run has drained; idempotent, and a removal failure is ignored (the directory is under the
   * system temporary directory).
   */
  public async dispose(): Promise<void> {
    this.disposed = true;
    await this.quarantine?.catch(() => undefined);
    const objects = this.objects;
    this.objects = undefined;
    if (objects !== undefined)
      await rm(objects, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * The integration a real merge would compute, after the real merge's checks: the ledger checks
   * of a run without a ledger (see {@link initialize}) and the target checks (`checkMergeTarget`),
   * for a no-op merge too, so an invalid, checked-out or symbolic branch target and a dirty
   * `checkout` target fail with the real error. Unchanged inputs return the no-op result: nothing
   * merged, no conflicts, and the target's current commit (an existing branch target, otherwise
   * HEAD). A `branch` or `checkout` target's current commit is the last preview into it in this
   * rehearsal, if any, and a resolved preview into one (a no-op included, which creates a missing
   * branch) becomes its tip for later previews and fresh isolation bases, as the real merge would
   * move it; a `ref` target moves nothing, so it reads but never sets a tip. Previews run one at a
   * time in call order, as real merges do under the run's integration lock. Captured commits and
   * handles (resolved from the copied ledger as a real merge does) are previewed with the real
   * integration in the run's quarantine, dated `date` (the attempt's start, as in a real run), so
   * `merged` and `conflicts` match a real merge while the commit is discarded after the rehearsal.
   * Nothing is pinned, recorded in `step.merge` or published, and no repository lock is taken: the
   * target check's worktree listing waits only for this process's administration queue.
   * Under `synthesizeAll`, any inputs merge cleanly onto the placeholder commit: every captured
   * commit is reported merged, in order, and a handle contributes nothing, since its latest commit
   * is unknown without Git.
   */
  public async merge(
    id: string,
    inputs: readonly (WorktreeChange | WorktreeHandle)[],
    options: MergeOptions,
    context: Omit<StepContext, 'exec'>,
    date: string,
  ): Promise<{ result: MergeResult; event: RehearsalWorktreeEvent }> {
    const target = options.target ?? 'ref';
    const kind = typeof target === 'object' ? 'branch' : target;
    const event = (
      result: MergeResult,
      baseSource: 'resolved' | 'placeholder',
    ): { result: MergeResult; event: RehearsalWorktreeEvent } => ({
      result,
      event: {
        kind: 'merge',
        stepId: id,
        attempt: context.attempt,
        commit: result.commit,
        inputs: inputs.length,
        target: kind,
        baseSource,
        merged: [...result.merged],
        conflicts: result.conflicts.map((conflict) => ({
          commit: conflict.commit,
          files: [...conflict.files],
        })),
      },
    });
    if (this.synthesizeAll) {
      const merged = inputs.flatMap((input) =>
        'id' in input || input.commit === null ? [] : [input.commit],
      );
      return event({ commit: placeholderCommit, merged, conflicts: [] }, 'placeholder');
    }
    const previous = this.integration;
    let done = (): void => undefined;
    this.integration = new Promise<void>((resolve) => {
      done = resolve;
    });
    try {
      await previous;
      return event(...(await this.preview(id, inputs, options, context, date, target)));
    } finally {
      done();
    }
  }

  /** {@link merge} without `synthesizeAll`, run in its turn: the result and its base source. */
  private async preview(
    id: string,
    inputs: readonly (WorktreeChange | WorktreeHandle)[],
    options: MergeOptions,
    context: Omit<StepContext, 'exec'>,
    date: string,
    target: NonNullable<MergeOptions['target']>,
  ): Promise<[MergeResult, 'resolved' | 'placeholder']> {
    // The same ownership check and mapping as a real merge; a dry-run never creates a handle, so
    // the copied ledger holds exactly what a real resume would merge.
    const changes = inputs.map((input) =>
      'id' in input ? handleChange(ownedHandle(input, this.record.worktrees)) : input,
    );
    const invocation = this.invocation(id, context);
    const repo = await this.repo(invocation);
    if (repo === null) {
      if (inputs.some((input) => 'id' in input || input.commit !== null))
        throw new ConfigurationError(previewNeedsRepositoryMessage);
      return [{ commit: placeholderCommit, merged: [], conflicts: [] }, 'placeholder'];
    }
    // The real merge's ledger and target checks come first, in its order, whatever the inputs.
    await this.initialize(repo, invocation);
    await this.checkTarget(repo, target, invocation);
    // Before the preview resolves anything: older Git could lazy-fetch a captured commit.
    if (changes.some((change) => change.commit !== null))
      await this.refuseLazyFetch(repo, invocation);
    // The ref a real merge would move. A checkout target on a branch uses the branch's ref, so a
    // fresh isolation based on that branch's name sees the preview (a branch target naming the
    // checked-out branch fails the target check above, as in a real run).
    const moved =
      typeof target === 'object'
        ? `refs/heads/${target.branch}`
        : target === 'checkout'
          ? await this.checkoutRef(repo, invocation)
          : null;
    const head =
      (moved === null ? null : await this.tip(repo, moved, invocation)) ??
      (await this.headTip(repo, invocation));
    if (head === null)
      throw new Error('Merge requires a committed HEAD or existing target branch.');
    for (const change of changes)
      if (
        (await this.revision(repo, change.base, invocation)) !== change.base ||
        (change.commit !== null &&
          (await this.revision(repo, change.commit, invocation)) !== change.commit)
      )
        throw new Error('Merge input commit is unavailable in this repository.');
    if (changes.every((change) => change.commit === null)) {
      // The real no-op merge still creates a missing target branch at its base.
      if (moved !== null) this.tips.set(moved, head);
      return [{ commit: head, merged: [], conflicts: [] }, 'resolved'];
    }
    const git = await this.quarantined(repo, invocation);
    const custom = options.commit
      ? await resolveCommit(git, repo, options.commit, invocation)
      : undefined;
    const result = await computeIntegration(
      {
        git,
        repo,
        commit: (tree, parents, message, commitDate, identity) =>
          commitTree(git, repo, tree, parents, message, commitDate, invocation, identity),
      },
      id,
      head,
      changes,
      options,
      date,
      custom,
      invocation,
    );
    if (moved !== null) this.tips.set(moved, result.commit);
    return [result, 'resolved'];
  }
}
