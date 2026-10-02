import { integrate } from './worktree-merge.js';
import type { MergeOptions, MergeResult, WorktreeChange } from './worktree-model.js';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WorktreeGit, changedFiles, commitId } from '../../worktrees/git.js';
import type { ProcessRunner } from './exec-model.js';
import type { HarnessInvocation, StepContext } from './model.js';
import type { RunRecord, StepRecord, AttemptRecord } from './record.js';
import type {
  WorktreeBase,
  WorktreeHandle,
  WorktreeIsolation,
  WorktreePolicy,
} from './worktree-model.js';
import type { WorktreeLedger, WorktreeStep } from './worktree-schema.js';
import { worktreeIsolationSchema } from './worktree-schema.js';
import { defaultStateDir } from './paths.js';
import { digest } from './json.js';
import { CheckpointError } from './checkpoint.js';
import { ConfigurationError } from './configuration-error.js';
import { filePath } from './files.js';
import { repairWorktreeRegistrations } from './worktree-recovery.js';
import { acquireWorktreeAdminLock, worktreeAdminLockPath } from './worktree-admin-lock.js';

/** Whether `path` is `root` or inside it, lexically. @internal */
export function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

/**
 * The configuration error message for a base that does not resolve to a commit. Shared with dry-run
 * rehearsal so a rehearsal reports exactly what the real run would. @internal
 */
export function unresolvedBaseMessage(base: WorktreeBase | undefined): string {
  const revision = base === undefined ? 'HEAD' : typeof base === 'string' ? base : base.commit;
  return base === undefined
    ? `Worktree isolation cannot resolve base ${revision} to a commit; the repository has no committed HEAD.`
    : `Worktree isolation cannot resolve base ${revision} to a commit.`;
}

/** The configuration error message for an isolated cwd outside the repository. @internal */
export const isolatedCwdOutsideMessage = 'Isolated cwd must be inside the source repository.';

/** The configuration error message for a cache root inside the source checkout. @internal */
export const rootInsideCheckoutMessage = 'worktrees.root must be outside the source checkout.';

/** The default cache container for a repository, outside the checkout. @internal */
export function defaultWorktreeRoot(repo: string): string {
  return join(dirname(defaultStateDir(repo)), 'worktrees');
}

/** One handle cannot be prepared again until its prior outcome has committed. @internal */
class HandleLocks {
  private readonly tails = new Map<string, Promise<void>>();

  public async acquire(key: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const prior = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => next);
    this.tails.set(key, tail);
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error('Worktree queue cancelled.'));
      };
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      await Promise.race([prior, cancelled]);
      signal.throwIfAborted();
    } catch (error) {
      release();
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    }
    return release;
  }
}

/**
 * Git reads every registered worktree's metadata while adding or listing one, so a concurrent add can
 * expose another's half-written admin directory ("failed to read .../commondir"). Every
 * administrative command (`worktree add`, `list`, `remove` and registration repair) is serialized
 * per common Git directory, so linked checkouts of one repository share a single lock, in two
 * layers. This in-process queue orders the calls of every run in this process without polling.
 * Inside it, the repository lock at `<common Git dir>/quiet-choir/worktree-admin.lock` excludes
 * other processes, including `workflow clean` alongside a live run, and recovers a dead owner's
 * lock automatically (ADR 0032). Git commands run outside quiet-choir, such as a manual
 * `git worktree add`, are not serialized.
 */
const administration = new HandleLocks();

/**
 * Run one worktree administration command while holding the repository's in-process queue entry
 * and its interprocess lock. A release failure after successful work is thrown; after failed work
 * the work's error wins. Either way the lock can never hang a later call. @internal
 */
export async function administer<T>(
  commonGitDir: string,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  const release = await administration.acquire(commonGitDir, signal);
  try {
    const unlock = await acquireWorktreeAdminLock(commonGitDir, { signal });
    let result: T;
    try {
      result = await work();
    } catch (error) {
      // The work's failure is the attempt's outcome; a leaked lock is recovered by the next call.
      await unlock().catch(() => undefined);
      throw error;
    }
    await unlock();
    return result;
  } finally {
    release();
  }
}

/**
 * How long cleanup waits for the administration lock before warning instead. Unlike a live
 * attempt, cleanup has no caller to cancel it, so another process's stuck holder must not hang it.
 * Mutable only so tests can shorten it. @internal
 */
