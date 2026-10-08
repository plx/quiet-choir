import type { CommandLauncher } from './commands.js';
import { oldFormatMessage, recordedEngine } from './engine.js';
import { RunObservations } from './observability.js';
import type { RunEvent } from './observability-model.js';
import { missingRunError } from './read-required-run.js';
import { hasRecordedWork, hasTerminalOutcomes, SUPPORTED_SCHEMA_REVISION } from './record.js';
import { chooseRecoveryHint, type RecoveryCause, type RecoveryHintInput } from './recovery-hint.js';
import { RunInterruptedError, RunRefusedError } from './run-errors.js';
import { openFileOwnedRun } from './run-store.js';
import type { RunRecord } from './store.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Set the run's cancelled status, error and root cause from the reason that ended it. */
function recordCancelled(record: RunRecord, reason: unknown): void {
  record.status = 'cancelled';
  record.error = message(reason);
  record.rootCause = { stepId: null, error: message(reason), errorKind: null, effect: null };
}

/**
 * Record an honored run-signal abort on `record`. A marked {@link RunInterruptedError} is a
 * resumable suspension that is due at `now` and keeps `staleRecovery` (ADR 0029); any other reason,
 * such as a `workflow cancel` request bound to this execution's lock (ADR 0039), cancels the run.
 * @internal
 */
export function recordHonoredAbort(record: RunRecord, reason: unknown, now: number): void {
  if (reason instanceof RunInterruptedError) {
    record.status = 'suspended';
    record.error = null;
    record.rootCause = null;
    record.interruptedBy = { reason: message(reason), at: new Date().toISOString() };
    record.nextWakeAt = now;
    return;
  }
  recordCancelled(record, reason);
}

/**
 * Save a failed or cancelled run's typed recovery cause, which selects its `next` commands, and the
 * hint it chooses; the hint is removed when the chooser gives none (nothing recorded, a dry-run).
 * The cause is saved either way, so the record stays truthful. Paired with {@link clearRecovery}.
 * @internal
 */
export function saveRecovery(record: RunRecord, input: RecoveryHintInput): void {
  record.recoveryCause = input.cause;
  const hint = chooseRecoveryHint(input);
  if (hint === undefined) delete record.recoveryHint;
  else record.recoveryHint = hint;
}

/**
 * Remove the recovery hint and cause, at the start of an execution or on a clean suspension.
 * @internal
 */
export function clearRecovery(record: RunRecord): void {
  delete record.recoveryHint;
  delete record.recoveryCause;
}

/** How {@link cancelRecord} classifies the cancellation for recovery advice. @internal */
export interface CancelRecordOptions {
  /** The typed recovery cause, classified from the record once it is saved as cancelled. */
  readonly cause: (cancelled: RunRecord) => RecoveryCause;
  /** Whether the workflow source changed since the run's recorded fingerprint. */
  readonly sourceChanged: boolean;
}

/** The lifecycle event a cancellation recorded, and the undo for a save that failed. @internal */
export interface CancelledRecord {
  /** The `run.cancelled` event appended to the record. */
  readonly event: RunEvent;
  /** Put the record back exactly as it was before {@link cancelRecord}. */
  readonly restore: () => void;
}

/**
 * The one record transition that ends an unfinished run as `cancelled` without running its body,
 * shared by the runner's accepted-replay preflight abort and `workflow cancel` on a run no process
 * owns (ADR 0057). In memory only; the caller saves it under the run lock. It stamps the current
 * storage format, engine and schema revision; drops a stale `interruptedBy`; saves the cancelled
 * status, error and root cause from `reason`; replaces the recovery cause and hint; settles every
 * running or suspended child frame as cancelled; and ends a new execution entry with a
 * `run.cancelled` event, as the body's catch would. Steps and worktrees are left as they are. A
 * record may be passed only in format 6 or 7: format 1 cannot be saved without the
 * definition-driven migration, and formats 2 to 5 are read-only history.
 * @internal
 */
