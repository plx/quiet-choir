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
 *   owners are held. Every existing lock counts: the primary lock and the legacy guard.
 * - A recovery marker whose recoverer is alive, unknown, remote or unreadable holds the run; a dead
 *   recoverer's marker does not, because the next acquire reclaims it.
 * - Live or unverified child records block automatic recovery; nothing here authorizes a signal.
 * - The crash-loop cap counts consecutive recoveries without a new completed step; progress resets
 *   it.
 * - An operator unlock removes nothing while any lock's owner or recoverer is locally alive or
 *   unknown, or any child record is alive or unknown. A foreign-host owner or recoverer is refused
 *   unless the operator asserts the host is gone (`forceRemote`); then it is judged by the same
 *   local observations. Missing or unreadable metadata never holds an unlock; its warning travels
 *   with the result.
 *
 * ESLint keeps this module free of runtime imports.
 */
import type { RunOwnership } from './lock.js';
import type { HarnessProcessInspection } from './process-registry.js';
import type { RunRecord } from './record.js';

/**
 * How ownership of a run can be recovered. `free`: no lock. `reclaimable`: every lock's owner is
 * dead or released, no recovery marker has a live recoverer, and no child record is alive or
 * unverified. `orphans`: as reclaimable, but a child record is alive or unverified. `held`: some
 * lock's owner is alive, unknown or remote, its metadata is incomplete or unreadable, or a
 * recoverer is alive, unknown or remote. @internal
 */
export type RecoveryClass = 'free' | 'reclaimable' | 'orphans' | 'held';

/** Classify one ownership observation for recovery. @internal */
export function classifyRecovery(ownership: RunOwnership): RecoveryClass {
  if (!ownership.locked) return 'free';
  const reclaimable = (state: string | undefined): boolean =>
    state === 'dead' || state === 'released';
  // The top-level owner still decides for observations without a per-lock view.
  if (!reclaimable(ownership.owner?.state)) return 'held';
  if (
    ownership.locks.some(
      (lock) =>
        lock.warning !== undefined ||
        !reclaimable(lock.owner?.state) ||
        (lock.recovery !== null && lock.recovery.state !== 'dead'),
    )
  )
    return 'held';
  return ownership.processes.some((entry) => entry.state === 'alive' || entry.state === 'unknown')
    ? 'orphans'
    : 'reclaimable';
}

/** What the inspect text view may suggest for a locked run. @internal */
export type UnlockAdvice =
  { readonly kind: 'unlock' } | { readonly kind: 'force-remote'; readonly host: string };

/**
 * Decide whether `workflow unlock` could clear the observed locks, from what inspection can see.
 * It mirrors `decideUnlock`'s precedence so the hint never names a command that unlock is certain
 * to refuse, and returns null when no hint is warranted:
 * - Not locked: null.
 * - Holders are each lock's owner then recovery marker, primary lock first; with no per-lock view
 *   the top-level owner stands in, as in `classifyRecovery`. A holder that is `alive` or `unknown`
 *   suppresses the hint, even when the lock also carries a warning.
 * - A remote owner masks its children: inspection reports them as `unknown` without observing
 *   them, and unlock refuses the foreign host before it looks at children. So when the top-level
 *   owner is `remote` and a remote holder exists, the hint is `force-remote` with that holder's
 *   host, whatever the children say. A remote recoverer does not mask children.
 * - Otherwise an `alive` or `unknown` child suppresses the hint (unlock would refuse the orphans).
 *   The hint judges only the children inspection observes; it cannot see a remote
 *   owner's.
 * - Otherwise the first `remote` holder yields `force-remote` with its host.
 * - Otherwise `unlock`: dead or released holders, and missing or unreadable metadata, never hold an
 *   unlock. @internal
 */
