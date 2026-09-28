import { readdir } from 'node:fs/promises';
import { errorCode } from './checkpoint.js';
import { resolveStateDir } from './paths.js';
import { isValidRunId, RunRefusedError } from './run-errors.js';
import { readRun, type ReadRunOptions, type RunRecord } from './store.js';

/** Explain a missing checkpoint with a bounded directory listing. @internal */
export async function missingRunError(
  options: ReadRunOptions,
  cause?: unknown,
): Promise<RunRefusedError> {
  const stateDir = resolveStateDir(options);
  const entries = await readdir(stateDir, { withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return [];
    throw unreadableRunError(options, error);
  });
  const ids = entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith('.json') && isValidRunId(entry.name.slice(0, -5)),
    )
    .map((entry) => entry.name.slice(0, -5))
    .sort();
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