export function cancelRecord(
  record: RunRecord,
  reason: unknown,
  options: CancelRecordOptions,
): CancelledRecord {
  const before = structuredClone(record);
  record.formatVersion = 7;
  record.seq ??= 0;
  record.engine = recordedEngine();
  record.schemaRevision = SUPPORTED_SCHEMA_REVISION;
  // A cancellation leaves no stale marker from an earlier interruption.
  delete record.interruptedBy;
  recordCancelled(record, reason);
  clearRecovery(record);
  const finishedAt = new Date().toISOString();
  for (const frame of Object.values(record.children ?? {}))
    if (frame.status === 'running' || frame.status === 'suspended') {
      frame.status = 'cancelled';
      frame.finishedAt = finishedAt;
      frame.error ??= record.error;
    }
  saveRecovery(record, {
    cause: options.cause(record),
    rehearsal: false,
    recordedWork: hasRecordedWork(record),
    allTerminal: hasTerminalOutcomes(record),
    sourceChanged: options.sourceChanged,
    runId: record.id,
  });
  // The lifecycle record the body's catch would add: an execution entry that ends with the
  // cancellation, and its run event.
  const event = new RunObservations(
    record,
    () => Promise.resolve(),
    () => undefined,
  ).lifecycle('run.cancelled', reason);
  record.updatedAt = new Date().toISOString();
  return {
    event,
    restore: () => {
      for (const key of Object.keys(record))
        if (!Object.hasOwn(before, key)) Reflect.deleteProperty(record, key);
      Object.assign(record, before);
    },
  };
}

/** Where and how {@link cancelUnownedRun} takes the run. @internal */
export interface CancelUnownedRunOptions {
  /** Absolute runs container. */
  readonly stateDir: string;
  readonly runId: string;
  /** The run's project directory, used to register a default state root as tick does. */
  readonly cwd?: string | undefined;
  /** Shapes the `workflow unlock` command that a `run.locked` refusal names. */
  readonly commandLauncher?: CommandLauncher | undefined;
  /** Cancels acquiring the lock. */
  readonly signal?: AbortSignal | undefined;
}

/** What {@link cancelUnownedRun} found under the run lock. @internal */
export interface CancelUnownedRunResult {
  /** The run's saved terminal status after the call. */
  readonly status: 'completed' | 'failed' | 'cancelled';
  /** The unfinished status this call ended, or null when the run had already ended. */
  readonly previousStatus: 'running' | 'suspended' | null;
}

/**
 * End an unfinished run that no process owns as `cancelled` (ADR 0057). Takes the run lock without
 * recovering a dead or released owner's lock (that refuses with `run.locked` and the unlock
 * command), re-reads the record under it, and saves {@link cancelRecord}'s transition durably. A
 * run that already ended is reported as it is and not written, in any format. An unfinished record
 * in any format but 6 or 7 is refused with `run.incompatible`, unchanged: format 1 cannot be saved
 * without the definition, and formats 2 to 5 are read-only. Runs no workflow code, launches nothing and leaves steps and
 * worktrees as they are. @internal
 */
export async function cancelUnownedRun(
  options: CancelUnownedRunOptions,
): Promise<CancelUnownedRunResult> {
  const { stateDir, runId } = options;
  const owned = await openFileOwnedRun(stateDir, runId, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    commandLauncher: options.commandLauncher,
    reclaimStale: false,
  });
  let result: CancelUnownedRunResult;
  try {
    const record = await owned.read();
    if (record === undefined) throw await missingRunError({ stateDir, runId });
    if (
      record.status === 'completed' ||
      record.status === 'failed' ||
      record.status === 'cancelled'
    )
      result = { status: record.status, previousStatus: null };
    else if (record.formatVersion === 1)
      throw new RunRefusedError(
        'run.incompatible',
        runId,
        `Run ${runId} is ${record.status} in checkpoint format 1, which workflow cancel cannot save without the workflow definition. Resume it once with this build, or remove it with workflow rm.`,
        { formatVersion: 1, status: record.status },
      );
    else if (record.formatVersion !== 6 && record.formatVersion !== 7)
      throw new RunRefusedError('run.incompatible', runId, oldFormatMessage(record.formatVersion), {
        formatVersion: record.formatVersion,
        status: record.status,
      });
    else {
      const previousStatus = record.status;
      const reason = new Error(
        `Run ${runId} cancelled by workflow cancel (requested ${new Date().toISOString()}) while it was ${previousStatus} with no owner.`,
      );
      const cancelled = cancelRecord(record, reason, {
        cause: () => ({ kind: 'cancelled' }),
        sourceChanged: false,
      });
      try {
        await owned.append(record, { durable: true, context: `Could not save run ${runId}` });
      } catch (error) {
        cancelled.restore();
        throw error;
      }
      result = { status: 'cancelled', previousStatus };
    }
  } catch (error) {
    try {
      await owned.release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], `Could not release run ${runId}.`, {
        cause: releaseError,
      });
    }
    throw error;
  }
  await owned.release();
  return result;
}
