import { WorktreeGit } from '../../worktrees/git.js';
import type { ProcessRunner } from './exec-model.js';
import type { CommandLauncher } from './commands.js';
import type { HarnessInvocation } from './model.js';
import { FileRunStore, type OwnedRunStore } from './run-store.js';
import { readRequiredRun } from './read-required-run.js';
import { checkpointError } from './checkpoint.js';
import { RunWorktrees } from './worktrees.js';
import type { RunRecord } from './store.js';
import type { ProcessSupervisor } from '../../processes/supervisor.js';

/** Source-free cleanup result; missing refs/caches are safe to clean repeatedly. @internal */
export interface WorktreeCleanResult {
  readonly runId: string;
  readonly directories: readonly string[];
  readonly refs: readonly string[];
  readonly warnings: readonly string[];
}

/** What {@link cleanOwnedWorktrees} did under an existing writer. @internal */
export interface OwnedWorktreeCleanup {
  /** Cache paths removed by this call. */
  readonly directories: readonly string[];
  /** Pinned refs deleted by this call. */
  readonly refs: readonly string[];
  /** Caches that could not be removed, and why. */
  readonly warnings: readonly string[];
  /** Cache paths whose ledger state is still not `removed` afterwards. */
  readonly remaining: readonly string[];
}

/**
 * Remove a run's ledger-owned caches and, with `refs`, its pinned refs, under a writer the caller
 * already holds. Git worktree administration runs under the ADR 0032 interprocess lock inside
 * `RunWorktrees.cleanup`; every ledger change is saved through `owned`. With `refsOnlyWhenClean`,
 * refs are kept while any cache remains. A run without a ledger changes nothing. @internal
 */
export async function cleanOwnedWorktrees(
  owned: OwnedRunStore,
  record: RunRecord,
  options: {
    readonly stateDir: string;
    readonly refs?: boolean;
    readonly refsOnlyWhenClean?: boolean;
  },
  runner: ProcessRunner,
  signal?: AbortSignal,
): Promise<OwnedWorktreeCleanup> {
  const ledger = record.worktrees;
  if (!ledger) return { directories: [], refs: [], warnings: [], remaining: [] };
  const controller = new AbortController();
  const invocation = (
    id: string,
    attempt: number,
    operationSignal: AbortSignal,
  ): HarnessInvocation => ({
    runId: record.id,
    stepId: id,
    attempt,
    signal: operationSignal,
    trackProcess: async (child) => {
      try {
        return await owned.trackProcess({ runId: record.id, stepId: id, attempt }, child);
      } catch (cause) {
        throw await checkpointError(
          'process',
          options.stateDir,
          record.id,
          cause,
          'Could not record cleanup process',
        );
      }
    },
  });
  const save = async (): Promise<void> => {
    record.updatedAt = new Date().toISOString();
    await owned.append(record);
  };
  const candidates = Object.values(ledger.caches).filter((cache) => cache.state !== 'removed');
  const worktrees = new RunWorktrees(record, runner, { keep: 'none' }, save, (id, context) =>
    invocation(id, context.attempt, signal ?? context.signal),
  );
  const warnings = await worktrees.cleanup(true);
  signal?.throwIfAborted();
  await save();
  const remaining = Object.values(ledger.caches)
    .filter((cache) => cache.state !== 'removed')
    .map((cache) => cache.path);
  const refs: string[] = [];
  if (options.refs && !(options.refsOnlyWhenClean && remaining.length)) {
    const git = new WorktreeGit(runner);
    const call = invocation('worktree-clean', 1, signal ?? controller.signal);
    for (const [ref, commit] of Object.entries(ledger.refs)) {
      signal?.throwIfAborted();
      if (!ref.startsWith(`refs/quiet-choir/${record.id}/${ledger.namespace}/`))
        throw new Error('Ref is outside this run’s worktree namespace.');
      const current = await git.run(ledger.repo, ['show-ref', '--verify', '--hash', ref], call, {
        codes: [0, 1, 128],
      });
      if (current.code !== 0) {
        // --quiet distinguishes an absent name from a broken repository without relying on localized stderr.
        const exists = await git.run(
          ledger.repo,
          ['rev-parse', '--verify', '--quiet', '--end-of-options', ref],
          call,
          { codes: [0, 1] },
        );
        if (exists.code === 0) throw new Error(`Cannot inspect owned ref ${ref}.`);
      } else {
        const symbolic = await git.run(ledger.repo, ['symbolic-ref', '-q', ref], call, {
          codes: [0, 1],
        });
        if (symbolic.code === 0 || current.stdout.trim() !== commit)
          throw new Error(`Owned ref ${ref} changed; cleanup refuses to delete it.`);
        await git.run(ledger.repo, ['update-ref', '--no-deref', '-d', ref, commit], call);
      }
      Reflect.deleteProperty(ledger.refs, ref);
      refs.push(ref);
      await save();
    }
  }
  return {
    directories: candidates.filter((cache) => cache.state === 'removed').map((cache) => cache.path),
    refs,
    warnings,
    remaining,
  };
}

/** Acquire the usual run writer and orphan guards before removing owned caches or pins. @internal */
export async function cleanWorktrees(
  options: {
    readonly runId: string;
    readonly stateDir: string;
    readonly refs?: boolean;
    /** Shapes the `workflow unlock` command of a `run.locked` refusal. */
    readonly commandLauncher?: CommandLauncher | undefined;
  },
  runner: ProcessRunner,
  signal?: AbortSignal,
  supervisor?: ProcessSupervisor,
): Promise<WorktreeCleanResult> {
  const initial = await readRequiredRun(options);
  const owned = await new FileRunStore(options.stateDir).open(options.runId, {
    cwd: initial.cwd,
    commandLauncher: options.commandLauncher,
    ...(signal === undefined ? {} : { signal }),
    ...(supervisor === undefined ? {} : { processSupervisor: supervisor }),
  });
  try {
    const record = await owned.read();
    if (!record) throw new Error('Run disappeared before cleanup acquired ownership.');
    const { directories, refs, warnings } = await cleanOwnedWorktrees(
      owned,
      record,
      { stateDir: options.stateDir, ...(options.refs === undefined ? {} : { refs: options.refs }) },
      runner,
      signal,
    );
    return { runId: record.id, directories, refs, warnings };
  } finally {
    await owned.release();
  }
}
