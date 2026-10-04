/**
 * Pure guard rules for `workflow rm`: whether one saved run may be deleted, judged from its record
 * and a read-only ownership observation, following
 * [ADR 0049](../../../docs/decisions/0049-guard-held-run-removal.md).
 *
 * Precedence, first match wins:
 * 1. `locked`: a lock (primary or legacy guard) whose owner is alive, unknown or remote, whose
 *    owner metadata is missing or unreadable, or whose recovery marker is alive, unknown or remote.
 *    `--force` never overrides it; only the owner's exit or `workflow unlock` clears it.
 * 2. `orphans`: every owner is dead or released, but a recorded child is alive or unverifiable.
 * 3. `active` (only without `--force`): the recorded status is running or suspended, or a step is
 *    still waiting, so a pending wait or answer may still need the run.
 * 4. `remove`.
 *
 * ESLint keeps this module free of runtime imports.
 */
import type { RunLockView, RunOwnership } from './lock.js';
import type { HarnessProcessInspection } from './process-registry.js';
import type { RunRecord } from './record.js';

/** What `workflow rm` may do with one run. @internal */
export type RemovalVerdict =
  | { readonly kind: 'remove' }
  | {
      readonly kind: 'locked';
      /** The lock that holds the run, or null when only the top-level observation says so. */
      readonly lock: Pick<RunLockView, 'kind' | 'path'> | null;
      readonly role: 'owner' | 'recovery';
      /** Why it holds: the holder's liveness, or `unreadable` for missing or damaged metadata. */
      readonly reason: 'alive' | 'unknown' | 'remote' | 'unreadable';
      readonly pid: number | null;
      readonly host: string | null;
      /** The metadata problem, for `unreadable`. */
      readonly warning: string | null;
    }
  | {
      readonly kind: 'orphans';
      readonly owner: RunOwnership['owner'];
      /** Every child record of the owning lock; at least one is alive or unknown. */
      readonly processes: readonly HarnessProcessInspection[];
    }
  | {
      readonly kind: 'active';
      readonly status: RunRecord['status'];
      /** Step IDs whose status is `waiting`, in record order. */
      readonly waiting: readonly string[];
    };

const holding = (state: string): state is 'alive' | 'unknown' | 'remote' =>
  state === 'alive' || state === 'unknown' || state === 'remote';

/** The part of a {@link RemovalVerdict} that ownership alone decides: a held lock or live orphans. @internal */
export type OwnershipHold = Extract<RemovalVerdict, { readonly kind: 'locked' | 'orphans' }>;

/**
 * The first two precedence steps of {@link removalVerdict}: `locked`, then `orphans`, judged from
 * the ownership observation alone; null when ownership does not hold the run. `workflow prune`
 * uses it to protect a run before it asks `workflow rm` to remove it. @internal
 */
export function ownershipHold(ownership: RunOwnership): OwnershipHold | null {
  for (const lock of ownership.locks) {
    const where = { kind: lock.kind, path: lock.path };
    if (lock.owner === null || lock.warning !== undefined) {
      const unreadableOwner = lock.owner === null;
      return {
        kind: 'locked',
        lock: where,
        role: unreadableOwner ? 'owner' : 'recovery',
        reason: 'unreadable',
        pid: null,
        host: null,
        warning: lock.warning ?? 'owner.json: missing',
      };
    }
    if (holding(lock.owner.state))
      return {
        kind: 'locked',
        lock: where,
        role: 'owner',
        reason: lock.owner.state,
        pid: lock.owner.pid,
        host: lock.owner.host,
        warning: null,
      };
    if (lock.recovery !== null && holding(lock.recovery.state))
      return {
        kind: 'locked',
        lock: where,
        role: 'recovery',
        reason: lock.recovery.state,
        pid: lock.recovery.pid,
        host: lock.recovery.host,
        warning: null,
      };
  }
  // An observation without per-lock views still decides by its top-level owner.
  if (ownership.locked && ownership.locks.length === 0) {
    const owner = ownership.owner;
    if (owner === null || holding(owner.state))
      return {
        kind: 'locked',
        lock: null,
        role: 'owner',
        reason: owner === null ? 'unreadable' : (owner.state as 'alive' | 'unknown' | 'remote'),
        pid: owner?.pid ?? null,
        host: owner?.host ?? null,
        warning: owner === null ? (ownership.warning ?? 'owner.json: unreadable') : null,
      };
  }
  if (ownership.processes.some((entry) => entry.state === 'alive' || entry.state === 'unknown'))
    return { kind: 'orphans', owner: ownership.owner, processes: ownership.processes };
  return null;
}