export const cleanupAdminWait = { ms: 30_000 };

/** `administer` for cleanup: the lock wait is bounded and a timeout reads as a plain message. */
async function administerBounded<T>(commonGitDir: string, work: () => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(cleanupAdminWait.ms);
  try {
    return await administer(commonGitDir, signal, work);
  } catch (error) {
    if (signal.aborted && error === signal.reason)
      throw new Error(
        `Timed out waiting for the worktree administration lock at ${worktreeAdminLockPath(commonGitDir)}`,
        { cause: error },
      );
    throw error;
  }
}

/** A live attempt owns the handle through result validation, capture, and durable save. @internal */
export interface WorktreeLease {
  readonly cwd: string;
  capture(): Promise<WorktreeStep>;
  completed(): void;
  failed(): void;
  release(): void;
}

/** Runtime-owned Git lifecycle above all harness adapters. @internal */
export class RunWorktrees {
  private initialization: Promise<WorktreeLedger> | undefined;
  private adminKeyPromise: Promise<string> | undefined;
  private recovery: Promise<void> | undefined;
  private readonly locks = new HandleLocks();
  private readonly git: WorktreeGit | undefined;

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
    /**
     * A dry-run rehearsal synthesizes isolation instead (`worktree-rehearsal.ts`), so every Git
     * command here is refused before it reaches the runner.
     */
    private readonly rehearsal = false,
  ) {
    this.git = runner === undefined ? undefined : new WorktreeGit(runner);
    if (policy.keep !== undefined && !['all', 'failed', 'none'].includes(policy.keep))
      throw new Error('worktrees.keep must be all, failed, or none.');
    if (
      policy.root !== undefined &&
      (typeof policy.root !== 'string' || !policy.root || policy.root.includes('\0'))
    )
      throw new Error('worktrees.root must be a nonempty path.');
    if (policy.setup !== undefined && typeof policy.setup !== 'function')
      throw new Error('worktrees.setup must be a function.');
  }

  private driver(): WorktreeGit {
    // An internal guard, not a configuration error: replay decisions refuse these effects first.
    if (this.rehearsal) throw new Error('Dry-run rehearsal never runs worktree Git commands.');
    if (!this.git)
      throw new ConfigurationError(
        'Worktree isolation requires RunOptions.processRunner (for example, NodeProcessRunner).',
      );
    return this.git;
  }

  /**
   * The canonical common Git directory that every linked worktree of `ledger.repo` shares. It keys
   * the in-process `administration` queue and locates the interprocess repository lock, so
   * concurrent runs rooted at different linked checkouts of one repository, in this process or
   * another, serialize their `worktree add/list/remove` commands. Resolved
   * lazily (not stored on the ledger) so a resumed run needs no schema change; memoized per instance
   * and cleared on failure so a transient Git error does not stick.
   */
  private adminKey(ledger: WorktreeLedger, invocation: HarnessInvocation): Promise<string> {
    this.adminKeyPromise ??= (async () =>
      realpath(
        await this.driver().text(
          ledger.repo,
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          invocation,
        ),
      ))().catch((error: unknown) => {
      this.adminKeyPromise = undefined;
      throw error;
    });
    return this.adminKeyPromise;
  }

  public async ledger(invocation: HarnessInvocation): Promise<WorktreeLedger> {
    if (this.record.worktrees) {
      const ledger = this.record.worktrees;
      this.recovery ??= (async () => {
        if (!Object.values(ledger.caches).some((cache) => cache.state === 'planned')) return;
        const signal = this.runSignal ?? invocation.signal;
        const common = await this.adminKey(ledger, { ...invocation, signal });
        // Hold the repository's administration lock so no concurrent `worktree add`, in this
        // process or another, enumerates the registration while its commondir is being repaired.
        const repaired = await administer(common, signal, () =>
          repairWorktreeRegistrations(ledger, this.record.id, common, signal),
        );
        for (const path of repaired)
          this.warn(`Repaired interrupted Git worktree registration: ${path}`);
        if (repaired.length) await this.save();
      })().catch((error: unknown) => {
        // Memoize only success, matching initialization, so a transient failure can retry.
        this.recovery = undefined;
        throw error;
      });
      await this.recovery;
      return ledger;
    }
    this.initialization ??= (async () => {
      const git = this.driver();
      const sharedInvocation = { ...invocation, signal: this.runSignal ?? invocation.signal };
      let version: string;
      try {
        version = await git.text(this.record.cwd, ['--version'], sharedInvocation);
      } catch (cause) {
        if (cause instanceof CheckpointError || sharedInvocation.signal.aborted) throw cause;
        throw new ConfigurationError(
          'Worktree isolation requires an executable Git 2.38 or newer.',
          { cause },
        );
      }
      const match = /git version (\d+)\.(\d+)/u.exec(version);
      if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 38))
        throw new ConfigurationError(
          `Worktree isolation requires Git 2.38 or newer; found ${version}.`,
        );
      let repo: string;
      try {
        repo = await realpath(
          await git.text(this.record.cwd, ['rev-parse', '--show-toplevel'], sharedInvocation),
        );
      } catch (cause) {
        if (cause instanceof CheckpointError || sharedInvocation.signal.aborted) throw cause;
        throw new ConfigurationError(
          'Worktree isolation requires a Git working tree with a committed HEAD.',
          { cause },
        );
      }
      // Canonicalize the parent before checking containment; a symlink cannot hide a nested cache.
      const requestedRoot = await filePath(
        this.record.cwd,
        this.policy.root ?? defaultWorktreeRoot(repo),
        true,
      );
      if (within(repo, requestedRoot)) throw new ConfigurationError(rootInsideCheckoutMessage);
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
      const root = await realpath(requestedRoot);
      if (within(repo, root)) throw new ConfigurationError(rootInsideCheckoutMessage);
      const status = await git.text(
        repo,
        ['status', '--porcelain', '--untracked-files=normal'],
        sharedInvocation,
      );
      if (status)
        this.warn(
          'Worktree isolation sees committed files only; the source checkout has uncommitted changes.',
        );
      const ledger: WorktreeLedger = {
        namespace: randomUUID(),
        repo,
        root,
        caches: {},
        handles: {},
        refs: {},
      };
      this.record.worktrees = ledger;
      this.recovery = Promise.resolve(); // No preceding attempt exists in a new ledger.
      await this.save();
      return ledger;
    })().catch((error: unknown) => {
      // Memoize only success, so a corrected checkout or policy can initialize on a later call.
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  private warn(message: string): void {
    this.record.worktreeWarnings = [...new Set([...(this.record.worktreeWarnings ?? []), message])];
  }

  private async resolveBase(
    base: WorktreeBase | undefined,
    ledger: WorktreeLedger,
    invocation: HarnessInvocation,
  ): Promise<string> {
    const revision = base === undefined ? 'HEAD' : typeof base === 'string' ? base : base.commit;
    try {
      return commitId(
        await this.driver().text(
          ledger.repo,
          ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
          invocation,
        ),
      );
    } catch (cause) {
      if (cause instanceof CheckpointError || invocation.signal.aborted) throw cause;
      throw new ConfigurationError(unresolvedBaseMessage(base), { cause });
    }
  }

  private ref(ledger: WorktreeLedger, key: string): string {
    return `refs/quiet-choir/${this.record.id}/${ledger.namespace}/${digest(key)}`;
  }

  private path(ledger: WorktreeLedger, key: string): string {
    return join(ledger.root, `${this.record.id}-${ledger.namespace}`, digest(key));
  }

  private async pin(
    ledger: WorktreeLedger,
    ref: string,
    commit: string,
    invocation: HarnessInvocation,
  ): Promise<void> {
    const prefix = `refs/quiet-choir/${this.record.id}/${ledger.namespace}/`;
    if (!ref.startsWith(prefix)) throw new Error('Ref is outside this run’s worktree namespace.');
    // Record intent first so even an interruption after update-ref leaves a discoverable owned pin.
    ledger.refs[ref] = commit;
    await this.save();
    const git = this.driver();
    const current = await git.run(
      ledger.repo,
      ['rev-parse', '--verify', '--quiet', '--end-of-options', ref],
      invocation,
      { codes: [0, 1] },
    );
    const symbolic = await git.run(ledger.repo, ['symbolic-ref', '-q', ref], invocation, {
      codes: [0, 1],
    });
    if (symbolic.code === 0 || (current.code === 0 && current.stdout.trim() !== commit))
      throw new Error(`Owned ref ${ref} changed; refusing to overwrite it.`);
    await git.run(
      ledger.repo,
      [
        'update-ref',
        '--no-deref',
        ref,
        commit,
        current.code === 0 ? commit : '0'.repeat(commit.length),
      ],
      invocation,
    );
  }

  private handle(
    handle: WorktreeHandle,
    ledger: WorktreeLedger,
  ): WorktreeLedger['handles'][string] {
    const saved = Object.hasOwn(ledger.handles, handle.id) ? ledger.handles[handle.id] : undefined;
    if (saved?.handle.path !== handle.path || saved.handle.base !== handle.base)
      throw new ConfigurationError(
        'Worktree handle does not belong to this run; create it with ctx.worktree.',
      );
    return saved;
  }

  private async ensureCache(
    ledger: WorktreeLedger,
    path: string,
    base: string,
    id: string,
    context: Omit<StepContext, 'exec'>,
  ): Promise<WorktreeLedger['caches'][string]> {
    const git = this.driver(),
      invocation = this.invocation(id, context);
    if (!within(join(ledger.root, `${this.record.id}-${ledger.namespace}`), path))
      throw new Error('Worktree cache is outside this run’s directory.');
    const key = digest(path);
    const prior = ledger.caches[key];
    const cache: WorktreeLedger['caches'][string] = (ledger.caches[key] = {
      path,
      stepId: id,
      attempt: context.attempt,
      state: prior?.state ?? 'planned',
      outcome: 'running',
    });
    await this.save();
    const stat = await lstat(path).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error('Worktree cache path must be a real directory.');
    if (!stat) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const key = await this.adminKey(ledger, invocation);
      // --force allows re-creating exactly this missing, registered worktree; never global prune.
      // Git enumerates other registrations while adding one. The per-repository administration lock
      // (in-process queue plus interprocess lock) keeps sibling creation, in any quiet-choir process,
      // from observing an empty commondir; agent work stays concurrent.
      await administer(key, invocation.signal, () =>
        git.run(ledger.repo, ['worktree', 'add', '--force', '--detach', path, base], invocation),
      );
    } else {
      const top = await realpath(
        await git.text(path, ['rev-parse', '--show-toplevel'], invocation),
      );
      const common = await realpath(
        await git.text(
          path,
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          invocation,
        ),
      );
      const expected = await this.adminKey(ledger, invocation);
      if (top !== path || common !== expected)
        throw new Error('Worktree cache no longer belongs to the recorded repository.');
      await git.run(path, ['reset', '--hard', base], invocation);
      await git.run(path, ['clean', '-ffd'], invocation);
    }
    cache.state = 'ready';
    await this.save();
    return cache;
  }

  private async directory(
    ledger: WorktreeLedger,
    path: string,
    logicalCwd: string,
  ): Promise<string> {
    const canonical = await realpath(logicalCwd);
    if (!within(ledger.repo, canonical)) throw new ConfigurationError(isolatedCwdOutsideMessage);
    return resolve(path, relative(ledger.repo, canonical));
  }

  public async create(
    id: string,
    base: WorktreeBase | undefined,
    context: Omit<StepContext, 'exec'>,
    step: StepRecord,
    attempt: AttemptRecord,
  ): Promise<WorktreeHandle> {
    const invocation = this.invocation(id, context),
      ledger = await this.ledger(invocation);
    const handleId = `${ledger.namespace}:${digest([id, step.fingerprint])}`;
    let saved = ledger.handles[handleId];
    if (!saved) {
      const pinned = await this.resolveBase(base, ledger, invocation);
      const handle = {
        id: handleId,
        path: this.path(ledger, `handle:${id}:${step.fingerprint}`),
        base: pinned,
      };
      saved = { handle, latest: pinned, ref: this.ref(ledger, `handle:${id}:${step.fingerprint}`) };
      ledger.handles[handleId] = saved;
    }
    await this.pin(ledger, saved.ref, saved.latest, invocation);
    step.worktree = attempt.worktree = {
      base: saved.handle.base,
      path: saved.handle.path,
      handleId,
      commit: null,
      ref: null,
      files: [],
    };
    await this.save();
    const cache = await this.ensureCache(ledger, saved.handle.path, saved.latest, id, context);
    const cwd = await this.directory(ledger, saved.handle.path, this.record.cwd);
    await this.policy.setup?.({
      ...setupContext(context),
      cwd,
      path: saved.handle.path,
      base: saved.latest,
      runId: this.record.id,
      stepId: id,
    });
    cache.outcome = 'completed';
    return { ...saved.handle };
  }

  public async prepare(
    id: string,
    isolation: WorktreeIsolation,
    logicalCwd: string,
    context: Omit<StepContext, 'exec'>,
    step: StepRecord,
    attempt: AttemptRecord,
  ): Promise<WorktreeLease> {
    const parsed = worktreeIsolationSchema.parse(isolation);
    const shared = typeof parsed === 'object' && 'id' in parsed ? parsed : undefined;
    const release = shared
      ? await this.locks.acquire(shared.id, context.signal)
      : () => {
          /* Per-call worktrees never share a lock. */
        };
    try {
      const invocation = this.invocation(id, context),
        ledger = await this.ledger(invocation);
      const saved = shared ? this.handle(shared, ledger) : undefined;
      const base =
        saved?.handle.base ??
        step.worktree?.base ??
        (await this.resolveBase(
          typeof parsed === 'string' || 'id' in parsed ? undefined : parsed.base,
          ledger,
          invocation,
        ));
      const start = saved?.latest ?? base;
      const path =
        saved?.handle.path ?? this.path(ledger, `attempt:${id}:${String(context.attempt)}`);
      const state: WorktreeStep = {
        base,
        path,
        handleId: shared?.id ?? null,
        commit: null,
        ref: null,
        files: [],
      };
      step.worktree = attempt.worktree = state;
      // The resolved SHA and physical attempt path must survive before any harness work.
      await this.save();
      if (!saved)
        await this.pin(
          ledger,
          this.ref(ledger, `base:${id}:${step.fingerprint}`),
          base,
          invocation,
        );
      const cwd = await this.directory(ledger, path, logicalCwd);
      const cache = await this.ensureCache(ledger, path, start, id, context);
      await this.policy.setup?.({
        ...setupContext(context),
        cwd,
        path,
        base: start,
        runId: this.record.id,
        stepId: id,
      });
      return {
        cwd,
        release,
        failed: () => {
          cache.outcome = 'failed';
        },
        completed: () => {
          // Advance the shared baseline synchronously with the effect's completed status.
          // Concurrent checkpoint saves must never see a new baseline on a running effect.
          if (saved) {
            saved.latest = state.commit ?? base;
            if (state.ref) saved.ref = state.ref;
          }
          cache.outcome = 'completed';
        },
        capture: async () => {
          // A resolved valid result remains durable after cancellation. Internal capture is bounded
          // and registered under the same owner, but does not inherit the already-aborted scope.
          const capture = { ...invocation, signal: new AbortController().signal };
          const git = this.driver();
          await git.run(path, ['add', '--all', '--', '.'], capture);
          const tree = commitId(await git.text(path, ['write-tree'], capture));
          const original = commitId(
            await git.text(ledger.repo, ['rev-parse', `${base}^{tree}`], capture),
          );
          if (tree !== original) {
            const commit = await this.commit(
              ledger,
              tree,
              [start],
              `quiet-choir ${id}`,
              attempt.startedAt,
              capture,
            );
            const ref = this.ref(ledger, `snapshot:${id}:${String(context.attempt)}`);
            await this.pin(ledger, ref, commit, capture);
            state.commit = commit;
            state.ref = ref;
            state.files = changedFiles(
              (
                await git.run(
                  ledger.repo,
                  ['diff', '--name-status', '-z', '--find-renames', base, commit, '--'],
                  capture,
                )
              ).stdout,
            );
          }
          return state;
        },
      };
    } catch (error) {
      const ledger = this.record.worktrees,
        path = attempt.worktree?.path;
      const cache = path ? ledger?.caches[digest(path)] : undefined;
      if (cache) cache.outcome = 'failed';
      release();
      throw error;
    }
  }

  public async merge(
    id: string,
    changes: readonly (WorktreeChange | WorktreeHandle)[],
    options: MergeOptions,
    context: Omit<StepContext, 'exec'>,
    step: StepRecord,
    attempt: AttemptRecord,
    releaseAfterSave: (release: () => void) => void,
  ): Promise<MergeResult> {
    const release = await this.locks.acquire('integration', context.signal);
    const held: (() => void)[] = [];
    releaseAfterSave(() => {
      for (const unlock of held.reverse()) unlock();
      release();
    });
    const invocation = this.invocation(id, context),
      ledger = await this.ledger(invocation);
    if (!step.merge) {
      for (const key of [
        ...new Set(changes.flatMap((change) => ('id' in change ? [change.id] : []))),
      ].sort())
        held.push(await this.locks.acquire(key, context.signal));
    }
    const resolved =
      step.merge?.changes ??
      changes.map((change): WorktreeChange => {
        if (!('id' in change)) return change;
        const saved = this.handle(change, ledger);
        return {
          base: saved.handle.base,
          commit: saved.latest === saved.handle.base ? null : saved.latest,
          ref: saved.ref,
          files: [],
        };
      });
    const commonGitDir = await this.adminKey(ledger, invocation);
    return await integrate(
      {
        git: this.driver(),
        ledger,
        save: this.save,
        ref: (key) => this.ref(ledger, key),
        administer: (work) => administer(commonGitDir, invocation.signal, work),
        pin: (ref, commit) => this.pin(ledger, ref, commit, invocation),
        commit: (tree, parents, message, date) =>
          this.commit(ledger, tree, parents, message, date, invocation),
      },
      id,
      step,
      resolved,
      options,
      attempt.startedAt,
      invocation,
    );
  }

  public async commit(
    ledger: WorktreeLedger,
    tree: string,
    parents: readonly string[],
    message: string,
    date: string,
    invocation: HarnessInvocation,
  ): Promise<string> {
    const identity = {
      GIT_AUTHOR_NAME: 'quiet-choir',
      GIT_AUTHOR_EMAIL: 'quiet-choir@localhost',
      GIT_COMMITTER_NAME: 'quiet-choir',
      GIT_COMMITTER_EMAIL: 'quiet-choir@localhost',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
    return commitId(
      (
        await this.driver().run(
          ledger.repo,
          ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-F', '-'],
          invocation,
          { input: `${message}\n`, env: identity },
        )
      ).stdout.trim(),
    );
  }

  public async cleanup(completed: boolean): Promise<string[]> {
    const ledger = this.record.worktrees;
    if (!ledger || this.policy.keep === 'all') return [];
    const warnings: string[] = [];
    for (const cache of Object.values(ledger.caches)) {
      if (
        cache.state === 'removed' ||
        (!completed && this.policy.keep !== 'none' && cache.outcome !== 'completed')
      )
        continue;
      try {
        const path = this.path(ledger, 'unused');
        if (!within(dirname(path), cache.path) || cache.path === dirname(path))
          throw new Error('Cache path escaped run directory.');
        const invocation = this.invocation(cache.stepId, {
          reportUsage: () => {
            throw new Error(
              'Usage reporting is only available inside an active local step callback.',
            );
          },
          cwd: this.record.cwd,
          signal: new AbortController().signal,
          attempt: cache.attempt,
          idempotencyKey: `${this.record.id}/${cache.stepId}`,
        });
        const key = await this.adminKey(ledger, invocation);
        const registered = await administerBounded(key, () =>
          this.driver().run(ledger.repo, ['worktree', 'list', '--porcelain', '-z'], invocation, {
            timeoutMs: 10_000,
          }),
        );
        if (!registered.stdout.split('\0').includes(`worktree ${cache.path}`)) {
          const exists = await lstat(cache.path).catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
              return undefined;
            throw error;
          });
          if (exists)
            throw new Error(
              'Unregistered directory exists at the cache path; refusing to remove it.',
            );
          cache.state = 'removed';
          continue;
        }
        await administerBounded(key, () =>
          this.driver().run(
            ledger.repo,
            ['worktree', 'remove', '--force', cache.path],
            invocation,
            {
              timeoutMs: 10_000,
            },
          ),
        );
        cache.state = 'removed';
      } catch (error) {
        if (error instanceof CheckpointError) throw error;
        const warning = `Could not remove worktree cache ${cache.path}: ${error instanceof Error ? error.message : String(error)}`;
        this.warn(warning);
        warnings.push(warning);
      }
    }
    return warnings;
  }
}

/**
 * The step context members setup receives. Setup is not a durable callback, so a caller's
 * `context.exec` (present on a full StepContext at runtime) is never passed on.
 */
function setupContext(context: Omit<StepContext, 'exec'>): Omit<StepContext, 'exec'> {
  const { reportUsage, cwd, signal, idempotencyKey, attempt } = context;
  return { reportUsage, cwd, signal, idempotencyKey, attempt };
}
