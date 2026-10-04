/**
 * Pure selection rules for `workflow prune`: whether one listed run matches the operator's filters
 * and, if it does, whether something still protects it, following
 * [ADR 0050](../../../docs/decisions/0050-select-runs-for-prune-conservatively.md). Prune only
 * selects; every selected run is then removed through `workflow rm`'s guarded removal, which
 * re-checks its own guards under the run lock.
 *
 * Filters AND together: the observed status is one of `statuses`; with `olderThanMs`, `updatedAt`
 * is strictly older than that; with `missingCwd`, the recorded cwd is known to be missing. A
 * matching run is protected, first match wins, when:
 * 1. `active`: its observed status is running, stale or suspended;
 * 2. `locked` or `orphans`: its ownership holds it (`ownershipHold`, rm's first two guards);
 * 3. `waiting`: a step is still waiting for an answer, a signal or a deadline;
 * 4. `queued-answer`: either inbox holds a file a resume could still consume. The orchestrator
 *    counts every entry, even an unknown leftover, except the deliveries the record shows settled:
 *    consumed answers and quarantined `.rejected.` files.
 *
 * ESLint keeps this module free of runtime imports and of the clock: `nowMs` is a parameter.
 */
import type { OwnershipHold } from '../runtime/removal-decision.js';
import type { InspectionStatus } from './inspection.js';

/** A status `workflow prune --status` accepts: only terminal ones. @internal */
export type PruneStatus = 'completed' | 'failed' | 'cancelled';

/** The statuses prune considers when `--status` is not given. @internal */
export const defaultPruneStatuses: readonly PruneStatus[] = ['completed', 'failed', 'cancelled'];

/** The operator's filters, all of which a run must match. @internal */
export interface PruneFilters {
  /**
   * Observed statuses to consider. The CLI passes only terminal ones; the selector accepts any, so
   * its table can prove that an active run is still protected.
   */
  readonly statuses: readonly InspectionStatus[];
  /** Only runs whose `updatedAt` is strictly older than this many milliseconds; null for any age. */
  readonly olderThanMs: number | null;
  /** Only runs whose recorded cwd is known to be missing. */
  readonly missingCwd: boolean;
}

/** What the orchestrator observed about one listed run. @internal */
export interface PruneCandidate {
  readonly runId: string;
  readonly stateDir: string;
  /** The observed status, `stale` included. */
  readonly status: InspectionStatus;
  readonly updatedAt: string;
  /** Whether the recorded cwd is missing: null when unknown, or not checked without `missingCwd`. */
  readonly cwdMissing: boolean | null;
  /** IDs of steps whose status is `waiting`. */
  readonly waiting: readonly string[];
  /**
   * Unsettled entries in `<runId>/inbox` and `<runId>.inbox` (not a consumed answer or a rejected
   * delivery); an unreadable inbox or record counts as queued.
   */
  readonly queuedAnswers: number;
  /** The lock or orphan hold `workflow rm` would refuse first, or null. */
  readonly hold: OwnershipHold | null;
}

/** Why a matching run stays. @internal */
export type PruneProtection =
  | { readonly reason: 'active'; readonly status: InspectionStatus }
  | { readonly reason: 'locked' | 'orphans'; readonly hold: OwnershipHold }
  | { readonly reason: 'waiting'; readonly waiting: readonly string[] }
  | { readonly reason: 'queued-answer'; readonly queuedAnswers: number };

/** The selector's verdict for one run. @internal */
export type PruneDecision =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'select' }
  | ({ readonly kind: 'protect' } & PruneProtection);

/** Whether the run matches every filter; see the module comment. */
function matches(candidate: PruneCandidate, filters: PruneFilters, nowMs: number): boolean {
  if (!filters.statuses.includes(candidate.status)) return false;
  if (filters.olderThanMs !== null) {
    const updated = Date.parse(candidate.updatedAt);
    if (!Number.isFinite(updated) || !(nowMs - updated > filters.olderThanMs)) return false;
  }
  return !filters.missingCwd || candidate.cwdMissing === true;
}

/** Judge one listed run for prune; see the module comment for the rules. @internal */
export function pruneDecision(
  candidate: PruneCandidate,
  filters: PruneFilters,
  nowMs: number,
): PruneDecision {
  if (!matches(candidate, filters, nowMs)) return { kind: 'ignore' };
  const { status } = candidate;
  if (status === 'running' || status === 'stale' || status === 'suspended')
    return { kind: 'protect', reason: 'active', status };
  if (candidate.hold) return { kind: 'protect', reason: candidate.hold.kind, hold: candidate.hold };
  if (candidate.waiting.length)
    return { kind: 'protect', reason: 'waiting', waiting: candidate.waiting };
  if (candidate.queuedAnswers > 0)
    return { kind: 'protect', reason: 'queued-answer', queuedAnswers: candidate.queuedAnswers };
  return { kind: 'select' };
}
