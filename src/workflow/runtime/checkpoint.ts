import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { writeRun, type RunRecord } from './store.js';

/** A storage failure, separate from the outcome of the workflow or external effect. */
export class CheckpointError extends Error {
  /** Storage operation that failed. */
  public readonly operation: 'save' | 'release';

  /** Describe the failed operation and retain the underlying filesystem error as cause. */
  public constructor(operation: 'save' | 'release', message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'CheckpointError';
    this.operation = operation;
  }
}

/** Read a filesystem error code without relying on platform-specific error subclasses. @internal */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Translate a storage error while naming a removed state directory explicitly. @internal */
export async function checkpointError(
  operation: 'save' | 'release',
  stateDir: string,
  runId: string,
  cause: unknown,
  context: string,
): Promise<CheckpointError> {
  if (errorCode(cause) === 'ENOENT') {
    try {
      await stat(stateDir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT')
        return new CheckpointError(
          operation,
          `State directory ${stateDir} was removed while run ${runId} was active.`,
          cause,
        );
    }
  }
  return new CheckpointError(operation, `${context}: ${message(cause)}`, cause);
}

/** Retry a snapshot write without rerunning effects; take each snapshot when its write starts. @internal */
export async function writeCheckpoint(
  stateDir: string,
  runId: string,
  snapshot: () => RunRecord,
  context: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await writeRun(stateDir, snapshot());
      return;
    } catch (cause) {
      const code = errorCode(cause);
      // Retry temporary I/O and permission failures, never invalid checkpoint data or missing paths.
      if (
        attempt < 2 &&
        code !== undefined &&
        ['EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EBUSY', 'EMFILE', 'ENFILE', 'EAGAIN'].includes(code)
      ) {
        await delay(attempt === 0 ? 100 : 300);
        continue;
      }
      throw await checkpointError('save', stateDir, runId, cause, context);
    }
  }
}

/** Preserve the original error identity unless additional checkpoint problems must be reported. @internal */
export function withCheckpointErrors(
  primary: unknown,
  problems: readonly CheckpointError[],
): unknown {
  const errors = [...new Set([primary, ...problems])];
  if (errors.length === 1) return primary;
  return new AggregateError(
    errors,
    `${message(primary)} (checkpoint problems: ${errors.slice(1).map(message).join('; ')})`,
    { cause: primary },
  );
}
