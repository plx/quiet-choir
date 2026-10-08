import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExecutionPlan, ExecutionResult, Executor } from '../../application/execution.js';
import { answerCandidates, questionCodeChanged } from '../runtime/inbox.js';
import {
  FileRunStore,
  reclaimedOwnerToken,
  type OwnedRunStore,
  type RunStore,
} from '../runtime/run-store.js';
import {
  readBoundCancelRequest,
  readCancelRequest,
  removeCancelRequest,
} from '../runtime/cancel-request.js';
import { runCancelRequestPath } from '../runtime/paths.js';
import { saveCancelledUnderLock } from '../runtime/run-cancellation.js';
import {
  inspectRunOwnership,
  recordSchemaDrift,
  recordSchemaRefusalMessage,
  type RunRecord,
} from '../runtime/store.js';
import { readRequiredRun } from '../runtime/read-required-run.js';
import {
  isValidRunId,
  runIdMessage,
  RunInterruptedError,
  RunRefusedError,
} from '../runtime/run-errors.js';
import { clockNow, systemClock } from '../runtime/clock.js';
import { killOrphansArgv, type CommandLauncher } from '../runtime/commands.js';
import {
  describeOrphanProcesses,
  OrphanProcessesError,
  type HarnessProcessInspection,
} from '../runtime/process-registry.js';
import {
  classifyRecovery,
  countCompletedSteps,
  crashLoopMessage,
  decideStaleRecovery,
} from '../runtime/recovery-decision.js';
import { WorkflowExecutor, type WorkflowExecutorOptions } from './executor.js';
import { workflowFailure, type WorkflowFailure } from './failure.js';
import { harnessConfigDigest, type HarnessSelection } from './harness-selection.js';
import { harnessConfigRefusal } from '../runtime/harness-config-decision.js';
import { formatArgv } from './next-commands.js';

/** One pass or bounded watch over plain checkpoint readiness. No scheduler is installed. */
export interface TickWorkflowsPlan extends ExecutionPlan {
  readonly kind: 'workflow.tick';
  readonly stateDir: string;
  readonly runId?: string;
  readonly watch?: boolean;
  readonly timeoutMs?: number;
  /**
   * Stop claiming new runs once less than this much of the timeout remains; 0 disables the margin.
   * Defaults to 10% of `timeoutMs` and must be smaller than it.
   */
  readonly claimMarginMs?: number;
  readonly maxRuns?: number;
  readonly notifyCommand?: string;
  /** The event stream every resume of this tick appends to, as on `workflow.execute`. */
  readonly events?: string;
  /**
   * CLI harness configuration for resumed CLI runs; omitted means the default configuration. A run
   * records a digest of the configuration it last executed with, and a CLI run under a different one
   * is skipped as `incompatible`, before tick imports it or counts a stale recovery, unless
   * {@link TickWorkflowsPlan.allowHarnessConfigChange} is set. With fixture selections the runtime
   * applies the same rule and the resume ends `incompatible`.
   */
  readonly harness?: HarnessSelection;
  /**
   * For a run with a recorded launch policy, use its harness kind and fixtures, keeping the
   * configuration of `harness`. Defaults to true when `harness` is omitted; the CLI sets it unless
   * `--harness` was given. A run without a recorded policy keeps the older rule: `harness` (or the
   * default) applies only to a run that last executed with the CLI harness, unless `harness` is
   * explicit (`inheritHarness: false`).
   */
  readonly inheritHarness?: boolean;
  /** Accept a changed harness configuration for every run this tick resumes. */
  readonly allowHarnessConfigChange?: boolean;
}

/** What a resume started by this tick ended as. @internal */
export type TickResumeOutcome =
  'completed' | 'suspended' | 'interrupted' | 'failed' | 'cancelled' | 'incompatible';

/** One run whose resume this tick actually started, with its latest outcome. @internal */
export interface TickResumedEntry {
  readonly runId: string;
  readonly outcome: TickResumeOutcome;
  /** Present exactly for a suspended outcome; null when only a signal can wake the run. */
  readonly nextWakeAt?: number | null;
  /**
   * Present for failed, cancelled, incompatible and interrupted outcomes, and for a suspended outcome
   * caused by an interruption (tick's deadline or a signal), whose run is due again at once. An
   * interrupted outcome means the resume stopped before the runtime reopened a run tick had claimed
   * as stale: the run is still saved as running with no owner, and the next tick recovers it.
   */
  readonly message?: string;
}

