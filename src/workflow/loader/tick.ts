import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ExecutionPlan, ExecutionResult, Executor } from '../../application/execution.js';
import { answerCandidates, questionCodeChanged } from '../runtime/inbox.js';
import { FileRunStore, type OwnedRunStore, type RunStore } from '../runtime/run-store.js';
import { inspectRunOwnership, type RunRecord } from '../runtime/store.js';
import { readRequiredRun } from '../runtime/read-required-run.js';
import { isValidRunId, runIdMessage, RunRefusedError } from '../runtime/run-errors.js';
import { clockNow, systemClock } from '../runtime/clock.js';
import { OrphanProcessesError } from '../runtime/process-registry.js';
import {
  classifyRecovery,
  countCompletedSteps,
  crashLoopMessage,
  decideStaleRecovery,
} from '../runtime/recovery-decision.js';
import { WorkflowExecutor, type WorkflowExecutorOptions } from './executor.js';
import { workflowFailure, type WorkflowFailure } from './failure.js';
import type { HarnessSelection } from './harness-selection.js';

/** One pass or bounded watch over plain checkpoint readiness. No scheduler is installed. */
export interface TickWorkflowsPlan extends ExecutionPlan {
  readonly kind: 'workflow.tick';
  readonly stateDir: string;
  readonly runId?: string;
  readonly watch?: boolean;
  readonly timeoutMs?: number;
  readonly maxRuns?: number;
  readonly notifyCommand?: string;
  /** CLI harness configuration for resumed runs; the checkpoint stores only harness kind. */
  readonly harness?: HarnessSelection;
}

/** What a resume started by this tick ended as. @internal */
export type TickResumeOutcome = 'completed' | 'suspended' | 'failed' | 'cancelled' | 'incompatible';

/** One run whose resume this tick actually started, with its latest outcome. @internal */
export interface TickResumedEntry {
  readonly runId: string;
  readonly outcome: TickResumeOutcome;
  /** Present exactly for a suspended outcome; null when only a signal can wake the run. */
  readonly nextWakeAt?: number | null;
  /** Present for failed, cancelled, and incompatible outcomes. */
  readonly message?: string;
}

/**
 * Why this tick left a run alone. `locked`: a live, unknown or remote owner, incomplete lock
 * metadata, or a lock recovery in progress. `orphans`: the owner is gone, but a child process is
 * alive or unverified. `crash-loop`: the run was already recovered from a stale `running` state
 * the maximum number of consecutive times without completing a new step. @internal
 */
export type TickSkipReason =
  'not due' | 'no longer due' | 'locked' | 'orphans' | 'crash-loop' | 'incompatible' | 'unreadable';

/** One run this tick inspected but did not resume. @internal */
export interface TickSkippedEntry {
  readonly runId: string;
  readonly reason: TickSkipReason;
  /** Present for orphans, crash-loop, incompatible and unreadable runs. */
  readonly message?: string;
  /** Present for runs that are not due or no longer due. */
  readonly nextWakeAt?: number | null;
}

/**
 * Reports what this invocation did. Each run appears in at most one of `resumed` and `skipped`;
 * already-terminal runs are only counted in `observed`.
 */
export interface TickWorkflowsResult extends ExecutionResult {
  readonly kind: 'workflow.tick.result';
  readonly ok: true;
  /** Runs whose resume started, with each run's latest outcome in this invocation. */
  readonly resumed: readonly TickResumedEntry[];
  /** Runs inspected but not resumed, unless this invocation also resumed them. */
  readonly skipped: readonly TickSkippedEntry[];
  /** Runs found completed, failed, or cancelled without being resumed by this invocation. */
  readonly observed: number;
  /**
   * Batch operation returns 0. With --run: 0 when the run completed, in this tick or before; 1 when
   * it failed, was cancelled, or is incompatible, unreadable or crash-looping; 75 when it is still
   * pending (not due, no longer due, suspended again, locked, or blocked by orphan processes).
   */
  readonly exitCode: 0 | 75 | 1;
}

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

type TickEntry =
  | { readonly type: 'resumed'; readonly entry: TickResumedEntry }
  | { readonly type: 'skipped'; readonly entry: TickSkippedEntry }
  | { readonly type: 'observed'; readonly status: TerminalStatus };

function terminalStatus(run: RunRecord): TerminalStatus | undefined {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
    ? run.status
    : undefined;
}

