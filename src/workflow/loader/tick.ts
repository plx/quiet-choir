import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ExecutionPlan, ExecutionResult, Executor } from '../../application/execution.js';
import { answerCandidates, questionCodeChanged } from '../runtime/inbox.js';
import { FileRunStore, type OwnedRunStore, type RunStore } from '../runtime/run-store.js';
import { inspectRunOwnership, type RunRecord } from '../runtime/store.js';
import { readRequiredRun } from '../runtime/read-required-run.js';
import { isValidRunId, runIdMessage, RunRefusedError } from '../runtime/run-errors.js';
import { WorkflowExecutor, type WorkflowExecutorOptions } from './executor.js';
import { workflowFailure, type WorkflowFailure } from './failure.js';

/** One pass or bounded watch over plain checkpoint readiness. No scheduler is installed. */
export interface TickWorkflowsPlan extends ExecutionPlan {
  readonly kind: 'workflow.tick';
  readonly stateDir: string;
  readonly runId?: string;
  readonly watch?: boolean;
  readonly timeoutMs?: number;
  readonly maxRuns?: number;
  readonly notifyCommand?: string;
}

/** Counts executions and reports each run's latest observed outcome in this invocation. */
export interface TickWorkflowsResult extends ExecutionResult {
  readonly kind: 'workflow.tick.result';
  readonly ok: true;
  readonly resumed: number;
  readonly completed: readonly string[];
  readonly suspended: readonly { readonly runId: string; readonly nextWakeAt: number | null }[];
  readonly failed: readonly { readonly runId: string; readonly message: string }[];
  readonly skipped: readonly { readonly runId: string; readonly reason: string }[];
  readonly incompatible: readonly { readonly runId: string; readonly message: string }[];
  /** With --run, mirrors completion, suspension, or failure. Batch operation returns zero. */
  readonly exitCode: 0 | 75 | 1;
}

async function due(run: RunRecord, stateDir: string): Promise<boolean> {
  if (run.status !== 'suspended') return false;
  if (run.nextWakeAt != null && run.nextWakeAt <= Date.now()) return true;
  for (const [id, step] of Object.entries(run.steps)) {
    if (step.status !== 'waiting' || !step.question) continue;
    for (const path of answerCandidates(stateDir, run.id, id)) {
      const file = await stat(path).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      });
      if (file?.isFile()) return true;
    }
  }
  return false;
}

/** Transfer the already-held writer to the runtime, releasing it exactly once on every path. */
function claimedStore(
  file: FileRunStore,
  runId: string,
  owned: OwnedRunStore,
): {
  store: RunStore;
  release: () => Promise<void>;
} {
  let claimed = false;
  let released: Promise<void> | undefined;
  const release = (): Promise<void> => (released ??= owned.release());
  return {
    release,
    store: {
      stateDir: file.stateDir,
      read: (id) => file.read(id),
      list: () => file.list(),
      open: (id) => {
        if (id !== runId || claimed || released)
          return Promise.reject(new Error('Tick writer can only be claimed once for its run.'));
        claimed = true;
        return Promise.resolve({
          read: () => owned.read(),
          append: (record, options) => owned.append(record, options),
          compact: () => owned.compact(),
          artifacts: (stepId, attempt) => owned.artifacts(stepId, attempt),
          trackProcess: (invocation, child) => owned.trackProcess(invocation, child),
          release,
        });
      },
    },
  };
}

/** Wait on inbox events or the earliest deadline; periodic rescans cover missed filesystem events. */
async function waitForChange(
  stateDir: string,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let watcher: FSWatcher | undefined;
    const finish = (): void => {
      clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.min(1_000, Math.max(1, milliseconds)));
    signal.addEventListener('abort', finish, { once: true });
    try {
      watcher = watch(stateDir, { recursive: true }, (_event, filename) => {
        if (filename?.endsWith('.answer.json')) finish();
      });
      watcher.on('error', () => {
        watcher?.close();
        // Keep the fallback timer: repeated watcher failures must not create a busy loop.
      });
    } catch {
      // A missing directory or unsupported filesystem still receives bounded periodic scans.
    }
    if (signal.aborted) finish();
  });
}

/** Own due runs before imports; concurrent ticks share the ordinary run lock. @internal */
export class TickWorkflowExecutor implements Executor<
  TickWorkflowsPlan,
  TickWorkflowsResult | WorkflowFailure
