import { existsSync } from 'node:fs';
import { AttemptTranscript } from './agent-transcript.js';
import type { AgentTranscriptWriter } from './agent-stream-model.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { ProcessSupervisor } from '../../processes/supervisor.js';
import { validateStepId } from './identity.js';
import { legacyRunPath, runDirectory } from './paths.js';
import { JournalWriter } from './journal.js';
import { prepareStorageMigration, finishStorageMigration } from './storage-migration.js';
import { writeCheckpoint } from './checkpoint.js';
import { refuseRecordSchemaDrift } from './record.js';
import {
  lockRun,
  readRun,
  listRunIds,
  type OwnedRunLock,
  type RunLock,
  type RunRecord,
} from './store.js';

/** Live ownership options, separate from serializable workflow plans. */
export interface RunStoreOpenOptions {
  /** Explicitly stop identity-confirmed children of a dead or released owner. */
  readonly killOrphans?: boolean;
  /** TERM-to-KILL grace period used while recovering recorded children. */
  readonly killGraceMs?: number;
  /** Cancels ownership recovery. */
  readonly signal?: AbortSignal;
  /** Shares recovered child groups with an embedder's forced-shutdown handler. */
  readonly processSupervisor?: ProcessSupervisor;
  /** Skip native birth-identity probing for process-free rehearsals. */
  readonly probeOwner?: boolean;
  /** Canonical project working directory, used to register default state roots. */
  readonly cwd?: string;
}

/** One exclusive writer, with all queued writes drained before release. */
export interface OwnedRunStore {
  /** Allocate capped private attempt evidence; agents require this port unless transcripts are off. */
  transcript?(
    stepId: string,
    attempt: number,
    harness: string,
    maxBytes: number,
  ): Promise<AgentTranscriptWriter>;
  /** Read existing state under this writer's ownership; absence is undefined. */
  read(): Promise<RunRecord | undefined>;
  /** Persist a batch including this record's current changes; coalesces concurrent callers. */
  append(
    record: RunRecord,
    options?: { readonly durable?: boolean; readonly context?: string },
  ): Promise<void>;
  /** Compact the snapshot after queued transitions finish. */
  compact(): Promise<void>;
  /** Allocate a private diagnostic directory; artifacts never participate in replay. */
  artifacts(stepId: string, attempt: number): Promise<string>;
  /** Register a native child under the same owner, before sending it task input. */
  trackProcess: RunLock['trackProcess'];
  /** Drain writes and release ownership. */
  release(): Promise<void>;
}

/** Storage seam for run orchestration; file implementations also expose lock-free readers. */
export interface RunStore {
  /** Absolute runs container when implementing the filesystem inbox/answer protocol. */
  readonly stateDir?: string;
  /** Acquire one local writer; never overwrite a live or uncertain owner. */
  open(runId: string, options?: RunStoreOpenOptions): Promise<OwnedRunStore>;
  /** Read latest committed state without acquiring a writer. */
  read(runId: string): Promise<RunRecord>;
  /** Enumerate stored identifiers. */
  list(): Promise<readonly string[]>;
}

/** Bounded, case-distinct diagnostic path component for an exact step ID. @internal */
export function artifactName(stepId: string): string {
  validateStepId(stepId);
  const hash = createHash('sha256').update(stepId).digest('hex');
  return `${encodeURIComponent(stepId).slice(0, 100)}--${hash}`;
}

/** Local POSIX file store with append-only journals and exclusive process ownership. */
export class FileRunStore implements RunStore {
  public constructor(public readonly stateDir: string) {
    this.stateDir = resolve(stateDir);
  }
  public read(runId: string): Promise<RunRecord> {
    return readRun({ stateDir: this.stateDir, runId });
  }
  /** Run ids in ascending code-unit (byte) order, whatever the filesystem's directory order. */
  public list(): Promise<string[]> {
    return listRunIds(this.stateDir);
  }
  public open(runId: string, options: RunStoreOpenOptions = {}): Promise<OwnedRunStore> {
    return openFileOwnedRun(this.stateDir, runId, options);
  }
}

/** An owned file run that can also give up its primary lock while it keeps the guard. @internal */
export interface ReleasableOwnedRun extends OwnedRunStore {
  /**
   * Drain queued writes, close the store and release only the primary lock (`OwnedRunLock`); a
   * later `release()` releases only the legacy guard.
   */
  releaseOwner(): Promise<void>;
}

/** `FileRunStore.open` with the primary-only release that `workflow rm` needs. @internal */
export async function openFileOwnedRun(
  stateDir: string,
  runId: string,
  options: RunStoreOpenOptions = {},
): Promise<ReleasableOwnedRun> {
  const root = resolve(stateDir);
  const lock = await lockRun(root, runId, options);
  const writer = new JournalWriter(root, runId);
  return new FileOwnedRun(root, runId, lock, writer);
}

