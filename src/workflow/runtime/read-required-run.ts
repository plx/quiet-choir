import { errorCode } from './checkpoint.js';
import { resolveStateDir } from './paths.js';
import { RunRefusedError } from './run-errors.js';
import { readRun, listRunIds, type ReadRunOptions, type RunRecord } from './store.js';

/** Explain a missing checkpoint with a bounded directory listing. @internal */
export async function missingRunError(
  options: ReadRunOptions,
  cause?: unknown,
): Promise<RunRefusedError> {
  const stateDir = resolveStateDir(options);
  const ids = await listRunIds(stateDir).catch((error: unknown) => {
    throw unreadableRunError(options, error);
  });
  const available = ids.slice(0, 20);
  return new RunRefusedError(
    'run.not_found',
    options.runId,
    `Run ${options.runId} not found in ${stateDir} (${String(ids.length)} runs present${ids.length ? `: ${available.join(', ')}${ids.length > 20 ? ', …' : ''}` : ''}). --state-dir resolves against the current directory.`,
    { stateDir, available, count: ids.length },
    { cause },
  );
}

/** Preserve filesystem/validation evidence without guessing a code from its message. @internal */
export function unreadableRunError(options: ReadRunOptions, cause: unknown): RunRefusedError {
  return new RunRefusedError(
    'run.unreadable',
    options.runId,
    cause instanceof Error ? cause.message : String(cause),
    { stateDir: resolveStateDir(options), filesystemCode: errorCode(cause) ?? null },
    { cause },
  );
}

/** Typed read boundary for operations that require an existing checkpoint. @internal */
export async function readRequiredRun(options: ReadRunOptions): Promise<RunRecord> {
  try {
    return await readRun(options);
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') throw await missingRunError(options, cause);
    throw unreadableRunError(options, cause);
  }
}
