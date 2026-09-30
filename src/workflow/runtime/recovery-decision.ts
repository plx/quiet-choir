/**
 * Pure recovery rules for runs whose owner may be gone, following
 * [ADR 0013](../../../docs/decisions/0013-process-ownership.md) and
 * [ADR 0020](../../../docs/decisions/0020-durable-waits-and-tick.md).
 *
 * The functions are pure: no I/O, no clock, no store. Callers gather the ownership observation and
 * the checkpoint, call these functions, and perform every side effect from the result: `inspect`
 * and `list` derive their stale display, and tick decides whether to reclaim the lock and whether
 * to persist the crash-loop counter before resuming.
 *
 * Invariants:
 * - Only a dead or released local owner can be reclaimed; alive, unknown, remote and unreadable
 *   owners are held.
 * - Live or unverified child records block automatic recovery; nothing here authorizes a signal.
 * - The crash-loop cap counts consecutive recoveries without a new completed step; progress resets
 *   it.
 *
 * ESLint keeps this module free of runtime imports.
 */
import type { RunOwnership } from './lock.js';
import type { RunRecord } from './record.js';

/**
 * How ownership of a run can be recovered. `free`: no lock. `reclaimable`: the owner is dead or
 * released and no child record is alive or unverified. `orphans`: the owner is dead or released,
 * but a child record is alive or unverified. `held`: the owner is alive, unknown or remote, or the
 * lock metadata is incomplete or unreadable. @internal
 */
export type RecoveryClass = 'free' | 'reclaimable' | 'orphans' | 'held';

/** Classify one ownership observation for recovery. @internal */
export function classifyRecovery(ownership: RunOwnership): RecoveryClass {
  if (!ownership.locked) return 'free';
  const state = ownership.owner?.state;
  if (state !== 'dead' && state !== 'released') return 'held';
  return ownership.processes.some((entry) => entry.state === 'alive' || entry.state === 'unknown')
    ? 'orphans'
    : 'reclaimable';
}

/** Consecutive stale recoveries without a new completed step before tick stops. @internal */
export const STALE_RECOVERY_CAP = 3;

/** Tick's persisted crash-loop counter. @internal */
export type StaleRecovery = NonNullable<RunRecord['staleRecovery']>;

/** Count the steps whose status is `completed`; the crash-loop baseline. @internal */
export function countCompletedSteps(run: Pick<RunRecord, 'steps'>): number {
  return Object.values(run.steps).filter((step) => step.status === 'completed').length;
}

/** Whether tick may recover a stale run again, and the counter to persist first. @internal */
export type StaleRecoveryDecision =
  | { readonly kind: 'recover'; readonly staleRecovery: StaleRecovery }
  | { readonly kind: 'crash-loop'; readonly count: number };

/**
 * Decide one stale recovery. The count grows while the completed-step baseline stays the same and
 * resets to 1 when it changes; at the cap with an unchanged baseline, tick must stop. @internal
 */
export function decideStaleRecovery(
  previous: StaleRecovery | undefined,
  completedSteps: number,
  at: string,
): StaleRecoveryDecision {
  const unchanged = previous?.completedSteps === completedSteps;
  if (previous && unchanged && previous.count >= STALE_RECOVERY_CAP)
    return { kind: 'crash-loop', count: previous.count };
  return {
    kind: 'recover',
    staleRecovery: { count: previous && unchanged ? previous.count + 1 : 1, completedSteps, at },
  };
}

/** Explain why tick stopped recovering a crash-looping run. @internal */
export function crashLoopMessage(runId: string, count: number): string {
  return `Run ${runId} was recovered ${String(count)} times after its owner stopped, without completing a new step; tick will not recover it again (cap ${String(STALE_RECOVERY_CAP)}). Inspect it, then run 'quiet-choir workflow resume ${runId}' to retry explicitly.`;
}