/** Map one resume result to its outcome; an unexpected result shape throws. */
function resumeOutcome(
  runId: string,
  result: Awaited<ReturnType<WorkflowExecutor['execute']>>,
): TickResumedEntry {
  if (!result.ok) {
    const outcome: TickResumeOutcome =
      result.code === 'run.incompatible'
        ? 'incompatible'
        : result.code === 'workflow.interrupted' || result.run?.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
    return { runId, outcome, message: result.message };
  }
  if (result.kind !== 'workflow.run.result')
    throw new Error('Tick resume returned an unexpected result.');
  const run = result.run;
  if (run.status === 'completed') return { runId, outcome: 'completed' };
  if (run.status === 'suspended')
    return { runId, outcome: 'suspended', nextWakeAt: run.nextWakeAt ?? null };
  if (run.status === 'failed' || run.status === 'cancelled')
    return { runId, outcome: run.status, message: run.error ?? run.status };
  throw new Error('Tick resume returned an unexpected result.');
}

/**
 * The --run exit code implied by one classification of the run. Crash-loop is final, like an
 * incompatible run; orphans stay pending because live children may still exit.
 */
function exitFor(entry: TickEntry): 0 | 75 | 1 {
  if (entry.type === 'observed') return entry.status === 'completed' ? 0 : 1;
  if (entry.type === 'skipped')
    return entry.entry.reason === 'incompatible' ||
      entry.entry.reason === 'unreadable' ||
      entry.entry.reason === 'crash-loop'
      ? 1
      : 75;
  const { outcome } = entry.entry;
  return outcome === 'completed' ? 0 : outcome === 'suspended' ? 75 : 1;
}

/** Whether later watch passes must leave the run alone, as tick never retries a finished run. */
function isFinal(entry: TickEntry): boolean {
  return exitFor(entry) !== 75;
}