export function unlockAdvice(ownership: RunOwnership): UnlockAdvice | null {
  if (!ownership.locked && ownership.locks.length === 0) return null;
  const holders =
    ownership.locks.length === 0
      ? ownership.owner === null
        ? []
        : [ownership.owner]
      : ownership.locks.flatMap((lock) => [
          ...(lock.owner === null ? [] : [lock.owner]),
          ...(lock.recovery === null ? [] : [lock.recovery]),
        ]);
  if (holders.some((holder) => holder.state === 'alive' || holder.state === 'unknown')) return null;
  const remote = holders.find((holder) => holder.state === 'remote');
  if (remote !== undefined && ownership.owner?.state === 'remote')
    return { kind: 'force-remote', host: remote.host };
  if (ownership.processes.some((entry) => entry.state === 'alive' || entry.state === 'unknown'))
    return null;
  return remote === undefined ? { kind: 'unlock' } : { kind: 'force-remote', host: remote.host };
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

/** A lock owner or recoverer as unlock observes it: judged locally, even on a foreign host. @internal */
export interface UnlockHolder {
  /** Recorded process ID. */
  readonly pid: number;
  /** Recorded host. */
  readonly host: string;
  /** Ownership or recovery token. */
  readonly token: string;
  /** Whether the recorded host differs from this machine's current hostname. */
  readonly remote: boolean;
  /** Local PID and birth-identity judgment; `released` only for an owner. */
  readonly state: 'alive' | 'dead' | 'unknown' | 'released';
}

/** One existing lock directory as unlock observes it. @internal */
export interface UnlockObservation {
  /** `primary` is `<runId>/lock`; `guard` is the legacy `<runId>.json.lock`. */
  readonly kind: 'primary' | 'guard';
  /** Absolute lock directory path. */
  readonly path: string;
  /** Owner, or null when `owner.json` is missing or unreadable. */
  readonly owner: UnlockHolder | null;
  /** Recovery marker, `unreadable` for a damaged `recovery.json`, or null when there is none. */
  readonly recovery:
    (UnlockHolder & { readonly state: 'alive' | 'dead' | 'unknown' }) | 'unreadable' | null;
  /** Child records observed locally; a null owner token skips only the token comparison. */
  readonly processes: readonly HarnessProcessInspection[];
  /** Missing or unreadable metadata, reported with the result. */
  readonly warning?: string;
}

/** What an operator unlock may do with the observed locks. @internal */
export type UnlockDecision =
  | { readonly kind: 'remove' }
  | {
      readonly kind: 'locked';
      readonly lock: UnlockObservation;
      readonly role: 'owner' | 'recovery';
      readonly holder: UnlockHolder;
      readonly reason: 'remote' | 'alive' | 'unknown';
    }
  | {
      readonly kind: 'orphans';
      readonly lock: UnlockObservation;
      readonly processes: readonly HarnessProcessInspection[];
    };

/**
 * Judge every observed lock before anything is removed. Precedence: a foreign-host owner or
 * recoverer without `forceRemote`, then a locally alive or unknown owner or recoverer, then an
 * alive or unknown child record in any lock; otherwise remove. Within each rule the primary lock
 * precedes the guard and the owner precedes the recoverer. @internal
 */
export function decideUnlock(
  locks: readonly UnlockObservation[],
  forceRemote: boolean,
): UnlockDecision {
  const holders = locks.flatMap((lock) =>
    (
      [
        ['owner', lock.owner],
        ['recovery', lock.recovery === 'unreadable' ? null : lock.recovery],
      ] as const
    ).flatMap(([role, holder]) => (holder === null ? [] : [{ lock, role, holder }])),
  );
  if (!forceRemote)
    for (const { lock, role, holder } of holders)
      if (holder.remote) return { kind: 'locked', lock, role, holder, reason: 'remote' };
  for (const { lock, role, holder } of holders)
    if (holder.state === 'alive' || holder.state === 'unknown')
      return { kind: 'locked', lock, role, holder, reason: holder.state };
  for (const lock of locks)
    if (lock.processes.some((entry) => entry.state === 'alive' || entry.state === 'unknown'))
      return { kind: 'orphans', lock, processes: lock.processes };
  return { kind: 'remove' };
}
