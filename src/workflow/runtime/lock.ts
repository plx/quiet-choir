import { createStorageDirectory, syncDirectory, syncHandle } from './storage-io.js';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { HarnessInvocation, HarnessProcess } from './model.js';
import { pidState, processIdentity } from '../../processes/identity.js';
import { ProcessSupervisor } from '../../processes/supervisor.js';
import {
  inspectProcesses,
  recoverProcesses,
  trackProcess,
  OrphanProcessesError,
  type HarnessProcessInspection,
} from './process-registry.js';
import { RunRefusedError } from './run-errors.js';
import {
  resolveStateDir,
  runLockPath,
  runDirectory,
  legacyRunPath,
  prepareStateDirectory,
} from './paths.js';
import type { ReadRunOptions } from './store.js';

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  token: z.string(),
  osStartTime: z.string().nullable().optional(),
  released: z.boolean().optional(),
});

/** A recoverer's claim inside a lock; published whole by link(), so a visible one is complete. */
const markerSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  token: z.string(),
  osStartTime: z.string().nullable().optional(),
});

type Owner = z.infer<typeof ownerSchema>;
type Marker = z.infer<typeof markerSchema>;
type Liveness = 'alive' | 'dead' | 'unknown' | 'remote';

/** Local liveness of the process that wrote an owner or recovery record. */
function liveness(identity: {
  readonly pid: number;
  readonly host: string;
  readonly osStartTime?: string | null | undefined;
}): Liveness {
  if (identity.host !== hostname()) return 'remote';
  const state = pidState(identity.pid);
  if (state !== 'alive') return state;
  const current = processIdentity(identity.pid);
  if (
    current?.zombie ||
    (identity.osStartTime && current?.start && identity.osStartTime !== current.start)
  )
    return 'dead';
  return 'alive';
}

function ownerState(owner: Owner): Liveness | 'released' {
  if (owner.host !== hostname()) return 'remote';
  if (owner.released) return 'released';
  return liveness(owner);
}

const strayPattern = /^(\d+)\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(tmp|gone)$/u;

/** A sibling of the lock directory owned by this process: a publish tmp or a release tombstone. */
function siblingPath(lockPath: string, kind: 'tmp' | 'gone'): string {
  return `${lockPath}.${String(process.pid)}.${randomUUID()}.${kind}`;
}

/** Parse `<lock>.<pid>.<uuid>.(tmp|gone)` for the named lock only. */
function parseStray(
  lockName: string,
  entry: string,
): { readonly pid: number; readonly kind: 'tmp' | 'gone' } | undefined {
  if (!entry.startsWith(`${lockName}.`)) return undefined;
  const match = strayPattern.exec(entry.slice(lockName.length + 1));
  if (!match?.[1] || !match[2]) return undefined;
  return { pid: Number(match[1]), kind: match[2] === 'gone' ? 'gone' : 'tmp' };
}