/**
 * Why this tick left a run alone. `locked`: a live, unknown or remote owner of either run lock,
 * incomplete lock metadata, or a live, unknown or remote recoverer. `orphans`: the owner is gone, but a child process is
 * alive or unverified. `crash-loop`: the run was already recovered from a stale `running` state
 * the maximum number of consecutive times without completing a new step. `deadline`: the run was
 * due or stale when read but less than the claim margin of this tick's timeout remained (a run first
 * seen inside the margin also gets no lock, orphan, crash-loop or source check), or the timeout
 * passed before the run was read. `cancelled`: tick retired the lock of an owner that a `workflow
 * cancel` had targeted and that exited (force-killed) before saving, and saved the run as cancelled
 * instead of resuming it (ADR 0058); it is final, like any run saved cancelled. @internal
 */
export type TickSkipReason =
  | 'not due'
  | 'no longer due'
  | 'locked'
  | 'orphans'
  | 'crash-loop'
  | 'deadline'
  | 'incompatible'
  | 'unreadable'
  | 'cancelled';

/** One run this tick inspected but did not resume. @internal */
export interface TickSkippedEntry {
  readonly runId: string;
  readonly reason: TickSkipReason;
  /**
   * Present for orphans, crash-loop, incompatible, unreadable and cancelled runs, and for a deadline
   * skip of a run tick never read. An orphans message says tick never signals a process and names
   * the `workflow resume` command with `--kill-orphans`; a cancelled message names the cancel
   * request's time and the exited owner's PID.
   */
  readonly message?: string;
  /** Present for runs that are not due or no longer due, and for deadline skips of runs read. */
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
   * it failed, was saved as cancelled (by its owner, earlier, or by this tick honouring a forced
   * cancel), or is incompatible, unreadable or crash-looping; 75 when it is
   * still pending (not due, no longer due, suspended again or interrupted by the deadline, including
   * a resume interrupted before the runtime reopened the run, locked, blocked by orphan processes,
   * or skipped inside the claim margin).
   */
  readonly exitCode: 0 | 75 | 1;
}

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

type TickEntry =
  | { readonly type: 'resumed'; readonly entry: TickResumedEntry }
  | { readonly type: 'skipped'; readonly entry: TickSkippedEntry }
  | { readonly type: 'observed'; readonly status: TerminalStatus };

/**
 * The message of an `orphans` skip. Tick has no `--kill-orphans` flag and never signals a process,
 * so it names the `resume` command that does instead of the flag-only advice a resume refusal gives.
 */
function tickOrphansMessage(
  runId: string,
  stateDir: string,
  processes: readonly HarnessProcessInspection[],
  launcher: CommandLauncher | undefined,
): string {
  const resume = formatArgv(killOrphansArgv(launcher, stateDir, runId));
  return `${describeOrphanProcesses(runId, processes)} Tick never signals a process: a later tick retries the run once they exit, or stop confirmed ones with ${resume}. Unverified identities are never signaled; inspect the retained lock.`;
}

/** The message of a `deadline` skip for a run tick's fired timeout left unread. */
const unreadDeadlineMessage =
  "Tick's timeout passed before this run was read; a later tick checks it.";

function terminalStatus(run: RunRecord): TerminalStatus | undefined {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
    ? run.status
    : undefined;
}

/**
 * Map one resume result to its outcome; an unexpected result shape throws. An interruption is
 * classified by the status saved on disk, not by the failure code alone. @internal
 */
