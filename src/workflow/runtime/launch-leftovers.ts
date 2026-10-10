import type { Dirent, Stats } from 'node:fs';
import { lstat, open, readdir, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { processIdentity } from '../../processes/identity.js';
import {
  groupLaunchFiles,
  isLoneLaunchDirectory,
  judgeLaunch,
  launchSettleFloorMs,
  leftoverRemovable,
  runnerFileName,
  type LaunchEntry,
  type LaunchJudgement,
  type RunnerIdentity,
} from './launch-leftover-decision.js';
import { isErrno, liveness } from './lock.js';
import { legacyRunPath, runDirectory } from './paths.js';
import { isValidRunId } from './run-errors.js';
import { runBytes, runSiblingPaths } from './run-size.js';

/**
 * Record the runner that `workflow start` just spawned as `launch/<n>.runner.json` (0600, created
 * exclusively): its PID, this host and its OS birth identity. Best effort: a failure returns false
 * and changes nothing else, since a launch without a runner record is judged by its age (ADR 0055).
 * A failed write removes the partial record this call created, so it never reads as a runner record;
 * a record that already existed is never touched. `openFile` is a test seam replacing `open`.
 * @internal
 */
export async function writeRunnerIdentity(
  launchDir: string,
  n: number,
  pid: number,
  openFile: typeof open = open,
): Promise<boolean> {
  const path = join(launchDir, runnerFileName(n));
  let created = false;
  try {
    const identity: RunnerIdentity = {
      pid,
      host: hostname(),
      osStartTime: processIdentity(pid)?.start ?? null,
    };
    await using handle = await openFile(path, 'wx', 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(identity)}\n`);
    return true;
  } catch {
    if (created) await rm(path, { force: true }).catch(() => undefined);
    return false;
  }
}

/** Test seams for the settle rule: the floor and the clock. @internal */
export interface LaunchSettleOptions {
  /** Age a launch without a runner record must reach to count as settled; default one hour. */
  readonly floorMs?: number | undefined;
  /** The current time in epoch milliseconds; default `Date.now()`. */
  readonly now?: (() => number) | undefined;
}

/** {@link LaunchSettleOptions} plus the runs container's listing, read once by a scan. */
interface InspectLeftoverOptions extends LaunchSettleOptions {
  readonly entries?: readonly string[] | undefined;
}

/** One launch number of a leftover, with its files and judgement. @internal */
export interface LeftoverLaunch extends LaunchJudgement {
  /** File names in `launch/`, sorted. */
  readonly files: readonly string[];
  /** The newest modification time among its files, as an ISO timestamp. */
  readonly newest: string;
}

/** A record-less `<runId>/` that holds only the `launch/` of a start that failed before its record. @internal */
export interface LaunchLeftover {
  readonly runId: string;
  /** Absolute runs container. */
  readonly stateDir: string;
  /** Absolute `<stateDir>/<runId>` directory. */
  readonly path: string;
  /** Apparent size of its files. */
  readonly bytes: number;
  readonly launches: readonly LeftoverLaunch[];
  /** The newest modification time of any launch file, or of `launch/` when it is empty. */
  readonly newest: string;
  /** The log of the highest launch number, or null when that launch has no log. */
  readonly log: string | null;
  /** Whether every launch is settled, so rm may remove it and list reports it. */
  readonly removable: boolean;
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return false;
    throw error;
  }
}

/**
 * Whether the run has a record now: `<runId>/run.json` or the legacy `<runId>.json`. An entry that
 * cannot be checked counts as present, so the ordinary record read reports it. @internal
 */
export async function runRecordPresent(stateDir: string, runId: string): Promise<boolean> {
  for (const path of [
    join(runDirectory(stateDir, runId), 'run.json'),
    legacyRunPath(stateDir, runId),
  ])
    if (await present(path).catch(() => true)) return true;
  return false;
}

async function lstatIfPresent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return null;
    throw error;
  }
}

function entryKind(entry: Dirent): LaunchEntry['kind'] {
  return entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other';
}

async function listEntries(path: string): Promise<LaunchEntry[] | null> {
  try {
    return (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      kind: entryKind(entry),
    }));
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return null;
    throw error;
  }
}

/**
 * Inspect `<stateDir>/<runId>` as a leftover launch directory, or return null when it is not one:
 * an invalid run ID, a record (`run.json` or `<runId>.json`), a legacy sibling (`.inbox`,
 * `.cancel.json` or a `.json.v<N>` backup), or anything in `<runId>/` but a lone `launch/` that holds
 * only numbered launch evidence files. Each launch is judged by its runner record or its age; a
 * runner's liveness is read only for a launch that has a record. A directory that loses a file
 * during the inspection is not judged (null), so a concurrent removal reads as no leftover.
 * @internal
 */
export async function inspectLaunchLeftover(
  stateDir: string,
  runId: string,
  options: InspectLeftoverOptions = {},
): Promise<LaunchLeftover | null> {
  if (!isValidRunId(runId)) return null;
  const root = resolve(stateDir);
  if (await runRecordPresent(root, runId)) return null;
  const siblings = await runSiblingPaths(root, runId, options.entries);
  if (
    siblings.backups.length ||
    (await present(siblings.cancel)) ||
    (await present(siblings.inbox))
  )
    return null;
  const path = runDirectory(root, runId);
  const top = await listEntries(path);
  if (top === null || !isLoneLaunchDirectory(top)) return null;
  const launchDir = join(path, 'launch');
  const entries = await listEntries(launchDir);
  const groups = entries && groupLaunchFiles(entries);
  if (!groups) return null;
  const nowMs = options.now?.() ?? Date.now();
  const floorMs = options.floorMs ?? launchSettleFloorMs;
  const launches = await judgeLaunchGroups(launchDir, groups, { nowMs, floorMs });
  if (launches === null) return null;
  const directory = await lstatIfPresent(launchDir);
  if (directory === null) return null;
  const directoryMtimeMs = directory.mtimeMs;
  const newestMs = launches.length
    ? Math.max(...launches.map((launch) => Date.parse(launch.newest)))
    : directoryMtimeMs;
  const last = launches.at(-1);
  const logName = last && `${String(last.n)}.log`;
  return {
    runId,
    stateDir: root,
    path,
    bytes: await runBytes(root, runId, options.entries),
    launches,
    newest: new Date(newestMs).toISOString(),
    log: logName && last.files.includes(logName) ? join(launchDir, logName) : null,
    removable: leftoverRemovable(launches, { directoryMtimeMs, nowMs, floorMs }),
  };
}

/**
 * Judge each launch number's files in `launchDir` by its runner record or its age; null when a file
 * vanished during the scan, so the directory changed under it.
 */
async function judgeLaunchGroups(
  launchDir: string,
  groups: readonly { readonly n: number; readonly files: readonly string[] }[],
  context: { readonly nowMs: number; readonly floorMs: number },
): Promise<LeftoverLaunch[] | null> {
  const launches: LeftoverLaunch[] = [];
  for (const group of groups) {
    let newestMtimeMs = 0;
    for (const name of group.files) {
      const stat = await lstatIfPresent(join(launchDir, name));
      // A file that vanished meanwhile: the directory changed under the scan, so judge it again.
      if (stat === null) return null;
      newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    }
    const runnerName = runnerFileName(group.n);
    // A runner record that vanished or cannot be read is judged as unparsable: in flight.
    const runnerText = group.files.includes(runnerName)
      ? await readFile(join(launchDir, runnerName), 'utf8').catch(() => '')
      : null;
    const judgement = judgeLaunch(
      { n: group.n, runnerText, newestMtimeMs },
      { ...context, liveness },
    );
    launches.push({
      ...judgement,
      files: group.files,
      newest: new Date(newestMtimeMs).toISOString(),
    });
  }
  return launches;
}

/**
 * Judge every launch in `<stateDir>/<runId>/launch/` of a run whose record exists but cannot be
 * read, by the same rule as a leftover's (ADR 0055, ADR 0060). Only numbered launch evidence files
 * are judged; any other entry is ignored rather than making the directory unjudgeable. Returns []
 * when `launch/` is absent, and null when a file vanished during the scan. @internal
 */
export async function inspectRunLaunches(
  stateDir: string,
  runId: string,
  options: LaunchSettleOptions = {},
): Promise<LeftoverLaunch[] | null> {
  const launchDir = join(runDirectory(resolve(stateDir), runId), 'launch');
  const entries = await listEntries(launchDir);
  if (entries === null) return [];
  const groups = groupLaunchFiles(entries, { ignoreOthers: true }) ?? [];
  return judgeLaunchGroups(launchDir, groups, {
    nowMs: options.now?.() ?? Date.now(),
    floorMs: options.floorMs ?? launchSettleFloorMs,
  });
}

/**
 * Every leftover launch directory in one runs container, removable or not, sorted by run ID. A
 * missing container has none; an entry that cannot be inspected becomes a warning. @internal
 */
export async function scanLaunchLeftovers(
  stateDir: string,
  options: LaunchSettleOptions = {},
): Promise<{ readonly leftovers: LaunchLeftover[]; readonly warnings: string[] }> {
  const root = resolve(stateDir);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { leftovers: [], warnings: [] };
    return {
      leftovers: [],
      warnings: [
        `Could not scan ${root} for leftover launch directories: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const names = entries.map((entry) => entry.name);
  const leftovers: LaunchLeftover[] = [];
  const warnings: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    try {
      const leftover = await inspectLaunchLeftover(root, entry.name, {
        ...options,
        entries: names,
      });
      if (leftover) leftovers.push(leftover);
    } catch (error) {
      warnings.push(
        `Could not inspect ${entry.name} in ${root} as a leftover launch directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { leftovers, warnings };
}
