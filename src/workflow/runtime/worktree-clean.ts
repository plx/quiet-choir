import { WorktreeGit } from '../../worktrees/git.js';
import type { ProcessRunner } from './exec-model.js';
import type { HarnessInvocation } from './model.js';
import { FileRunStore } from './run-store.js';
import { readRequiredRun } from './read-required-run.js';
import { checkpointError } from './checkpoint.js';
import { RunWorktrees } from './worktrees.js';
import type { ProcessSupervisor } from '../../processes/supervisor.js';

/** Source-free cleanup result; missing refs/caches are safe to clean repeatedly. @internal */
export interface WorktreeCleanResult {
  readonly runId: string;
  readonly directories: readonly string[];
  readonly refs: readonly string[];
  readonly warnings: readonly string[];
}

/** Acquire the usual run writer and orphan guards before removing owned caches or pins. @internal */
export async function cleanWorktrees(
  options: { readonly runId: string; readonly stateDir: string; readonly refs?: boolean },
  runner: ProcessRunner,
  signal?: AbortSignal,
  supervisor?: ProcessSupervisor,
): Promise<WorktreeCleanResult> {
  const initial = await readRequiredRun(options);
  const owned = await new FileRunStore(options.stateDir).open(options.runId, {
    cwd: initial.cwd,
    ...(signal === undefined ? {} : { signal }),
    ...(supervisor === undefined ? {} : { processSupervisor: supervisor }),
  });
  try {
    const record = await owned.read();
    if (!record) throw new Error('Run disappeared before cleanup acquired ownership.');
    const ledger = record.worktrees;
    if (!ledger) return { runId: record.id, directories: [], refs: [], warnings: [] };
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
    const refs: string[] = [];
    if (options.refs) {
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
      runId: record.id,
      directories: candidates
        .filter((cache) => cache.state === 'removed')
        .map((cache) => cache.path),
      refs,
      warnings,
    };
  } finally {
    await owned.release();
  }
}