/** Judge one run for removal; see the module comment for the rules. @internal */
export function removalVerdict(
  record: Pick<RunRecord, 'status' | 'steps'>,
  ownership: RunOwnership,
  options: { readonly force: boolean },
): RemovalVerdict {
  const hold = ownershipHold(ownership);
  if (hold) return hold;
  if (!options.force) {
    const waiting = Object.entries(record.steps)
      .filter(([, step]) => step.status === 'waiting')
      .map(([id]) => id);
    if (record.status === 'running' || record.status === 'suspended' || waiting.length)
      return { kind: 'active', status: record.status, waiting };
  }
  return { kind: 'remove' };
}

/** A refusal's stable code, operator message and plain details. @internal */
export interface RemovalRefusal {
  readonly code: 'run.locked' | 'run.orphans' | 'run.active';
  readonly message: string;
  /** Plain data; process inspections stay as observed. */
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * Explain a refusing verdict. `stateDir` must be the resolved runs container, so the suggested
 * commands can be pasted as they are. @internal
 */
export function removalRefusal(
  runId: string,
  stateDir: string,
  verdict: Exclude<RemovalVerdict, { readonly kind: 'remove' }>,
): RemovalRefusal {
  const unlock = `quiet-choir workflow unlock ${runId} --state-dir ${stateDir}`;
  if (verdict.kind === 'active') {
    const why =
      verdict.status === 'running' || verdict.status === 'suspended'
        ? `is ${verdict.status}`
        : `is ${verdict.status} but still has waiting steps`;
    return {
      code: 'run.active',
      message: `Run ${runId} ${why}${
        verdict.waiting.length ? ` (waiting: ${verdict.waiting.join(', ')})` : ''
      }; a pending wait, answer or resume may still need it. Rerun with --force to remove it anyway.`,
      details: { status: verdict.status, waiting: [...verdict.waiting] },
    };
  }
  if (verdict.kind === 'orphans') {
    const pending = verdict.processes.filter(
      (entry) => entry.state === 'alive' || entry.state === 'unknown',
    );
    const owner = verdict.owner;
    return {
      code: 'run.orphans',
      message: `Run ${runId} has ${String(pending.length)} live or unverified harness processes (${pending
        .map((entry) =>
          entry.process
            ? `${entry.process.binary} pid ${String(entry.process.pid)}, step ${entry.process.stepId}: ${entry.state}`
            : `${entry.file}: ${entry.detail ?? 'invalid record'}`,
        )
        .join('; ')})${
        owner ? ` under owner PID ${String(owner.pid)} on ${owner.host} (${owner.state})` : ''
      }. rm never signals a process: wait for them to exit, or stop confirmed ones with quiet-choir workflow resume ${runId} --state-dir ${stateDir} --kill-orphans, then retry.`,
      details: {
        owner: owner && { pid: owner.pid, host: owner.host, state: owner.state },
        processes: verdict.processes,
      },
    };
  }
  const who = `Run ${runId} ${verdict.lock?.kind ?? 'run'} lock ${
    verdict.role === 'owner' ? 'owner' : 'recoverer'
  }`;
  const details = {
    lockPath: verdict.lock?.path ?? null,
    kind: verdict.lock?.kind ?? null,
    role: verdict.role,
    pid: verdict.pid,
    host: verdict.host,
    state: verdict.reason,
  };
  if (verdict.reason === 'unreadable')
    return {
      code: 'run.locked',
      message: `${who} metadata is missing or unreadable (${verdict.warning ?? 'unknown'}); --force does not override a lock. After confirming no process owns it, clear it with ${unlock}, then retry.`,
      details,
    };
  const pid = String(verdict.pid);
  return {
    code: 'run.locked',
    message:
      verdict.reason === 'remote'
        ? `${who} PID ${pid} is on foreign host ${verdict.host ?? 'unknown'}; --force does not override a lock. If that host is this machine under an old name or is permanently gone, clear it with ${unlock} --force-remote, then retry.`
        : `${who} PID ${pid} on ${verdict.host ?? 'unknown'} is ${
            verdict.reason === 'alive' ? 'alive' : 'unverifiable'
          }; --force does not override a lock, and rm never stops a process. Wait for it to exit or stop it, then retry.`,
    details,
  };
}