export function resumeOutcome(
  runId: string,
  result: Awaited<ReturnType<WorkflowExecutor['execute']>>,
): TickResumedEntry {
  if (!result.ok) {
    if (result.code === 'workflow.interrupted') {
      // An interruption (the deadline or a signal) leaves a resumable suspension that is due now. This
      // also covers an interruption before the runtime reopened the run, which stays suspended.
      if (result.run?.status === 'suspended')
        return {
          runId,
          outcome: 'suspended',
          nextWakeAt: result.run.nextWakeAt ?? null,
          message: result.message,
        };
      // An interruption before the runtime reopened a stale run leaves it running with no owner; the
      // next tick recovers it as stale, so it is not final.
      if (result.run?.status === 'running')
        return {
          runId,
          outcome: 'interrupted',
          message: `${result.message} The resume stopped before the run was saved as suspended; it is still saved as running with no owner, and the next tick recovers it as stale.`,
        };
      // Anything else, including a record that could not be re-read, cannot be shown to be resumable.
      return {
        runId,
        outcome: result.run?.status === 'cancelled' ? 'cancelled' : 'failed',
        message: result.message,
      };
    }
    const outcome: TickResumeOutcome =
      result.code === 'run.incompatible'
        ? 'incompatible'
        : result.run?.status === 'cancelled'
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
 * incompatible run or one this tick saved cancelled; orphans stay pending because live children may
 * still exit.
 */
function exitFor(entry: TickEntry): 0 | 75 | 1 {
  if (entry.type === 'observed') return entry.status === 'completed' ? 0 : 1;
  if (entry.type === 'skipped')
    return entry.entry.reason === 'incompatible' ||
      entry.entry.reason === 'unreadable' ||
      entry.entry.reason === 'crash-loop' ||
      entry.entry.reason === 'cancelled'
      ? 1
      : 75;
  const { outcome } = entry.entry;
  return outcome === 'completed'
    ? 0
    : outcome === 'suspended' || outcome === 'interrupted'
      ? 75
      : 1;
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

/**
 * The harness part of one run's resume plan. An injected live harness wins. An explicit selection
 * applies to every run; otherwise a run with a recorded launch policy inherits it (keeping the
 * tick's configuration), and an older run keeps the configuration rule for CLI runs only.
 */
function resumeHarness(
  plan: TickWorkflowsPlan,
  run: RunRecord,
  injected: boolean,
): { harness?: HarnessSelection; inheritHarness?: boolean } {
  if (injected) return {};
  const inherit = plan.inheritHarness ?? plan.harness === undefined;
  if (!inherit && plan.harness) return { harness: plan.harness };
  if (run.launch?.policy)
    return {
      ...(plan.harness === undefined ? {} : { harness: plan.harness }),
      inheritHarness: true,
    };
  return run.harness?.kind === 'cli'
    ? { harness: plan.harness ?? { kind: 'cli' as const, config: {} } }
    : {};
}

/**
 * The runtime's harness configuration refusal for one claimed run, predicted before tick counts a
 * stale recovery or imports the workflow; undefined when the resume may proceed or tick cannot be
 * sure. The prediction is made only for a plain CLI selection (no global or named fixtures), whose
 * runtime kind is always `cli`, and digests the configuration exactly as the executor will. An
 * injected live harness carries its own configuration, so the executor passes no digest; fixture
 * selections and other kinds are left to the executor.
 */
function harnessConfigPreflight(
  plan: TickWorkflowsPlan,
  run: RunRecord,
  injected: boolean,
): string | undefined {
  if (injected) return undefined;
  const { harness, inheritHarness } = resumeHarness(plan, run, false);
  const recorded = run.launch?.policy?.harness;
  // An inherited selection keeps only the invocation's configuration and takes its kind and
  // fixtures from the recorded policy; an absent selection is the default CLI one.
  const fixtures =
    inheritHarness && recorded
      ? recorded.kind !== 'cli' || (recorded.fixtures?.length ?? 0) > 0
      : harness !== undefined &&
        (harness.kind !== 'cli' ||
          harness.fixtures !== undefined ||
          Object.keys(harness.named ?? {}).length > 0);
  if (fixtures) return undefined;
  return harnessConfigRefusal({
    runId: run.id,
    previous: run.harness,
    requestedKind: 'cli',
    requestedConfigDigest: harnessConfigDigest(harness),
    allowHarnessConfigChange: plan.allowHarnessConfigChange ?? false,
  })?.message;
}

/**
 * Honour a forced `workflow cancel` under the lock tick just took (ADR 0058): when this writer
 * retired a dead or released owner's lock whose token the run's stored cancel request names, save
 * the unfinished `run` as cancelled, remove that request and return the skip message. Undefined
 * leaves the run to ordinary stale recovery. A request from any other acquisition never matches,
 * since every acquisition draws a fresh token.
 */
async function honourForcedCancel(
  stateDir: string,
  owned: OwnedRunStore,
  run: RunRecord,
): Promise<string | undefined> {
  if (run.status !== 'running' && run.status !== 'suspended') return undefined;
  const reclaimed = reclaimedOwnerToken(owned);
  if (reclaimed === undefined) return undefined;
  const path = runCancelRequestPath(stateDir, run.id);
  const request = await readCancelRequest(path);
  if (request?.token !== reclaimed) return undefined;
  const message = `Run ${run.id} cancelled by workflow cancel (requested ${request.requestedAt}); its owner PID ${String(request.pid)} exited before saving, so stale recovery ended it instead of resuming it.`;
  await saveCancelledUnderLock(owned, run, new Error(message));
  await removeCancelRequest(path, request.requestId);
  return message;
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
    const claimMarginMs = plan.claimMarginMs ?? Math.floor(timeoutMs / 10);
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
    if (!Number.isSafeInteger(claimMarginMs) || claimMarginMs < 0 || claimMarginMs >= timeoutMs)
      return workflowFailure(
        'usage.flag',
        'Tick requires an integer claimMarginMs from 0 to less than timeoutMs.',
        context,
      );
    const timer = new AbortController();
    const deadline = Date.now() + timeoutMs;
    const timeout = setTimeout(() => {
      // A marked interruption: the runtime saves the run as a resumable suspension, due now.
      timer.abort(new RunInterruptedError('Tick timeout reached.'));
    }, timeoutMs);
    /**
     * Whether a claim could no longer finish usefully; stays true after the deadline. A fired
     * deadline always counts, whatever the wall clock says (a margin of 0 would not otherwise).
     */
    const insideMargin = (): boolean =>
      timer.signal.aborted || deadline - Date.now() < claimMarginMs;
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
        skip(run.id, 'crash-loop', {
          message: crashLoopMessage(
            run.id,
            decision.count,
            resolve(plan.stateDir),
            this.options.commandLauncher,
          ),
        });
      return decision;
    };
    try {
      for (;;) {
        const ids = plan.runId === undefined ? await store.list() : [plan.runId];
        for (const id of ids) {
          // Only the external signal and maxRuns end the scan; past the deadline every remaining run
          // is still reported, as skipped for the deadline.
          if (this.options.signal?.aborted || attempts >= maxRuns) break;
          if (final.has(id)) continue;
          // Two deadline phases. Inside the claim margin each record is still read, so terminal,
          // not-due and drifted runs keep their classification, but no lock, orphan, crash-loop or
          // source check runs. Once the timeout has fired no record is read at all: a run without
          // an entry is reported unread, and one an earlier --watch pass reported keeps that entry,
          // the data already in hand, even if it is now slightly stale.
          if (timer.signal.aborted) {
            if (!entries.has(id)) skip(id, 'deadline', { message: unreadDeadlineMessage });
            continue;
          }
          let claim: ReturnType<typeof claimedStore> | undefined;
          let executing = false;
          try {
            let run = await readRequiredRun({ stateDir: plan.stateDir, runId: id });
            if (await classify(run, 'not due')) continue;
            // A due or stale run this build cannot fully read is left untouched for a newer build.
            const drift = recordSchemaDrift(run);
            if (drift) {
              skip(id, 'incompatible', { message: recordSchemaRefusalMessage(id, drift) });
              continue;
            }
            // A due or stale run seen inside the margin is left unexamined: tick inspects no
            // ownership, orphans, crash-loop count or sources, and a later tick classifies it.
            if (insideMargin()) {
              skip(id, 'deadline', { nextWakeAt: run.nextWakeAt ?? null });
              continue;
            }
            // A running run reaching here is a stale-recovery candidate and bypasses due().
            const ownership = await inspectRunOwnership({ stateDir: plan.stateDir, runId: id });
            const recovery = classifyRecovery(ownership);
            if (recovery === 'held') {
              skip(id, 'locked');
              continue;
            }
            if (recovery === 'orphans') {
              skip(id, 'orphans', {
                message: tickOrphansMessage(
                  id,
                  plan.stateDir,
                  ownership.processes,
                  this.options.commandLauncher,
                ),
              });
              continue;
            }
            // A forced cancel's request bound to the dead owner's lock is honoured even for a
            // crash-looping or source-changed run, since cancelling runs no workflow code (ADR 0058).
            // This lock-free match is only a hint; the decision is made under ownership, and a hint
            // that no longer holds there falls through to the post-open checks below.
            const cancelHint = (await readBoundCancelRequest(plan.stateDir, id)) !== undefined;
            // Leave a crash-looping run, and any dead lock it holds, untouched.
            if (!cancelHint && run.status === 'running' && staleDecision(run).kind === 'crash-loop')
              continue;
            if (!cancelHint && (!run.launch || (await questionCodeChanged(run)) !== false)) {
              skip(id, 'incompatible', {
                message: run.launch
                  ? 'Stored workflow source hashes are missing or changed.'
                  : 'No stored entrypoint; resume through the original application.',
              });
              continue;
            }
            // Leave a ready run untouched rather than claim it with too little time to progress:
            // the margin may have started during the checks above.
            if (insideMargin()) {
              skip(id, 'deadline', { nextWakeAt: run.nextWakeAt ?? null });
              continue;
            }
            // Ordinary lock recovery reclaims a dead or released owner; orphans are never killed.
            const owned = await store.open(id, {
              cwd: run.cwd,
              signal,
              commandLauncher: this.options.commandLauncher,
              ...(this.options.processSupervisor === undefined
                ? {}
                : { processSupervisor: this.options.processSupervisor }),
            });
            claim = claimedStore(store, id, owned);
            const latest = await owned.read();
            if (!latest) throw new Error(`Run ${id} disappeared after acquiring ownership.`);
            run = latest;
            // A forced cancel bound to the owner whose lock this tick just retired: save the run
            // cancelled instead of resuming it. Uses no --max-runs attempt and counts no recovery.
            const cancelled = await honourForcedCancel(plan.stateDir, owned, latest);
            if (cancelled !== undefined) {
              skip(id, 'cancelled', { message: cancelled });
              continue;
            }
            // A concurrent tick may have finished or resumed the run before this one got the lock.
            if (await classify(run, 'no longer due')) continue;
            if (!run.launch || (await questionCodeChanged(run)) !== false) {
              skip(id, 'incompatible', {
                message: 'Stored workflow source hashes are missing or changed.',
              });
              continue;
            }
            // A resume the runtime is certain to refuse for its harness configuration is skipped
            // before counting a stale recovery, importing the workflow or using a --max-runs attempt.
            const configRefusal = harnessConfigPreflight(
              plan,
              latest,
              this.options.harness !== undefined,
            );
            if (configRefusal !== undefined) {
              skip(id, 'incompatible', { message: configRefusal });
              continue;
            }
            // Still running under our ownership: the previous owner is provably gone. Count the
            // recovery durably before resuming, so a run that crashes every time stops at the cap.
            // The count is saved before the executor runs so that a crash anywhere in it (import,
            // type check or body) counts. A harness configuration mismatch was refused above and
            // never counts; a refusal found only after import (such as a harness kind change
            // requested with an explicit --harness) still does.
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
                // Suspend for this execution only: blocking one run's waits would hold the batch.
                waitModeOnce: 'suspend',
                ...(plan.notifyCommand === undefined ? {} : { notifyCommand: plan.notifyCommand }),
                ...(plan.events === undefined ? {} : { events: plan.events }),
                ...resumeHarness(plan, run, this.options.harness !== undefined),
                ...(plan.allowHarnessConfigChange === undefined
                  ? {}
                  : { allowHarnessConfigChange: plan.allowHarnessConfigChange }),
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
            else if (error instanceof OrphanProcessesError)
              skip(id, 'orphans', {
                message: tickOrphansMessage(
                  id,
                  plan.stateDir,
                  error.processes,
                  this.options.commandLauncher,
                ),
              });
            else if (error instanceof RunRefusedError && error.code === 'run.locked')
              skip(id, 'locked');
            // A record newer than this build (lock-free or owned read): the same skip as above.
            else if (error instanceof RunRefusedError && error.code === 'run.incompatible')
              skip(id, 'incompatible', { message });
            else skip(id, 'unreadable', { message });
          } finally {
            await claim?.release();
          }
        }
        if (
          !plan.watch ||
          signal.aborted ||
          // No further claim can happen, so do not idle until the hard deadline.
          insideMargin() ||
          attempts >= maxRuns ||
          (plan.runId !== undefined && final.has(plan.runId))
        )
          break;
        const now = clockNow(clock);
        const next = [...wakes.values()].flatMap((at) => (at === null || at <= now ? [] : [at]));
        // Wake when the margin starts, not at the deadline: after that no claim can happen.
        const untilMargin = deadline - claimMarginMs - Date.now();
        const untilNext = next.length > 0 ? Math.min(...next) - now : Infinity;
        await waitForChange(plan.stateDir, Math.min(untilMargin, untilNext), signal);
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
