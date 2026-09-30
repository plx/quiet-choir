import { RunRefusedError } from './run-errors.js';
import { syncDirectory as storageSyncDirectory, syncHandle } from './storage-io.js';
import { jsonValue } from './json.js';
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { groupState, processIdentity, signalProcess } from '../../processes/identity.js';
import type { ProcessSupervisor } from '../../processes/supervisor.js';
import type { HarnessInvocation, HarnessProcess } from './model.js';

/** OS ownership record, stored under the run lock rather than in the replay checkpoint. */
export interface HarnessProcessRecord extends HarnessProcess {
  /** Owning run. */
  readonly runId: string;
  /** Fully qualified effect name; discovery uses the triggering effect's identity. */
  readonly stepId: string;
  /** Attempt that spawned this child. */
  readonly attempt: number;
  /** Writer ownership token. */
  readonly ownerToken: string;
}

/** Read-only current observation of a recorded child/group. */
export interface HarnessProcessInspection {
  /** Record filename (also available for malformed records). */
  readonly file: string;
  /** Validated record, or null if malformed. */
  readonly process: HarnessProcessRecord | null;
  /** Reused identifies a different OS birth identity; unknown never authorizes a signal. */
  readonly state: 'alive' | 'dead' | 'reused' | 'unknown';
  /** Reason an observation cannot authorize recovery. */
  readonly detail?: string;
}

const processSchema = z
  .object({
    pid: z.number().int().min(2).max(2_147_483_647),
    pgid: z.number().int().min(2).max(2_147_483_647).nullable(),
    binary: z.string().min(1),
    cwd: z.string().min(1),
    startedAt: z.iso.datetime(),
    osStartTime: z.string().min(1).nullable(),
    runId: z.string(),
    stepId: z.string(),
    attempt: z.number().int().positive(),
    ownerToken: z.string(),
  })
  .refine(
    (record) => record.pgid === null || record.pgid === record.pid,
    'Group must belong to its leader',
  );

/** A live or unverifiable process record prevents replacement work. */
export class OrphanProcessesError extends RunRefusedError {
  /** Stable refusal code for live or unverifiable child processes. */
  public override readonly code = 'run.orphans';
  /** Read-only observations retained for inspection. */
  public readonly processes: readonly HarnessProcessInspection[];