async function due(run: RunRecord, stateDir: string, now: number): Promise<boolean> {
  if (run.status !== 'suspended') return false;
  if (run.nextWakeAt != null && run.nextWakeAt <= now) return true;
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
  const transcript = owned.transcript?.bind(owned);
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
          // Agent attempts need the transcript port unless the saved policy turns transcripts off.
          ...(transcript === undefined ? {} : { transcript }),
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
    const clock = this.options.clock ?? systemClock;
    const entries = new Map<string, TickEntry>();
    const final = new Set<string>();
    // Latest known wake time per pending run, kept apart from sticky resumed entries.
    const wakes = new Map<string, number | null>();
    let attempts = 0;
    let runExit: 0 | 75 | 1 = 75;
    const record = (runId: string, entry: TickEntry): void => {
      // A run this tick resumed stays reported as resumed; only a later resume replaces it.
      if (entry.type === 'resumed' || entries.get(runId)?.type !== 'resumed')
        entries.set(runId, entry);
      if (isFinal(entry)) final.add(runId);
      const wake = entry.type === 'observed' ? undefined : entry.entry.nextWakeAt;
      if (wake === undefined) wakes.delete(runId);
      else wakes.set(runId, wake);
      if (runId === plan.runId) runExit = exitFor(entry);
    };
    const skip = (runId: string, reason: TickSkipReason, extra: Partial<TickSkippedEntry> = {}) => {
      record(runId, { type: 'skipped', entry: { runId, reason, ...extra } });
    };
    /**
     * Record a run that cannot be resumed now; returns false when it is due or stale. A `running`
     * run is stale only once its owner is known to be gone, which the caller checks separately.
     */
    const classify = async (run: RunRecord, notDue: 'not due' | 'no longer due') => {
      const terminal = terminalStatus(run);
      if (terminal !== undefined) record(run.id, { type: 'observed', status: terminal });
      else if (run.status === 'running') return false;
      else if (!(await due(run, plan.stateDir, clockNow(clock))))
        skip(run.id, notDue, { nextWakeAt: run.nextWakeAt ?? null });
      else return false;
      return true;
    };
    /** Skip a stale run that already reached the crash-loop cap; returns the decision otherwise. */
    const staleDecision = (run: RunRecord) => {
      const decision = decideStaleRecovery(
        run.staleRecovery,
        countCompletedSteps(run),
        new Date(clockNow(clock)).toISOString(),
      );
      if (decision.kind === 'crash-loop')
        skip(run.id, 'crash-loop', { message: crashLoopMessage(run.id, decision.count) });
      return decision;
    };
    try {
      for (;;) {
        const ids = plan.runId === undefined ? await store.list() : [plan.runId];
        for (const id of ids) {
          if (signal.aborted || attempts >= maxRuns) break;
          if (final.has(id)) continue;
          let claim: ReturnType<typeof claimedStore> | undefined;
          let executing = false;
          try {
            let run = await readRequiredRun({ stateDir: plan.stateDir, runId: id });
            if (await classify(run, 'not due')) continue;
            // A running run reaching here is a stale-recovery candidate and bypasses due().
            const ownership = await inspectRunOwnership({ stateDir: plan.stateDir, runId: id });
            const recovery = classifyRecovery(ownership);
            if (recovery === 'held') {
              skip(id, 'locked');
              continue;
            }
            if (recovery === 'orphans') {
              skip(id, 'orphans', {
                message: new OrphanProcessesError(id, ownership.processes).message,
              });
              continue;
            }
            // Leave a crash-looping run, and any dead lock it holds, untouched.
            if (run.status === 'running' && staleDecision(run).kind === 'crash-loop') continue;
            if (!run.launch || (await questionCodeChanged(run)) !== false) {
              skip(id, 'incompatible', {
                message: run.launch
                  ? 'Stored workflow source hashes are missing or changed.'
                  : 'No stored entrypoint; resume through the original application.',
              });
              continue;
            }
            // Ordinary lock recovery reclaims a dead or released owner; orphans are never killed.
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
            // A concurrent tick may have finished or resumed the run before this one got the lock.
            if (await classify(run, 'no longer due')) continue;
            if (!run.launch || (await questionCodeChanged(run)) !== false) {
              skip(id, 'incompatible', {
                message: 'Stored workflow source hashes are missing or changed.',
              });
              continue;
            }
            // Still running under our ownership: the previous owner is provably gone. Count the
            // recovery durably before resuming, so a run that crashes every time stops at the cap.
            if (latest.status === 'running') {
              const decision = staleDecision(latest);
              if (decision.kind === 'crash-loop') continue;
              latest.staleRecovery = decision.staleRecovery;
              await owned.append(latest, {
                durable: true,
                context: 'Could not save stale recovery count',
              });
            }
            executing = true;
            let result: Awaited<ReturnType<WorkflowExecutor['execute']>>;
            try {
              result = await new WorkflowExecutor({
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
                  ? { harness: plan.harness ?? { kind: 'cli' as const, config: {} } }
                  : {}),
              });
            } finally {
              attempts++;
            }
            record(id, { type: 'resumed', entry: resumeOutcome(id, result) });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (executing)
              record(id, { type: 'resumed', entry: { runId: id, outcome: 'failed', message } });
            // Children appeared or stayed unverified between inspection and lock recovery.
            else if (error instanceof OrphanProcessesError) skip(id, 'orphans', { message });
            else if (error instanceof RunRefusedError && error.code === 'run.locked')
              skip(id, 'locked');
            else skip(id, 'unreadable', { message });
          } finally {
            await claim?.release();
          }
        }
        if (
          !plan.watch ||
          signal.aborted ||
          attempts >= maxRuns ||
          (plan.runId !== undefined && final.has(plan.runId))
        )
          break;
        const now = clockNow(clock);
        const next = [...wakes.values()].flatMap((at) => (at === null || at <= now ? [] : [at]));
        const untilDeadline = deadline - Date.now();
        const untilNext = next.length > 0 ? Math.min(...next) - now : Infinity;
        await waitForChange(plan.stateDir, Math.min(untilDeadline, untilNext), signal);
      }
      if (this.options.signal?.aborted)
        return workflowFailure('workflow.interrupted', 'Tick interrupted.', context);
      const resumed: TickResumedEntry[] = [];
      const skipped: TickSkippedEntry[] = [];
      let observed = 0;
      for (const entry of entries.values()) {
        if (entry.type === 'resumed') resumed.push(entry.entry);
        else if (entry.type === 'skipped') skipped.push(entry.entry);
        else observed++;
      }
      return {
        kind: 'workflow.tick.result',
        ok: true,
        resumed,
        skipped,
        observed,
        exitCode: plan.runId === undefined ? 0 : runExit,
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