> {
  public constructor(private readonly options: WorkflowExecutorOptions) {}

  public async execute(plan: TickWorkflowsPlan): Promise<TickWorkflowsResult | WorkflowFailure> {
    const context = { runId: plan.runId ?? null, stateDir: plan.stateDir };
    const timeoutMs = plan.timeoutMs ?? 540_000;
    const maxRuns = plan.maxRuns ?? Number.MAX_SAFE_INTEGER;
    if (plan.runId !== undefined && !isValidRunId(plan.runId))
      return workflowFailure('usage.run_id', runIdMessage, context);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxRuns) ||
      maxRuns < 1
    )
      return workflowFailure(
        'usage.flag',
        'Tick requires a positive integer maxRuns and timeoutMs from 1 to 2147483647.',
        context,
      );
    const timer = new AbortController();
    const deadline = Date.now() + timeoutMs;
    const timeout = setTimeout(() => {
      timer.abort(new Error('Tick timeout reached.'));
    }, timeoutMs);
    const signal =
      this.options.signal === undefined
        ? timer.signal
        : AbortSignal.any([timer.signal, this.options.signal]);
    const store = new FileRunStore(plan.stateDir);
    const completed = new Set<string>();
    const suspended = new Map<string, number | null>();
    const failed = new Map<string, string>();
    const skipped = new Map<string, string>();
    const incompatible = new Map<string, string>();
    let resumed = 0;
    const observe = (run: RunRecord): void => {
      suspended.delete(run.id);
      skipped.delete(run.id);
      if (run.status === 'completed') completed.add(run.id);
      else if (run.status === 'suspended') suspended.set(run.id, run.nextWakeAt ?? null);
      else if (run.status === 'failed' || run.status === 'cancelled')
        failed.set(run.id, run.error ?? run.status);
      else skipped.set(run.id, run.status);
    };
    try {
      for (;;) {
        const ids = plan.runId === undefined ? await store.list() : [plan.runId];
        for (const id of ids) {
          if (signal.aborted || resumed >= maxRuns) break;
          if (failed.has(id) || incompatible.has(id) || completed.has(id)) continue;
          let claim: ReturnType<typeof claimedStore> | undefined;
          try {
            let run = await readRequiredRun({ stateDir: plan.stateDir, runId: id });
            observe(run);
            if (!(await due(run, plan.stateDir))) {
              if (run.status === 'suspended') skipped.set(id, 'not due');
              continue;
            }
            if ((await inspectRunOwnership({ stateDir: plan.stateDir, runId: id })).locked) {
              skipped.set(id, 'locked');
              continue;
            }
            if (!run.launch || (await questionCodeChanged(run)) !== false) {
              incompatible.set(
                id,
                run.launch
                  ? 'Stored workflow source hashes are missing or changed.'
                  : 'No stored entrypoint; resume through the original application.',
              );
              continue;
            }
            const owned = await store.open(id, {
              cwd: run.cwd,
              signal,
              ...(this.options.processSupervisor === undefined
                ? {}
                : { processSupervisor: this.options.processSupervisor }),
            });
            claim = claimedStore(store, id, owned);
            const latest = await owned.read();
            if (!latest) throw new Error(`Run ${id} disappeared after acquiring ownership.`);
            run = latest;
            observe(run);
            if (!(await due(run, plan.stateDir))) {
              skipped.set(id, 'no longer due');
              continue;
            }
            if (!run.launch || (await questionCodeChanged(run)) !== false) {
              incompatible.set(id, 'Stored workflow source hashes are missing or changed.');
              continue;
            }
            const result = await new WorkflowExecutor({
              ...this.options,
              store: claim.store,
              signal,
            }).execute({
              kind: 'workflow.resume',
              runId: id,
              stateDir: plan.stateDir,
              waitMode: 'suspend',
              ...(plan.notifyCommand === undefined ? {} : { notifyCommand: plan.notifyCommand }),
              ...(this.options.harness === undefined && run.harness?.kind === 'cli'
                ? { harness: { kind: 'cli' as const, config: {} } }
                : {}),
            });
            resumed++;
            skipped.delete(id);
            if (!result.ok) {
              if (result.code === 'run.incompatible') incompatible.set(id, result.message);
              else failed.set(id, result.message);
              if (result.run) observe(result.run);
            } else if (result.kind === 'workflow.run.result') observe(result.run);
            else throw new Error('Tick resume returned an unexpected result.');
          } catch (error) {
            if (error instanceof RunRefusedError && error.code === 'run.locked')
              skipped.set(id, 'locked');
            else failed.set(id, error instanceof Error ? error.message : String(error));
          } finally {
            await claim?.release();
          }
        }
        if (
          !plan.watch ||
          signal.aborted ||
          resumed >= maxRuns ||
          (plan.runId !== undefined &&
            (completed.has(plan.runId) || failed.has(plan.runId) || incompatible.has(plan.runId)))
        )
          break;
        const next = [...suspended]
          .filter(([id]) => !incompatible.has(id) && !failed.has(id))
          .flatMap(([, at]) => (at === null || at <= Date.now() ? [] : [at]));
        await waitForChange(plan.stateDir, Math.min(deadline, ...next) - Date.now(), signal);
      }
      if (this.options.signal?.aborted)
        return workflowFailure('workflow.interrupted', 'Tick interrupted.', context);
      return {
        kind: 'workflow.tick.result',
        ok: true,
        resumed,
        completed: [...completed],
        suspended: [...suspended].map(([runId, nextWakeAt]) => ({ runId, nextWakeAt })),
        failed: [...failed].map(([runId, message]) => ({ runId, message })),
        skipped: [...skipped].map(([runId, reason]) => ({ runId, reason })),
        incompatible: [...incompatible].map(([runId, message]) => ({ runId, message })),
        exitCode:
          plan.runId === undefined || completed.has(plan.runId)
            ? 0
            : failed.has(plan.runId) || incompatible.has(plan.runId)
              ? 1
              : 75,
      };
    } catch (error) {
      return workflowFailure(
        'run.unreadable',
        error instanceof Error ? error.message : String(error),
        context,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
