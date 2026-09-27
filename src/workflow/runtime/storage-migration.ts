import { link, mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { legacyRunPath, runDirectory } from './paths.js';
import { atomicStorageWrite, syncDirectory } from './storage-io.js';
import { parseRunRecord, type RunRecord } from './record.js';

/** Preserve the exact legacy checkpoint while its existing owner lock is held. @internal */
export async function prepareStorageMigration(
  stateDir: string,
  runId: string,
  next: RunRecord,
): Promise<boolean> {
  const path = legacyRunPath(stateDir, runId);
  let bytes: string;
  try {
    bytes = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
  const record = parseRunRecord(bytes, runId);
  if (record.formatVersion === 7)
    return legacyMigrationBackup(bytes, stateDir, runId) !== undefined;
  const backup = `${path}.v${String(record.formatVersion)}`;
  try {
    await link(path, backup);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    if ((await readFile(backup, 'utf8')) !== bytes)
      throw new Error(
        `Migration backup ${backup} differs from the legacy checkpoint; inspect it before resuming.`,
        { cause: error },
      );
  }
  await syncDirectory(stateDir);
  const directory = runDirectory(stateDir, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await rename(join(stateDir, `${runId}.inbox`), join(directory, 'inbox'));
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(String(error.code))
    ))
      throw error;
  }
  // Publish the old-binary guard before the directory checkpoint can become authoritative.
  // Until finish succeeds, a missing directory snapshot is recoverable from the exact backup.
  // No workflow action starts before both writes finish.
  await atomicStorageWrite(
    path,
    `${JSON.stringify({ ...next, migrationPending: record.formatVersion })}\n`,
  );
  return true;
}

/** Leave a rejecting format marker at the old filename before releasing the legacy owner. @internal */
export async function finishStorageMigration(stateDir: string, record: RunRecord): Promise<void> {
  // Keeping a valid current record here gives old readers a clear version refusal. New readers
  // always prefer run.json + journal; this compatibility marker is never the active checkpoint.
  await atomicStorageWrite(legacyRunPath(stateDir, record.id), `${JSON.stringify(record)}\n`);
}

/** Pending migration markers alone may fall back to their untouched pre-migration backup. @internal */
export function legacyMigrationBackup(
  text: string,
  stateDir: string,
  runId: string,
): string | undefined {
  const raw: unknown = JSON.parse(text);
  if (
    raw !== null &&
    typeof raw === 'object' &&
    'formatVersion' in raw &&
    raw.formatVersion === 7 &&
    'migrationPending' in raw
  ) {
    const version = raw.migrationPending;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 6)
      throw new Error('Invalid pending storage migration version.');
    return `${legacyRunPath(stateDir, runId)}.v${String(version)}`;
  }
  return undefined;
}
