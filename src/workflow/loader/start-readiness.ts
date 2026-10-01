/** The last JSON document the runner wrote to its result file, reduced to what readiness reads. @internal */
export interface StartChildDocument {
  readonly ok: boolean;
  /** `error.code` of a failure document; null for a success or suspension document. */
  readonly errorCode: string | null;
}

/** One observation of a detached runner and its run, in the order the executor takes them. @internal */
export interface StartObservation {
  /** The spawned runner's PID, which owns the run lock while it executes. */
  readonly childPid: number;
  /** Set once the runner has exited (observed before the record, so the record is final). */
  readonly exit: { readonly code: number | null; readonly signal: string | null } | null;
  /** Whether `readRun` succeeded for the run ID. */
  readonly recordReadable: boolean;
  /** PID of the run lock's owner, read only when the record is readable; null when unlocked. */
  readonly ownerPid: number | null;
  /** The runner's parsed result document after it exited; null while alive or when unparseable. */
  readonly document: StartChildDocument | null;
  /** Whether the start timeout has passed. */
  readonly deadlinePassed: boolean;
}

/**
 * What `workflow start` does next. `started`: the run exists and is this runner's. `failed`: report
 * the runner's own document (`document`), its exit without a usable document (`exited`), or stop it
 * after the start timeout (`timeout`). @internal
 */
export type StartDecision =
  | { readonly type: 'wait' }
  | { readonly type: 'started' }
  | { readonly type: 'failed'; readonly reason: 'document' | 'exited' | 'timeout' };

/** Refusals by which a runner reports someone else's record: the run existed or was held. */
const foreignRecordCodes = new Set(['run.exists', 'run.locked']);

/**
 * Decide readiness from one observation. A live runner counts as started only once the record is
 * readable and its lock is owned by the runner's own PID, so a concurrent start of the same ID never
 * reports another runner's record. After the runner exits, a readable record counts when the runner
 * reported success, or a failure other than `run.exists`/`run.locked` (it created the run, then
 * failed or was interrupted). Anything else after exit is a failure, and a live runner past the
 * deadline is a timeout. Pure: no I/O, clock or process access. @internal
 */
export function decideStart(observation: StartObservation): StartDecision {
  const { exit, recordReadable, document } = observation;
  if (exit === null) {
    if (recordReadable && observation.ownerPid === observation.childPid) return { type: 'started' };
    return observation.deadlinePassed ? { type: 'failed', reason: 'timeout' } : { type: 'wait' };
  }
  if (document === null) return { type: 'failed', reason: 'exited' };
  if (document.ok)
    return recordReadable ? { type: 'started' } : { type: 'failed', reason: 'exited' };
  if (
    recordReadable &&
    (document.errorCode === null || !foreignRecordCodes.has(document.errorCode))
  )
    return { type: 'started' };
  return { type: 'failed', reason: 'document' };
}
