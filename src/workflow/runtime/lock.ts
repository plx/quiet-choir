import { createStorageDirectory, syncDirectory, syncHandle } from './storage-io.js';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

function ownerState(
  owner: z.infer<typeof ownerSchema>,
): 'alive' | 'dead' | 'unknown' | 'remote' | 'released' {
  if (owner.host !== hostname()) return 'remote';
  if (owner.released) return 'released';
  const state = pidState(owner.pid);
  if (state !== 'alive') return state;
  const identity = processIdentity(owner.pid);
  if (
    identity?.zombie ||
    (owner.osStartTime && identity?.start && owner.osStartTime !== identity.start)
  )
    return 'dead';
  return 'alive';
}

/** Ephemeral ownership diagnostics; never included in replay identity or the saved checkpoint. */
export interface RunOwnership {
  /** Whether a lock currently exists. */
  readonly locked: boolean;
  /** Local owner metadata and liveness, or null for an absent/incomplete lock. */
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
}

/** Read owner and child liveness without importing workflow code or changing any files. */
export async function inspectRunOwnership(options: ReadRunOptions): Promise<RunOwnership> {
  const lockPath = runLockPath(resolveStateDir(options), options.runId);
  try {
    const owner = ownerSchema.parse(
      JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')),
    );
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
    };
  } catch (error) {
    try {
      await readdir(lockPath);
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
        return { locked: false, owner: null, processes: [] };
    }
    return {
      locked: true,
      owner: null,
      processes: [],
      warning: error instanceof Error ? error.message : String(error),
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      let previous;
      try {
        previous = ownerSchema.parse(
          JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')),
        );
      } catch (cause) {
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
          { cause: error },
        );
      // Only one contender may remove a dead owner's lock. Recheck ownership after winning recovery.
      const recovery = join(lockPath, 'recovery');
      try {
        await mkdir(recovery);
      } catch (cause) {
        throw new RunRefusedError(
          'run.locked',
          runId,
          `Run ${runId} lock recovery is in progress; retry or inspect ${lockPath}.`,
          { lockPath },
          { cause },
        );
      }
      let removed = false;
      try {
        const current = ownerSchema.parse(
          JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')),
        );
        if (
          current.token !== previous.token ||
          !['dead', 'released'].includes(ownerState(current))
        ) {
          throw new RunRefusedError(
            'run.locked',
            runId,
            `Run ${runId} lock ownership changed during recovery; retry.`,
            { lockPath },
            {
              cause: error,
            },
          );
        }
        await recoverProcesses(lockPath, runId, current.token, {
          killGraceMs: options.killGraceMs ?? 3000,
          processSupervisor: supervisor,
          ...(options.killOrphans === undefined ? {} : { killOrphans: options.killOrphans }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        await rm(lockPath, { recursive: true });
        removed = true;
      } finally {
        if (!removed) await rm(recovery, { recursive: true, force: true });
      }
      continue;
    }
    try {
      await using file = await open(join(lockPath, 'owner.json'), 'wx', 0o600);
      await file.writeFile(JSON.stringify(owner));
      await syncHandle(file);
      await syncDirectory(lockPath);
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
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
    const release = async (): Promise<void> => {
      let current;
      try {
        current = ownerSchema.parse(
          JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')),
        );
      } catch (cause) {
        // A vanished lock keeps its errno; missing or unreadable metadata in a present lock does not,
        // so callers cannot mistake unverified ownership for a cleanup-only failure.
        if (isErrno(cause, 'ENOENT') && (await lockGone(lockPath))) throw cause;
        throw new Error(`Run ${runId} lock ownership could not be verified; inspect ${lockPath}.`, {
          cause,
        });
      }
      if (current.token !== owner.token) throw new Error(`Run ${runId} lock ownership was lost.`);
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
      await rm(lockPath, { recursive: true });
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