  /** Describe the surviving/unverifiable processes without exposing prompts or environment. */
  public constructor(runId: string, processes: readonly HarnessProcessInspection[]) {
    const pending = processes.filter(
      (entry) => entry.state === 'alive' || entry.state === 'unknown',
    );
    super(
      'run.orphans',
      runId,
      `Run ${runId} has ${String(pending.length)} live or unverified harness processes (${pending.map((entry) => (entry.process ? `${entry.process.binary} pid ${String(entry.process.pid)}, step ${entry.process.stepId}, attempt ${String(entry.process.attempt)}: ${entry.state}` : `${entry.file}: ${entry.detail ?? 'invalid record'}`)).join('; ')}). Stop confirmed processes with --kill-orphans, or wait. Unverified identities are never signaled; inspect the retained lock.`,
      jsonValue({ processes }),
    );
    this.name = 'OrphanProcessesError';
    this.processes = processes;
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Windows has no POSIX directory fsync; file content is still flushed there.
  if (process.platform === 'win32') return;
  await storageSyncDirectory(path);
}

function observe(record: HarnessProcessRecord, file: string): HarnessProcessInspection {
  const identity = processIdentity(record.pid);
  if (identity?.start && record.osStartTime && identity.start !== record.osStartTime)
    return {
      process: record,
      file,
      state: 'reused',
      detail: 'PID now belongs to a different process; never signal it.',
    };
  const state = groupState(record);
  if (state === 'dead') return { process: record, file, state: 'dead' };
  if (
    state === 'alive' &&
    identity?.start &&
    record.osStartTime === identity.start &&
    identity.pgid === record.pgid
  )
    return { process: record, file, state: 'alive' };
  return {
    process: record,
    file,
    state: 'unknown',
    detail: 'Cannot confirm the original leader birth identity and group; no signal is authorized.',
  };
}

/** Read records without modifying the lock; malformed ownership is retained. @internal */
export async function inspectProcesses(
  lockPath: string,
  runId: string,
  ownerToken: string,
): Promise<HarnessProcessInspection[]> {
  const directory = join(lockPath, 'processes');
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(
    files.sort().map(async (file) => {
      try {
        const record = processSchema.parse(
          JSON.parse(await readFile(join(directory, file), 'utf8')),
        );
        if (
          record.ownerToken !== ownerToken ||
          record.runId !== runId ||
          file !== `${String(record.pgid ?? record.pid)}.json`
        )
          throw new Error('Process record ownership or filename mismatch.');
        return observe(record, file);
      } catch (error) {
        // A concurrent release may have removed this file after readdir.
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          return { file, process: null, state: 'dead' as const };
        return {
          file,
          process: null,
          state: 'unknown' as const,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/** Register in memory synchronously, then flush ownership before allowing task input. @internal */
export async function trackProcess(
  lockPath: string,
  ownerToken: string,
  supervisor: ProcessSupervisor,
  invocation: Pick<HarnessInvocation, 'runId' | 'stepId' | 'attempt'>,
  child: HarnessProcess,
): ReturnType<HarnessInvocation['trackProcess']> {
  const record = processSchema.parse({ ...child, ...invocation, ownerToken });
  if (record.pid === process.pid) throw new Error('A harness cannot register its own runner PID.');
  const forget = supervisor.track(record);
  const directory = join(lockPath, 'processes');
  const path = join(directory, `${String(record.pgid ?? record.pid)}.json`);
  try {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    await using file = await open(path, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(record)}\n`);
    await syncHandle(file);
    await syncDirectory(directory);
    await syncDirectory(lockPath);
  } catch (error) {
    // Keep live ownership in memory so a second signal still reaches this child.
    if (groupState(record) === 'dead') forget();
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      const observed = observe(record, path);
      if (observed.state !== 'dead' && observed.state !== 'reused')
        throw new OrphanProcessesError(record.runId, [observed]);
      forget();
      const current = processSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (JSON.stringify(current) !== JSON.stringify(record))
        throw new Error('Process record ownership changed before release.');
      await rm(path);
      await syncDirectory(directory);
      released = true;
    },
  };
}

/** Guard dead-owner recovery, optionally stopping only currently identity-confirmed children. @internal */
export async function recoverProcesses(
  lockPath: string,
  runId: string,
  ownerToken: string,
  options: {
    readonly killOrphans?: boolean;
    readonly killGraceMs: number;
    readonly signal?: AbortSignal;
    readonly processSupervisor?: ProcessSupervisor;
  },
): Promise<void> {
  let entries = await inspectProcesses(lockPath, runId, ownerToken);
  const pending = (): boolean =>
    entries.some((entry) => entry.state === 'alive' || entry.state === 'unknown');
  if (!pending()) return;
  if (!options.killOrphans || entries.some((entry) => entry.state === 'unknown'))
    throw new OrphanProcessesError(runId, entries);
  const send = (signal: NodeJS.Signals): void => {
    for (const entry of entries) {
      if (!entry.process || entry.state !== 'alive') continue;
      const current = observe(entry.process, entry.file);
      if (current.state === 'unknown') throw new OrphanProcessesError(runId, [current]);
      if (current.state === 'alive') signalProcess(entry.process, signal);
    }
  };
  options.signal?.throwIfAborted();
  const owned = entries.flatMap((entry) =>
    entry.process && entry.state === 'alive' && options.processSupervisor
      ? [{ process: entry.process, forget: options.processSupervisor.track(entry.process) }]
      : [],
  );
  try {
    send('SIGTERM');
    for (const [duration, escalate] of [
      [options.killGraceMs, true],
      [500, false],
    ] as const) {
      const end = performance.now() + duration;
      do {
        entries = await inspectProcesses(lockPath, runId, ownerToken);
        if (!pending()) {
          options.signal?.throwIfAborted();
          return;
        }
        // Once stopping has begun, a first signal must still drain/escalate these owned children.
        await delay(Math.min(50, Math.max(1, end - performance.now())));
      } while (performance.now() < end);
      if (escalate) send('SIGKILL');
    }
    entries = await inspectProcesses(lockPath, runId, ownerToken);
    if (pending()) throw new OrphanProcessesError(runId, entries);
    options.signal?.throwIfAborted();
  } finally {
    for (const entry of owned) if (groupState(entry.process) === 'dead') entry.forget();
  }
}