class FileOwnedRun implements ReleasableOwnedRun {
  #queue = Promise.resolve();
  #pending:
    { record: RunRecord; durable: boolean; context: string; promise: Promise<void> } | undefined;
  #closed = false;
  #migration: boolean | undefined;
  public constructor(
    private readonly stateDir: string,
    private readonly runId: string,
    private readonly lock: OwnedRunLock,
    private readonly writer: JournalWriter,
  ) {}
  public readonly trackProcess: RunLock['trackProcess'] = (invocation, child) =>
    this.#closed
      ? Promise.reject(new Error('Run storage is closed.'))
      : this.lock.trackProcess(invocation, child);
  public async read(): Promise<RunRecord | undefined> {
    let record: RunRecord;
    try {
      record = await readRun({ stateDir: this.stateDir, runId: this.runId });
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
        existsSync(legacyRunPath(this.stateDir, this.runId)) ||
        existsSync(join(runDirectory(this.stateDir, this.runId), 'run.json'))
      )
        throw error;
      // A journal can exist with no run.json only before the first snapshot is published, so an
      // empty or torn (never newline-terminated) journal is an uninitialized run, not corruption.
      const journal = await readFile(
        join(runDirectory(this.stateDir, this.runId), 'journal.jsonl'),
        'utf8',
      ).catch((journalError: unknown) => {
        if (
          journalError instanceof Error &&
          'code' in journalError &&
          journalError.code === 'ENOENT'
        )
          return '';
        throw journalError;
      });
      if (journal.includes('\n')) throw error;
      return undefined;
    }
    // Every owned writer reads first: refuse, before any append, a record this build would strip.
    refuseRecordSchemaDrift(record);
    return record;
  }
  public append(
    record: RunRecord,
    options: { readonly durable?: boolean; readonly context?: string } = {},
  ): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Run storage is closed.'));
    if (record.id !== this.runId || record.formatVersion !== 7)
      return Promise.reject(new Error('Owned storage requires its own format-7 run.'));
    if (this.#pending) {
      this.#pending.record = record;
      this.#pending.durable ||= options.durable ?? true;
      return this.#pending.promise;
    }
    const batch = {
      record,
      durable: options.durable ?? true,
      context: options.context ?? `Could not save run ${this.runId}`,
      promise: Promise.resolve(),
    };
    const promise = this.#queue
      .catch(() => undefined)
      .then(async () => {
        await setImmediate();
        this.#pending = undefined;
        if (this.#migration === undefined)
          this.#migration = await prepareStorageMigration(this.stateDir, this.runId, batch.record);
        const snapshot = structuredClone(batch.record);
        await writeCheckpoint(this.stateDir, this.runId, () => snapshot, batch.context, {
          writer: this.writer,
          durable: batch.durable,
        });
        if (this.#migration) {
          await finishStorageMigration(this.stateDir, snapshot);
          this.#migration = false;
        }
        if (snapshot.seq !== undefined) batch.record.seq = snapshot.seq;
      });
    batch.promise = promise;
    this.#pending = batch;
    this.#queue = promise;
    return promise;
  }
  public compact(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Run storage is closed.'));
    const compact = this.#queue.then(() => this.writer.compact());
    this.#queue = compact;
    return compact;
  }
  public async transcript(
    stepId: string,
    attempt: number,
    harness: string,
    maxBytes: number,
  ): Promise<AgentTranscriptWriter> {
    if (this.#closed) throw new Error('Run storage is closed.');
    validateStepId(stepId);
    if (!Number.isSafeInteger(attempt) || attempt < 1)
      throw new Error('Transcript attempt must be a positive safe integer.');
    return AttemptTranscript.create(
      runDirectory(this.stateDir, this.runId),
      stepId,
      attempt,
      harness,
      maxBytes,
    );
  }
  public async artifacts(stepId: string, attempt: number): Promise<string> {
    if (this.#closed) throw new Error('Run storage is closed.');
    if (!Number.isSafeInteger(attempt) || attempt < 1)
      throw new Error('Artifact attempt must be a positive safe integer.');
    const path = join(
      runDirectory(this.stateDir, this.runId),
      'artifacts',
      artifactName(stepId),
      String(attempt),
    );
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }
  public async releaseOwner(): Promise<void> {
    this.#closed = true;
    await this.#queue.catch(() => undefined);
    await this.lock.releaseOwner();
  }
  public async release(): Promise<void> {
    this.#closed = true;
    await this.#queue.catch(() => undefined);
    await this.lock();
  }
}
