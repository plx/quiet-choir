import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { pidState, processIdentity } from '../../processes/identity.js';
import { removeCancelRequest, writeCancelRequest } from '../runtime/cancel-request.js';
import { formatArgv, nextDetail, unlockNext, type CommandLauncher } from '../runtime/commands.js';
import { isErrno, ownerState, readContended, type Owner } from '../runtime/lock.js';
import { resolveStateDir, runLockPath } from '../runtime/paths.js';
import { readRequiredRun } from '../runtime/read-required-run.js';
import { cancelUnownedRun } from '../runtime/run-cancellation.js';
import { RunRefusedError } from '../runtime/run-errors.js';
import type { RunRecord } from '../runtime/store.js';
import { workflowFailure, type WorkflowFailure } from './failure.js';
import type { CancelWorkflowPlan, WorkflowCommandResult } from './model.js';

/** The success document of `workflow cancel`. @internal */
export type CancelResult = Extract<
  WorkflowCommandResult,
  { readonly kind: 'workflow.cancel.result' }
>;

/** Live dependencies of a cancel; never part of the plain-data plan. @internal */
export interface CancelRunOptions {
  /** Deliver a signal to one PID (never a group); `process.kill` in production. */
  readonly sendSignal: (pid: number, signal: NodeJS.Signals) => void;
  /** Aborts the wait; the request then stays in place for the owner to honour. */
  readonly signal?: AbortSignal | undefined;
  /** Polling interval of the wait; 100 ms by default. */
  readonly intervalMs?: number;
  /** Shapes the `workflow unlock` command that a `run.locked` refusal names. */
  readonly commandLauncher?: CommandLauncher | undefined;
  /**
   * Ends a run that no lock holds under its lock; `cancelUnownedRun` by default. A test seam for
   * the race between observing no lock and taking it.
   */
  readonly cancelUnowned?: typeof cancelUnownedRun;
}

/** Attempts to end an unlocked run before a contended lock is reported, as in `acquireLock`. */
const unownedAttempts = 3;

type TerminalStatus = CancelResult['status'];

function terminal(status: RunRecord['status']): status is TerminalStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * How an unfinished run continues after its owner exited without saving a terminal status, when its
 * lock is gone or re-owned and no tick retires that owner's lock.
 */
function resumeNote(status: RunRecord['status']): string {
  if (status === 'suspended') return '; otherwise the next workflow tick may resume it';
  if (status === 'running')
    return '; otherwise stale recovery by the next workflow tick may resume it';
  return '';
}

/** Why a lock owner cannot be signalled, or undefined for a live, identity-verified local owner. */
type Unverified =
  | 'foreign-host'
  | 'released'
  | 'os-start-time-missing'
  | 'dead'
  | 'unknown'
  | 'os-start-time-mismatch';

/**
 * Verify that a recorded owner is a live process on this host whose OS birth identity still matches
 * the one it recorded, so a reused PID is never signalled. @internal
 */
export function verifyOwner(owner: Owner): Unverified | undefined {
  if (owner.host !== hostname()) return 'foreign-host';
  if (owner.released) return 'released';
  if (!owner.osStartTime) return 'os-start-time-missing';
  const state = pidState(owner.pid);
  if (state !== 'alive') return state;
  const identity = processIdentity(owner.pid);
  if (!identity?.start) return 'unknown';
  if (identity.zombie) return 'dead';
  return identity.start === owner.osStartTime ? undefined : 'os-start-time-mismatch';
}

type Observed =
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable'; readonly error: unknown }
  | { readonly kind: 'owner'; readonly owner: Owner };

/** Read the owner of the lock that ownership resolves to, tolerating a lock being retired. */
async function observeOwner(lockPath: string): Promise<Observed> {
  try {
    const owner = await readContended(lockPath);
    return owner === 'gone' ? { kind: 'gone' } : { kind: 'owner', owner };
  } catch (error) {
    return { kind: 'unreadable', error };
  }
}

