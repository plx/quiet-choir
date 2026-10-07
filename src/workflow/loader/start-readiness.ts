/** The last JSON document the runner wrote to its result file, reduced to what readiness reads. @internal */
export interface StartChildDocument {
  readonly ok: boolean;
  /** `error.code` of a failure document; null for a success or suspension document. */
  readonly errorCode: string | null;
}

/** One observation of a detached runner and its run, in the order the executor takes them. @internal */
export interface StartObservation {
  /**
   * `new` for a run the runner must create; `resume` for an existing run the runner must resume.
   * Defaults to `new`.
   */
  readonly mode?: 'new' | 'resume';
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
  /**
   * Resume only: whether the readable record holds an execution numbered above the one recorded
   * before the runner was spawned, whose PID is the runner's. Defaults to false.
   */
  readonly executionByRunner?: boolean;
}

/**
 * What `workflow start` does next. `started`: the run exists and is this runner's (for a resume:
 * the runner recorded its own execution, or finished a completed run). `failed`: report
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
 * Decide readiness from one observation. A new run (`mode` `new`, ADR 0036): a live runner counts as started only once the record is
 * readable and its lock is owned by the runner's own PID, so a concurrent start of the same ID never
 * reports another runner's record. After the runner exits, a readable record counts when the runner
 * reported success, or a failure other than `run.exists`/`run.locked` (it created the run, then
 * failed or was interrupted). Anything else after exit is a failure, and a live runner past the
 * deadline is a timeout.
 *
 * A resume (`mode` `resume`, ADR 0056): the record exists before the runner starts, and the runner
 * takes the lock before it refuses an incompatible or changed run, so neither readability nor lock
 * ownership counts. Only an execution recorded by the runner itself (`executionByRunner`), which it
 * saves under the lock once the body starts, does. A live runner without one waits until the
 * deadline. After the runner exits with a usable document, such an execution counts whatever the
 * document says (it resumed, then completed, failed, suspended or was interrupted), and so does a
 * success document with a readable record (a completed run whose resume returns the stored output
 * without a new execution). Any other document is a failure that reports the runner's own refusal
 * (`run.locked`, `run.orphans`, `run.incompatible` and so on), and an exit without a usable
 * document is `exited`, as for a new run. Pure: no I/O, clock or process access. @internal
 */
export function decideStart(observation: StartObservation): StartDecision {
  if (observation.mode === 'resume') return decideResume(observation);
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

function decideResume(observation: StartObservation): StartDecision {
  const { exit, recordReadable, document } = observation;
  const owned = recordReadable && observation.executionByRunner === true;
  if (exit === null) {
    if (owned) return { type: 'started' };
    return observation.deadlinePassed ? { type: 'failed', reason: 'timeout' } : { type: 'wait' };
  }
  // As for a new run, a runner that exits without a usable document is reported as such.
  if (document === null) return { type: 'failed', reason: 'exited' };
  if (owned) return { type: 'started' };
  if (document.ok)
    return recordReadable ? { type: 'started' } : { type: 'failed', reason: 'exited' };
  return { type: 'failed', reason: 'document' };
}
