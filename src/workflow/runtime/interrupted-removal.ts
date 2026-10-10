import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runRecordPresent } from './launch-leftovers.js';
import { isErrno, isLockStray } from './lock.js';
import { runDirectory } from './paths.js';
import {
  interruptedRemovalShape,
  type InterruptedRemovalEntry,
  type InterruptedRemovalFacts,
} from './removal-decision.js';
import { isValidRunId } from './run-errors.js';
import { isRunBackup, runBytes, runSiblingPaths } from './run-size.js';

/**
 * What a `workflow rm` of an unmigrated flat run left when it stopped after deleting the flat file
 * and before renaming `<runId>/` away (ADR 0061): no record, and only the primary lock, its strays,
 * `.json.v<N>` backups and the legacy guard. @internal
 */
export interface InterruptedRemoval {
  readonly runId: string;
  /** Absolute runs container. */
  readonly stateDir: string;
  /** Absolute `<stateDir>/<runId>`, whether or not the directory still exists. */
  readonly path: string;
  /** The leftover's paths that exist: the directory, the legacy guard, then the backups. */
  readonly paths: readonly string[];
  /** Apparent size of its files, as `workflow rm` measures a run. */
  readonly bytes: number;
}

/** lstat, or null when the path (or a parent) does not exist. */
async function lstatIfPresent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return null;
    throw error;
  }
}

function entryKind(entry: Dirent): InterruptedRemovalEntry['kind'] {
  return entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other';
}

/**
 * Inspect `<stateDir>/<runId>` as an interrupted flat-run removal, or return null when it is not one
 * by {@link interruptedRemovalShape}. Pass the runs container's listing to find backups without
 * reading it again. A directory that vanishes during the inspection is not judged (null), so a
 * concurrent removal reads as no leftover; other errors propagate. It takes no lock and reads no
 * ownership: the caller judges liveness. @internal
 */
export async function inspectInterruptedRemoval(
  stateDir: string,
  runId: string,
  entries?: readonly string[],
): Promise<InterruptedRemoval | null> {
  if (!isValidRunId(runId)) return null;
  const root = resolve(stateDir);
  // A record rules it out; checked first, since it is the common case in a container scan.
  if (await runRecordPresent(root, runId)) return null;
  const siblings = await runSiblingPaths(root, runId, entries);
  const path = runDirectory(root, runId);
  const stat = await lstatIfPresent(path);
  let directory: InterruptedRemovalFacts['directory'] = null;
  if (stat !== null) {
    const symlinkOrNotDirectory = stat.isSymbolicLink() || !stat.isDirectory();
    let listed: Dirent[] = [];
    if (!symlinkOrNotDirectory)
      try {
        listed = await readdir(path, { withFileTypes: true });
      } catch (error) {
        if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return null;
        throw error;
      }
    directory = {
      symlinkOrNotDirectory,
      entries: listed.map((entry) => ({
        name: entry.name,
        kind: entryKind(entry),
        lockStray: isLockStray('lock', entry.name),
      })),
    };
  }
  const guard = `${siblings.flat}.lock`;
  const facts: InterruptedRemovalFacts = {
    validRunId: true,
    recordPresent: false,
    inboxSibling: (await lstatIfPresent(siblings.inbox)) !== null,
    cancelSibling: (await lstatIfPresent(siblings.cancel)) !== null,
    backups: siblings.backups.length,
    directory,
  };
  if (!interruptedRemovalShape(facts)) return null;
  const paths: string[] = [];
  for (const candidate of [path, guard, ...siblings.backups])
    if ((await lstatIfPresent(candidate)) !== null) paths.push(candidate);
  return { runId, stateDir: root, path, paths, bytes: await runBytes(root, runId, entries) };
}

/**
 * Every interrupted flat-run removal in one runs container, sorted by run ID. It reads the container
 * once; the candidates are the valid run IDs among its entries and the IDs of its `.json.v<N>`
 * backups, minus IDs whose flat `<runId>.json` is listed. A missing container has none; a candidate
 * that cannot be inspected becomes a warning. @internal
 */
export async function scanInterruptedRemovals(
  stateDir: string,
): Promise<{ readonly removals: InterruptedRemoval[]; readonly warnings: string[] }> {
  const root = resolve(stateDir);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { removals: [], warnings: [] };
    return {
      removals: [],
      warnings: [
        `Could not scan ${root} for interrupted run removals: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const listed = new Set(names);
  const candidates = new Set<string>();
  for (const name of names) {
    if (isValidRunId(name)) candidates.add(name);
    const backup = /^(.+)\.json\.v\d$/u.exec(name)?.[1];
    if (backup !== undefined && isValidRunId(backup) && isRunBackup(backup, name))
      candidates.add(backup);
  }
  const removals: InterruptedRemoval[] = [];
  const warnings: string[] = [];
  for (const runId of [...candidates].sort()) {
    if (listed.has(`${runId}.json`)) continue;
    try {
      const removal = await inspectInterruptedRemoval(root, runId, names);
      if (removal) removals.push(removal);
    } catch (error) {
      warnings.push(
        `Could not inspect ${runId} in ${root} as an interrupted run removal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { removals, warnings };
}