function lockedRefusal(
  runId: string,
  stateDir: string,
  lockPath: string,
  reason: Unverified | 'unreadable-owner',
  owner?: Owner,
  cause?: unknown,
  launcher?: CommandLauncher,
): RunRefusedError {
  const pid = owner === undefined ? '' : `PID ${String(owner.pid)}`;
  // Only the refusals that name unlock carry the entry; the live-owner and foreign-host ones do not.
  const entry =
    reason === 'released'
      ? unlockNext(launcher, stateDir, runId, {
          why: `Works once the children of PID ${String(owner?.pid)} are gone; inspect the run first.`,
        })
      : reason === 'dead' || reason === 'os-start-time-mismatch'
        ? unlockNext(launcher, stateDir, runId, {
            why: `Clears the lock of PID ${String(owner?.pid)}, which is gone.`,
          })
        : undefined;
  const unlock = entry === undefined ? '' : formatArgv(entry.argv);
  const messages: Record<typeof reason, string> = {
    'foreign-host': `Run ${runId} is owned by ${pid} on foreign host ${owner?.host ?? ''}; workflow cancel signals only a live owner on this host.`,
    released: `Run ${runId}'s owner ${pid} released its lock while child processes survive; there is no live owner to cancel. Inspect the run, then clear the lock with ${unlock} once its children are gone.`,
    'os-start-time-missing': `Run ${runId}'s owner ${pid} recorded no OS start time, so its identity cannot be verified and workflow cancel sends no signal.`,
    dead: `Run ${runId}'s owner ${pid} is gone; there is no live owner to cancel. Clear its lock with ${unlock}.`,
    unknown: `Run ${runId}'s owner ${pid} cannot be observed, so workflow cancel sends no signal.`,
    'os-start-time-mismatch': `Run ${runId}'s owner ${pid} no longer has its recorded OS start time: the PID belongs to another process and the owner is gone. Clear its lock with ${unlock}.`,
    'unreadable-owner': `Run ${runId} is locked at ${lockPath} with unreadable ownership metadata, so workflow cancel sends no signal.`,
  };
  return new RunRefusedError(
    'run.locked',
    runId,
    messages[reason],
    {
      lockPath,
      pid: owner?.pid ?? null,
      host: owner?.host ?? null,
      state: owner === undefined ? null : ownerState(owner),
      osStartTime: owner?.osStartTime ?? null,
      reason,
      ...(entry === undefined ? {} : { next: nextDetail([entry]) }),
    },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * End an unfinished run as `cancelled`. A run that no lock holds is ended here, under its lock,
 * without a signal (ADR 0057); a lock taken by an owner or tick meanwhile is observed again, up to
 * three times. A locked run is ended through its owner (ADR 0039): refuses without signalling
 * unless the lock owner is a live process on this host with its recorded birth identity; leaves a
 * request bound to that owner's lock token, so only that execution honours it; re-verifies the
 * owner immediately before each SIGINT; and waits for the run to end. An owner that exits without
 * saving (force-killed) keeps the request bound to its token, which a tick honours when it retires
 * exactly that owner's lock (ADR 0058). Refusals throw `RunRefusedError`; the bounded wait returns a
 * `watch.timeout` failure carrying the last saved record. @internal
 */
export async function cancelRun(
  plan: CancelWorkflowPlan,
  options: CancelRunOptions,
): Promise<CancelResult | WorkflowFailure> {
  const { runId, timeoutMs } = plan;
  const stateDir = resolveStateDir({ stateDir: plan.stateDir });
  const intervalMs = options.intervalMs ?? 100;
  const result = (
    status: TerminalStatus,
    signalsSent: number,
    owner: CancelResult['owner'],
    previousStatus: CancelResult['previousStatus'] = null,
  ): CancelResult => ({
    kind: 'workflow.cancel.result',
    ok: true,
    runId,
    stateDir,
    status,
    signalsSent: signalsSent as CancelResult['signalsSent'],
    owner,
    previousStatus,
  });
  let run = await readRequiredRun({ runId, stateDir });
  // Idempotent: a run that already ended needs nothing, whoever ended it.
  if (terminal(run.status)) return result(run.status, 0, null);
  const lockPath = runLockPath(stateDir, runId);
  const cancelUnowned = options.cancelUnowned ?? cancelUnownedRun;
  let observed = await observeOwner(lockPath);
  for (let attempt = 1; observed.kind === 'gone'; attempt++) {
    // No process owns the run: end it under its lock, which a dead owner's lock never yields.
    try {
      const ended = await cancelUnowned({
        stateDir,
        runId,
        cwd: run.cwd,
        commandLauncher: options.commandLauncher,
        signal: options.signal,
      });
      return result(ended.status, 0, null, ended.previousStatus);
    } catch (error) {
      if (!(error instanceof RunRefusedError && error.code === 'run.locked')) throw error;
      // An owner, tick or another writer took the lock first: look again.
      if (attempt >= unownedAttempts) throw error;
    }
    run = await readRequiredRun({ runId, stateDir });
    if (terminal(run.status)) return result(run.status, 0, null);
    observed = await observeOwner(lockPath);
  }
  if (observed.kind === 'unreadable')
    throw lockedRefusal(
      runId,
      stateDir,
      lockPath,
      'unreadable-owner',
      undefined,
      observed.error,
      options.commandLauncher,
    );
  const { owner } = observed;
  const unverified = verifyOwner(owner);
  if (unverified !== undefined || !owner.osStartTime)
    throw lockedRefusal(
      runId,
      stateDir,
      lockPath,
      unverified ?? 'os-start-time-missing',
      owner,
      undefined,
      options.commandLauncher,
    );
  const target = { pid: owner.pid, host: owner.host, osStartTime: owner.osStartTime };
  const requestId = randomUUID();
  const requestPath = await writeCancelRequest(stateDir, runId, {
    version: 1,
    requestId,
    token: owner.token,
    ...target,
    requestedAt: new Date().toISOString(),
  });
  /** Whether the lock still names the verified owner, alive with its birth identity. */
  const ownerPresent = async (): Promise<boolean> => {
    const current = await observeOwner(lockPath);
    // A lock being retired or rewritten reads as unreadable for a moment: look again later.
    if (current.kind === 'unreadable') return true;
    return (
      current.kind === 'owner' &&
      current.owner.token === owner.token &&
      verifyOwner(current.owner) === undefined
    );
  };
  let signalsSent = 0;
  let forced = false;
  /** Signal the PID only, and only after verifying the owner once more; false when it is gone. */
  const signalOwner = async (): Promise<boolean> => {
    const current = await observeOwner(lockPath);
    if (
      current.kind !== 'owner' ||
      current.owner.token !== owner.token ||
      verifyOwner(current.owner) !== undefined
    )
      return false;
    try {
      options.sendSignal(owner.pid, 'SIGINT');
    } catch (error) {
      if (isErrno(error, 'ESRCH')) return false;
      throw error;
    }
    signalsSent++;
    return true;
  };
  /** Poll until the run is terminal, its owner is gone, or the deadline passes. */
  const settle = async (deadline: number): Promise<'terminal' | 'gone' | 'timeout'> => {
    for (;;) {
      options.signal?.throwIfAborted();
      run = await readRequiredRun({ runId, stateDir });
      if (terminal(run.status)) return 'terminal';
      if (!(await ownerPresent())) {
        // The owner saves its last status before releasing the lock.
        run = await readRequiredRun({ runId, stateDir });
        return terminal(run.status) ? 'terminal' : 'gone';
      }
      const left = deadline - performance.now();
      if (left <= 0) return 'timeout';
      await delay(
        Math.max(1, Math.min(intervalMs, Math.ceil(left))),
        undefined,
        options.signal ? { signal: options.signal } : {},
      );
    }
  };
  await signalOwner();
  for (;;) {
    const outcome = await settle(performance.now() + timeoutMs);
    if (outcome === 'timeout' && plan.force && !forced) {
      // Escalate only now: a second signal right away would force-kill the owner before it saves.
      forced = true;
      await signalOwner();
      continue;
    }
    if (outcome === 'timeout') {
      const status = run.status;
      return workflowFailure(
        'watch.timeout',
        forced
          ? `Run ${runId} is still ${status} ${String(timeoutMs)}ms after a forced second SIGINT to PID ${String(owner.pid)}; the owner is still alive.`
          : `Run ${runId} is still ${status} ${String(timeoutMs)}ms after SIGINT to PID ${String(owner.pid)}; the cancel request stays in place for the owner, and the run keeps running. Another SIGINT, such as a repeated cancel, is the owner's second signal and force-kills its process groups.`,
        {
          runId,
          stateDir,
          run,
          details: { timeoutMs, signalsSent, forced, pid: owner.pid },
        },
      );
    }
    if (outcome === 'terminal' && terminal(run.status)) {
      await removeCancelRequest(requestPath, requestId);
      return result(run.status, signalsSent, signalsSent === 0 ? null : target);
    }
    // The owner exited without saving a terminal status. Keep the request bound to its token on
    // every path (ADR 0058): a tick may already have retired that owner's lock and be about to
    // check the request under its own lock, and a request no later acquisition retires is inert.
    const left = await observeOwner(lockPath);
    const exited = `Run ${runId}'s owner PID ${String(owner.pid)} exited without saving cancelled; the run is ${run.status}.`;
    throw new RunRefusedError(
      'run.unowned',
      runId,
      left.kind === 'owner' && left.owner.token === owner.token
        ? // A force-killed owner (a --force escalation, or this SIGINT counted as its second
          // signal) leaves its lock behind with the targeted token.
          `${exited} The cancel request stays bound to the exited owner's lock, so the next workflow tick ends the run as cancelled instead of recovering it.`
        : // Retired, released or re-owned: a tick reclaiming the dead lock looks the same as an
          // embedder that released it cleanly, or another writer that took it.
          `${exited} The cancel request stays bound to the exited owner, whose lock is gone or re-owned: a workflow tick that retires that owner's lock ends the run as cancelled${resumeNote(run.status)}.`,
      { reason: 'owner-exited', pid: owner.pid, signalsSent, forced, requestKept: true },
    );
  }
}
