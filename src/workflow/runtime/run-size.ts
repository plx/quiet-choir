import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { legacyRunPath, runDirectory } from './paths.js';

/** `<runId>.json.v<N>` migration backups: one per legacy format, 1 to 6. */
const backupSuffix = /^[1-6]$/u;

/** Whether `name` is a migration backup of `runId`'s flat checkpoint. @internal */
export function isRunBackup(runId: string, name: string): boolean {
  const prefix = `${runId}.json.v`;
  return name.startsWith(prefix) && backupSuffix.test(name.slice(prefix.length));
}

/**
 * The run's own files beside its directory in the runs container: the flat checkpoint or format-7
 * marker, its migration backups, the legacy cancel request and the legacy inbox. Pass the
 * container's listing to find backups without reading it again. @internal
 */
export async function runSiblingPaths(
  stateDir: string,
  runId: string,
  entries?: readonly string[],
): Promise<{
  readonly flat: string;
  readonly backups: string[];
  readonly cancel: string;
  readonly inbox: string;
}> {
  const root = resolve(stateDir);
  const names =
    entries ??
    (await readdir(root).catch((error: unknown) => {
      if (isEnoent(error)) return [];
      throw error;
    }));
  return {
    flat: legacyRunPath(root, runId),
    backups: names.filter((name) => isRunBackup(runId, name)).map((name) => join(root, name)),
    cancel: join(root, `${runId}.cancel.json`),
    inbox: join(root, `${runId}.inbox`),
  };
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * The apparent size of the regular files below `path` (or of `path` itself), without following
 * symbolic links. Entries that vanish during the walk count as zero; other errors propagate.
 */
async function treeBytes(path: string): Promise<number> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isEnoent(error)) return 0;
    throw error;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries)
    if (entry.isDirectory() || entry.isFile()) total += await treeBytes(join(path, entry.name));
  return total;
}

/**
 * On-disk bytes of one saved run: the apparent size of every regular file under `<runId>/` (record,
 * journal, `attempts/` transcripts, artifacts, `launch/`, inbox, lock) plus the flat checkpoint or
 * marker, its `.v<N>` backups, `<runId>.cancel.json` and `<runId>.inbox/`. Symbolic links are not
 * followed and worktree caches are not counted. Pass the runs container's listing to avoid reading
 * it once per run. @internal
 */
export async function runBytes(
  stateDir: string,
  runId: string,
  entries?: readonly string[],
): Promise<number> {
  const siblings = await runSiblingPaths(stateDir, runId, entries);
  let total = await treeBytes(runDirectory(stateDir, runId));
  for (const path of [siblings.flat, ...siblings.backups, siblings.cancel, siblings.inbox])
    total += await treeBytes(path);
  return total;
}