async function readOwner(lockPath: string): Promise<Owner> {
  return ownerSchema.parse(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')));
}

async function readMarker(path: string): Promise<Marker> {
  return markerSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** One lock directory as inspection sees it. */
export interface RunLockView {
  /** `primary` is `<runId>/lock`; `guard` is the legacy `<runId>.json.lock` every writer also holds. */
  readonly kind: 'primary' | 'guard';
  /** Absolute lock directory path. */
  readonly path: string;
  /** Owner metadata and liveness, or null when `owner.json` is missing or unreadable. */
  readonly owner: {
    /** Writer's recorded process ID. */
    readonly pid: number;
    /** Host on which the writer acquired ownership. */
    readonly host: string;
    /** Current local liveness or a state that prevents ordinary automatic reclamation. */
    readonly state: 'alive' | 'dead' | 'unknown' | 'remote' | 'released';
  } | null;
  /**
   * The recovery marker (`recovery.json`) of a process reclaiming this lock, or null. A dead
   * recoverer's marker is reclaimed by the next acquire; any other state holds the lock.
   */
  readonly recovery: {
    /** Recoverer's process ID. */
    readonly pid: number;
    /** Host on which the recoverer runs. */
    readonly host: string;
    /** Current local liveness of the recoverer. */
    readonly state: 'alive' | 'dead' | 'unknown' | 'remote';
  } | null;
  /** Set only when `owner.json` or `recovery.json` exists but cannot be read or parsed. */
  readonly warning?: string;
}

/** Ephemeral ownership diagnostics; never included in replay identity or the saved checkpoint. */
export interface RunOwnership {
  /** Whether a lock currently exists. */
  readonly locked: boolean;
  /**
   * Local owner metadata and liveness of the lock that ownership resolves to (the primary lock, or
   * the legacy guard when only it exists), or null for an absent/incomplete lock.
   */
  readonly owner: {
    /** Writer's recorded process ID. */
    readonly pid: number;
    /** Host on which the writer acquired ownership. */
    readonly host: string;
    /** Current local liveness or a state that prevents ordinary automatic reclamation. */
    readonly state: 'alive' | 'dead' | 'unknown' | 'remote' | 'released';
  } | null;
  /** Child/group records, including unverifiable entries. */
  readonly processes: readonly HarnessProcessInspection[];
  /** Read-only inspection failures; never permission to remove the lock. */
  readonly warning?: string;
  /**
   * Every existing lock directory of the run, primary first, then the legacy guard, each with its
   * owner and any recovery marker. Empty when the run is not locked.
   */
  readonly locks: readonly RunLockView[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read one lock directory, or undefined when it does not exist. */
async function inspectLock(
  kind: RunLockView['kind'],
  path: string,
): Promise<RunLockView | undefined> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    return { kind, path, owner: null, recovery: null, warning: message(error) };
  }
  const warnings: string[] = [];
  let owner: RunLockView['owner'] = null;
  let recovery: RunLockView['recovery'] = null;
  if (names.includes('owner.json'))
    try {
      const value = await readOwner(path);
      owner = { pid: value.pid, host: value.host, state: ownerState(value) };
    } catch (error) {
      // Retired between the listing and the read: report what was there, not a damage warning.
      if (isErrno(error, 'ENOENT') && (await lockGone(path))) return undefined;
      warnings.push(`owner.json: ${message(error)}`);
    }
  if (names.includes('recovery.json'))
    try {
      const value = await readMarker(join(path, 'recovery.json'));
      recovery = { pid: value.pid, host: value.host, state: liveness(value) };
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) warnings.push(`recovery.json: ${message(error)}`);
    }
  return {
    kind,
    path,
    owner,
    recovery,
    ...(warnings.length ? { warning: warnings.join('; ') } : {}),
  };
}

/** Read owner and child liveness without importing workflow code or changing any files. */
export async function inspectRunOwnership(options: ReadRunOptions): Promise<RunOwnership> {
  const stateDir = resolveStateDir(options);
  const lockPath = runLockPath(stateDir, options.runId);
  const locks = (
    await Promise.all([
      inspectLock('primary', join(runDirectory(stateDir, options.runId), 'lock')),
      inspectLock('guard', `${legacyRunPath(stateDir, options.runId)}.lock`),
    ])
  ).filter((lock) => lock !== undefined);
  try {
    const owner = await readOwner(lockPath);
    const state = ownerState(owner);
    const processes = await inspectProcesses(lockPath, options.runId, owner.token);
    return {
      locked: true,
      owner: { pid: owner.pid, host: owner.host, state },
      processes:
        state === 'remote'
          ? processes.map((entry) => ({
              ...entry,
              state: 'unknown',
              detail: 'Remote owner: local PID observations cannot identify its children.',
            }))
          : processes,
      locks,
    };
  } catch (error) {
    try {
      await readdir(lockPath);
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
        return { locked: false, owner: null, processes: [], locks };
    }
    return {
      locked: true,
      owner: null,
      processes: [],
      warning: error instanceof Error ? error.message : String(error),
      locks,
    };
  }
}

export interface RunLock {
  (): Promise<void>;
  trackProcess(
    invocation: Pick<HarnessInvocation, 'runId' | 'stepId' | 'attempt'>,
    process: HarnessProcess,
  ): ReturnType<HarnessInvocation['trackProcess']>;
}

/** Live local owner/recovery configuration. @internal */
export interface RunLockOptions {
  readonly killOrphans?: boolean;
  readonly killGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly processSupervisor?: ProcessSupervisor;
  readonly probeOwner?: boolean;
  readonly cwd?: string;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function lockGone(lockPath: string): Promise<boolean> {
  try {
    await lstat(lockPath);
    return false;
  } catch (error) {
    return isErrno(error, 'ENOENT');
  }
}

/**
 * Acquire both the legacy guard and current ownership, always in the same order, for every run —
 * migrated or not — so a pre-format-7 binary starting the same run ID in the same explicit state
 * container is excluded even when no legacy record exists yet. @internal
 */
export async function lockRun(
  stateDir: string,
  runId: string,
  options: RunLockOptions = {},
): Promise<RunLock> {
  const legacy = legacyRunPath(stateDir, runId);
  const primary = join(runDirectory(stateDir, runId), 'lock');
  const guard = await acquireLock(stateDir, runId, `${legacy}.lock`, options);
  let owner: RunLock;
  try {
    owner = await acquireLock(stateDir, runId, primary, options);
  } catch (error) {
    try {
      await guard();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'Could not acquire current ownership or release the legacy guard.',
        { cause: releaseError },
      );
    }
    throw error;
  }
  const release = async (): Promise<void> => {
    const errors: unknown[] = [];
    try {
      await owner();
    } catch (error) {
      errors.push(error);
    }
    try {
      await guard();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    // Both locks vanished (or both failed removal after verified ownership): keep the shared errno
    // so callers treat it like the single-lock case. Mixed or unverified failures stay aggregate.
    if (
      errors.length > 1 &&
      ['ENOENT', 'EACCES'].some((code) => errors.every((error) => isErrno(error, code)))
    )
      throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, 'Could not release current and legacy ownership.', {
        cause: errors[0],
      });
  };
  return Object.assign(release, { trackProcess: owner.trackProcess.bind(owner) });
}

/**
 * Publish a complete lock in one rename: a private sibling directory already holding a durable
 * `owner.json` replaces an absent (or empty, older-build) lock path. `contended` means another
 * lock is there; the tmp directory never outlives this call unless it became the lock.
 */
async function publishLock(lockPath: string, owner: Owner): Promise<'published' | 'contended'> {
  const temporary = siblingPath(lockPath, 'tmp');
  let published = false;
  try {
    await mkdir(temporary, { mode: 0o700 });
    {
      await using file = await open(join(temporary, 'owner.json'), 'wx', 0o600);
      await file.writeFile(JSON.stringify(owner));
      await syncHandle(file);
    }
    await syncDirectory(temporary);
    await syncDirectory(dirname(lockPath));
    try {
      await rename(temporary, lockPath);
    } catch (error) {
      if (isErrno(error, 'ENOTEMPTY') || isErrno(error, 'EEXIST')) return 'contended';
      // Windows refuses to rename onto any existing directory.
      if (isErrno(error, 'EPERM') && !(await lockGone(lockPath))) return 'contended';
      throw error;
    }
    published = true;
    return 'published';
  } finally {
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * Move a verified lock out of the way in one rename, check that the tombstone is the lock that was
 * verified, then delete it. A mismatch renames it back and throws `mismatch()`; a tombstone that a
 * new owner already swept counts as retired. The rename and removal keep their errno.
 */
async function retire(
  lockPath: string,
  expected: { readonly owner: string; readonly recovery?: string },
  mismatch: () => Error,
): Promise<void> {
  const tombstone = siblingPath(lockPath, 'gone');
  await rename(lockPath, tombstone);
  await syncDirectory(dirname(lockPath));
  let matches: boolean;
  try {
    matches =
      (await readOwner(tombstone)).token === expected.owner &&
      (expected.recovery === undefined ||
        (await readMarker(join(tombstone, 'recovery.json'))).token === expected.recovery);
  } catch {
    // A new owner may already have swept a verified tombstone.
    if (await lockGone(tombstone)) return;
    matches = false;
  }
  if (!matches) {
    await rename(tombstone, lockPath).catch(() => undefined);
    throw mismatch();
  }
  await rm(tombstone, { recursive: true, force: true });
}

/** Best effort: remove this lock's stray tombstones and dead creators' publish directories. */
async function sweepStrays(lockPath: string): Promise<void> {
  const directory = dirname(lockPath);
  const name = basename(lockPath);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const stray = parseStray(name, entry);
    if (!stray || (stray.kind === 'tmp' && pidState(stray.pid) !== 'dead')) continue;
    // A stray is harmless; one that cannot be removed must never block ownership.
    await rm(join(directory, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Publish `marker` as `<lock>/recovery.json` by linking a durable temporary file, so a visible
 * marker is always complete. `exists` is contention; `gone` means the lock itself vanished.
 */
async function publishMarker(
  lockPath: string,
  marker: Marker,
): Promise<'published' | 'exists' | 'gone'> {
  const temporary = join(lockPath, `recovery.${randomUUID()}.tmp`);
  try {
    try {
      await using file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify(marker));
      await syncHandle(file);
      await link(temporary, join(lockPath, 'recovery.json'));
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return 'exists';
      if (isErrno(error, 'ENOENT')) return 'gone';
      throw error;
    }
    await syncDirectory(lockPath);
    return 'published';
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Take `recovery.json` aside and keep it only if it still carries `token`; otherwise put it back
 * (leaving it aside if a new marker appeared meanwhile). `missing` means there was none to take.
 */
async function takeMarker(lockPath: string, token: string): Promise<'taken' | 'kept' | 'missing'> {
  const current = join(lockPath, 'recovery.json');
  const aside = join(lockPath, `recovery.${randomUUID()}.stale`);
  try {
    await rename(current, aside);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 'missing';
    throw error;
  }
  let taken: Marker | undefined;
  try {
    taken = await readMarker(aside);
  } catch {
    taken = undefined;
  }
  if (taken?.token === token) {
    await rm(aside, { force: true });
    return 'taken';
  }
  try {
    await link(aside, current);
    await rm(aside, { force: true });
  } catch (error) {
    // A newer marker won the name; the displaced one stays aside and leaves with the lock.
    if (!isErrno(error, 'EEXIST')) throw error;
  }
  return 'kept';
}

/**
 * Win the right to recover a dead or released lock: publish our marker, or reclaim a dead
 * recoverer's marker. Refuses while a live, unknown, remote or unreadable marker holds it; `retry`
 * means the lock or marker changed underneath and the acquire loop should look again.
 */
async function claimRecovery(
  runId: string,
  lockPath: string,
  marker: Marker,
  changed: () => Error,
): Promise<'claimed' | 'retry'> {
  const published = await publishMarker(lockPath, marker);
  if (published === 'published') return 'claimed';
  if (published === 'gone') return 'retry';
  const inProgress = (cause: unknown): RunRefusedError =>
    new RunRefusedError(
      'run.locked',
      runId,
      `Run ${runId} lock recovery is in progress; retry or inspect ${lockPath}.`,
      { lockPath },
      { cause },
    );
  let existing: Marker;
  try {
    existing = await readMarker(join(lockPath, 'recovery.json'));
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) return 'retry';
    throw inProgress(cause);
  }
  if (liveness(existing) !== 'dead') throw inProgress(undefined);
  // Reclaim only the marker that was judged dead, never one that replaced it meanwhile.
  const taken = await takeMarker(lockPath, existing.token);
  if (taken === 'missing') return 'retry';
  if (taken === 'kept') throw changed();
  const republished = await publishMarker(lockPath, marker);
  if (republished === 'published') return 'claimed';
  if (republished === 'gone') return 'retry';
  throw changed();
}

async function acquireLock(
  stateDir: string,
  runId: string,
  lockPath: string,
  options: RunLockOptions,
): Promise<RunLock> {
  await prepareStateDirectory(resolve(stateDir), options.cwd);
  await createStorageDirectory(dirname(lockPath));
  const owner = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
    osStartTime:
      options.probeOwner === false ? null : (processIdentity(process.pid)?.start ?? null),
  };
  const supervisor = options.processSupervisor ?? new ProcessSupervisor();
  const changed = (cause?: unknown): RunRefusedError =>
    new RunRefusedError(
      'run.locked',
      runId,
      `Run ${runId} lock ownership changed during recovery; retry.`,
      { lockPath },
      cause === undefined ? undefined : { cause },
    );
  const lost = (): Error => new Error(`Run ${runId} lock ownership was lost.`);
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await publishLock(lockPath, owner)) === 'contended') {
      let previous;
      try {
        previous = await readOwner(lockPath);
      } catch (cause) {
        // Released between the failed publish and this read: look again.
        if (isErrno(cause, 'ENOENT') && (await lockGone(lockPath))) continue;
        throw new RunRefusedError(
          'run.locked',
          runId,
          `Run ${runId} is locked with incomplete ownership metadata; inspect ${lockPath} before removing an abandoned lock.`,
          { lockPath },
          { cause },
        );
      }
      if (!['dead', 'released'].includes(ownerState(previous)))
        throw new RunRefusedError(
          'run.locked',
          runId,
          `Run ${runId} is locked by PID ${String(previous.pid)} on ${previous.host}.`,
          { pid: previous.pid, host: previous.host, lockPath },
        );
      // Only one contender may retire a dead owner's lock. Recheck ownership after winning recovery.
      const marker = {
        pid: owner.pid,
        host: owner.host,
        osStartTime: owner.osStartTime,
        token: randomUUID(),
      };
      if ((await claimRecovery(runId, lockPath, marker, changed)) === 'retry') continue;
      let retired = false;
      try {
        const current = await readOwner(lockPath);
        if (current.token !== previous.token || !['dead', 'released'].includes(ownerState(current)))
          throw changed();
        await recoverProcesses(lockPath, runId, current.token, {
          killGraceMs: options.killGraceMs ?? 3000,
          processSupervisor: supervisor,
          ...(options.killOrphans === undefined ? {} : { killOrphans: options.killOrphans }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        // A reclaimer that judged this recoverer dead may have taken the marker meanwhile.
        let mine;
        try {
          mine = await readMarker(join(lockPath, 'recovery.json'));
        } catch (cause) {
          throw changed(cause);
        }
        if (mine.token !== marker.token) throw changed();
        await retire(lockPath, { owner: current.token, recovery: marker.token }, changed);
        retired = true;
      } finally {
        if (!retired) await takeMarker(lockPath, marker.token).catch(() => undefined);
      }
      continue;
    }
    try {
      await syncDirectory(dirname(lockPath));
      // Only this run's lock owner can remove abandoned atomic-write files.
      for (const [directory, prefix] of (
        [
          [resolve(stateDir), `${runId}.json.`],
          [dirname(lockPath), 'run.json.'],
        ] as const
      ).filter((entry, index) => index === 0 || entry[0] !== resolve(stateDir))) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (
            entry.isFile() &&
            entry.name.startsWith(prefix) &&
            /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/u.test(
              entry.name.slice(prefix.length),
            )
          )
            await rm(join(directory, entry.name), { force: true });
        }
      }
    } catch (error) {
      await retire(lockPath, { owner: owner.token }, lost).catch(() => undefined);
      throw error;
    }
    await sweepStrays(lockPath);
    const release = async (): Promise<void> => {
      let current;
      try {
        current = await readOwner(lockPath);
      } catch (cause) {
        // A vanished lock keeps its errno; missing or unreadable metadata in a present lock does not,
        // so callers cannot mistake unverified ownership for a cleanup-only failure.
        if (isErrno(cause, 'ENOENT') && (await lockGone(lockPath))) throw cause;
        throw new Error(`Run ${runId} lock ownership could not be verified; inspect ${lockPath}.`, {
          cause,
        });
      }
      if (current.token !== owner.token) throw lost();
      const processes = await inspectProcesses(lockPath, runId, owner.token);
      if (processes.some((entry) => entry.state === 'alive' || entry.state === 'unknown')) {
        // The workflow no longer owns work, but its child records must survive even in a long-lived embedder.
        const temp = join(lockPath, `owner.${randomUUID()}.tmp`);
        await using file = await open(temp, 'wx', 0o600);
        await file.writeFile(JSON.stringify({ ...owner, released: true }));
        await syncHandle(file);
        await rename(temp, join(lockPath, 'owner.json'));
        throw new OrphanProcessesError(runId, processes);
      }
      await retire(lockPath, { owner: owner.token }, lost);
    };
    return Object.assign(release, {
      trackProcess: (
        invocation: Pick<HarnessInvocation, 'runId' | 'stepId' | 'attempt'>,
        child: HarnessProcess,
      ) => trackProcess(lockPath, owner.token, supervisor, invocation, child),
    });
  }
  throw new RunRefusedError(
    'run.locked',
    runId,
    `Could not acquire run ${runId}; retry after competing writers finish.`,
    { lockPath },
  );
}
