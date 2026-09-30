import { legacyMigrationBackup } from './storage-migration.js';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonValue } from './json.js';
import { isValidRunId } from './run-errors.js';
import {
  resolveStateDir,
  runDirectory,
  legacyRunPath,
  type StateDirectoryOptions,
} from './paths.js';
import { atomicStorageWrite } from './storage-io.js';
import { JournalWriter, readJournalRun, readJournalRunSync } from './journal.js';
import { parseRunRecord, validateRunRecord, type RunRecord } from './record.js';
export * from './record.js';
export {
  lockRun,
  inspectRunOwnership,
  type RunOwnership,
  type RunLockView,
  type RunLock,
} from './lock.js';

/** Locate a run using the same cwd and stateDir defaults as runWorkflow. */
export interface ReadRunOptions extends StateDirectoryOptions {
  /** Stable identifier of the saved run. */
  readonly runId: string;
}

/** Read the snapshot and journal without a writer lock, with legacy flat-file fallback. */
export async function readRun(options: ReadRunOptions): Promise<RunRecord> {
  const stateDir = resolveStateDir(options);
  try {
    return await readJournalRun(stateDir, options.runId);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    if (existsSync(join(runDirectory(stateDir, options.runId), 'run.json'))) throw error;
    const bytes = await readFile(legacyRunPath(stateDir, options.runId), 'utf8');
    const backup = legacyMigrationBackup(bytes, stateDir, options.runId);
    const legacy = parseRunRecord(backup ? await readFile(backup, 'utf8') : bytes, options.runId);
    if (legacy.formatVersion === 7)
      throw new Error(
        `Directory checkpoint for run ${options.runId} is missing from ${runDirectory(stateDir, options.runId)}.`,
        { cause: error },
      );
    return legacy;
  }
}

/** Read the latest durable record during forced CLI shutdown. @internal */
export function readRunSync(options: ReadRunOptions): RunRecord {
  const stateDir = resolveStateDir(options);
  try {
    return readJournalRunSync(stateDir, options.runId);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    if (existsSync(join(runDirectory(stateDir, options.runId), 'run.json'))) throw error;
    const bytes = readFileSync(legacyRunPath(stateDir, options.runId), 'utf8');
    const backup = legacyMigrationBackup(bytes, stateDir, options.runId);
    const legacy = parseRunRecord(backup ? readFileSync(backup, 'utf8') : bytes, options.runId);
    if (legacy.formatVersion === 7)
      throw new Error(
        `Directory checkpoint for run ${options.runId} is missing from ${runDirectory(stateDir, options.runId)}.`,
        { cause: error },
      );
    return legacy;
  }
}

/** Persist one owned batch; callers must serialize writes and hold the run lock. @internal */
export async function writeRun(
  stateDir: string,
  record: RunRecord,
  options: { readonly writer?: JournalWriter; readonly durable?: boolean } = {},
): Promise<void> {
  if (record.formatVersion === 7) {
    await (options.writer ?? new JournalWriter(stateDir, record.id)).append(
      record,
      options.durable,
    );
    return;
  }
  const content = jsonValue(record);
  validateRunRecord(content);
  await atomicStorageWrite(
    legacyRunPath(stateDir, record.id),
    `${JSON.stringify(content, null, 2)}\n`,
  );
}

/** Enumerate both directory and legacy layouts once, excluding backups and temporary files. @internal */
export async function listRunIds(stateDir: string): Promise<string[]> {
  const entries = await readdir(stateDir, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json') && isValidRunId(entry.name.slice(0, -5)))
      ids.add(entry.name.slice(0, -5));
    if (entry.isDirectory() && isValidRunId(entry.name)) {
      try {
        await readFile(join(runDirectory(stateDir, entry.name), 'run.json'));
        ids.add(entry.name);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          ids.add(entry.name);
      }
    }
  }
  return [...ids].sort();
}
