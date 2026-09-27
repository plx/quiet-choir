import { existsSync, readFileSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonValue } from './json.js';
import type { JsonValue } from './model.js';
import { runDirectory } from './paths.js';
import {
  parseRunRecord,
  validateRunRecord,
  validateRecordChange,
  type RunRecord,
} from './record.js';
import { atomicStorageWrite, syncDirectory } from './storage-io.js';

/** A changed field, effect, or settled map; absent value removes an optional field. @internal */
export interface JournalChange {
  readonly area: 'run' | 'steps' | 'maps';
  readonly key: string;
  readonly value?: JsonValue;
}
/** One atomic logical transition in the append-only storage journal. @internal */
export interface JournalEntry {
  readonly seq: number;
  readonly at: string;
  readonly changes: readonly JournalChange[];
}
const envelope = z.strictObject({
  seq: z.number().int().positive(),
  at: z.iso.datetime(),
  changes: z.array(
    z.strictObject({
      area: z.enum(['run', 'steps', 'maps']),
      key: z.string(),
      value: z.unknown().optional(),
    }),
  ),
});
const immutableFields = new Set(['seq', 'formatVersion', 'id', 'steps', 'maps']);

/** Validate only new journal data, never all previous effect outputs on every write. @internal */
export function parseJournalEntry(value: unknown): JournalEntry {
  const entry = envelope.parse(jsonValue(value));
  const seen = new Set<string>();
  for (const change of entry.changes) {
    const key = JSON.stringify([change.area, change.key]);
    if (seen.has(key)) throw new Error('Duplicate field in storage journal entry.');
    seen.add(key);
    validateRecordChange(change.area, change.key, change.value);
  }
  return entry as JournalEntry;
}

function apply(record: RunRecord, entry: JournalEntry): void {
  for (const change of entry.changes) {
    const target =
      change.area === 'run'
        ? record
        : change.area === 'steps'
          ? record.steps
          : (record.maps ??= {});
    if (change.value === undefined) Reflect.deleteProperty(target, change.key);
    else
      Object.defineProperty(target, change.key, {
        value: change.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  record.seq = entry.seq;
}

/** Ignore only an incomplete final line; reject corruption and gaps in committed lines. @internal */
export function replayJournal(snapshot: string, journal: string, runId: string): RunRecord {
  const record = parseRunRecord(snapshot, runId);
  if (record.formatVersion !== 7)
    throw new Error('Directory checkpoints require storage format 7.');
  const floor = record.seq ?? 0;
  let seq = floor;
  const complete = journal.slice(0, journal.lastIndexOf('\n') + 1);
  for (const line of complete.split('\n')) {
    if (!line) continue;
    const entry = parseJournalEntry(JSON.parse(line));
    if (entry.seq <= floor) continue;
    if (entry.seq !== seq + 1)
      throw new Error(`Storage journal sequence gap after ${String(seq)}.`);
    apply(record, entry);
    seq = entry.seq;
  }
  validateRunRecord(record);
  return record;
}

function snapshotSeq(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value !== null && typeof value === 'object' && 'seq' in value ? value.seq : undefined;
}

/** Lock-free reader retries compaction races using the durable snapshot sequence. @internal */
export async function readJournalRun(stateDir: string, runId: string): Promise<RunRecord> {
  const directory = runDirectory(stateDir, runId);
  const path = join(directory, 'run.json');
  for (let retry = 0; retry < 10; retry++) {
    const first = await readFile(path, 'utf8');
    const journal = await readFile(join(directory, 'journal.jsonl'), 'utf8');
    const second = await readFile(path, 'utf8');
    if (snapshotSeq(first) !== snapshotSeq(second)) continue;
    return replayJournal(first, journal, runId);
  }
  throw new Error(`Run ${runId} is compacting repeatedly; retry inspection.`);
}

/** Synchronous equivalent for the CLI's final forced-interruption report. @internal */
export function readJournalRunSync(stateDir: string, runId: string): RunRecord {
  const directory = runDirectory(stateDir, runId);
  const path = join(directory, 'run.json');
  for (let retry = 0; retry < 10; retry++) {
    const first = readFileSync(path, 'utf8');
    const journal = readFileSync(join(directory, 'journal.jsonl'), 'utf8');
    const second = readFileSync(path, 'utf8');
    if (snapshotSeq(first) !== snapshotSeq(second)) continue;
    return replayJournal(first, journal, runId);
  }
  throw new Error(`Run ${runId} is compacting repeatedly; retry inspection.`);
}

function difference(before: RunRecord, after: RunRecord): JournalChange[] {
  const changes: JournalChange[] = [];
  function fields(area: JournalChange['area'], previous: object, next: object): void {
    const oldFields = previous as Record<string, unknown>;
    const newFields = next as Record<string, unknown>;
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (area === 'run' && immutableFields.has(key)) continue;
      const prior = Object.hasOwn(oldFields, key) ? oldFields[key] : undefined;
      const value = Object.hasOwn(newFields, key) ? newFields[key] : undefined;
      if (!isDeepStrictEqual(prior, value))
        changes.push({ area, key, ...(value === undefined ? {} : { value: jsonValue(value) }) });
    }
  }
  fields('run', before, after);
  fields('steps', before.steps, after.steps);
  fields('maps', before.maps ?? {}, after.maps ?? {});
  return changes;
}

/** Owned journal appender. The caller serializes batches and holds the run lock. @internal */
export class JournalWriter {
  #previous: RunRecord | undefined;
  #bytes = 0;
  #prepared = false;
  public constructor(
    private readonly stateDir: string,
    private readonly runId: string,
    private readonly threshold = 4 * 1024 * 1024,
  ) {}

  /** Repair a torn tail only after acquiring ownership; committed corruption remains fatal. */
  private async prepare(): Promise<void> {
    if (this.#prepared) return;
    const directory = runDirectory(this.stateDir, this.runId);
    try {
      this.#previous = await readJournalRun(this.stateDir, this.runId);
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
        existsSync(join(directory, 'run.json'))
      )
        throw error;
    }
    await using file = await open(join(directory, 'journal.jsonl'), 'a+', 0o600);
    const bytes = await file.readFile();
    const validLength = bytes.lastIndexOf(10) + 1;
    if (validLength !== bytes.length) {
      await file.truncate(validLength);
      await file.sync();
    }
    this.#bytes = validLength;
    await syncDirectory(directory);
    await syncDirectory(this.stateDir);
    this.#prepared = true;
  }

  /** Append changed records and share the fsync for all transitions captured in this batch. */
  public async append(record: RunRecord, durable = true): Promise<void> {
    if (record.id !== this.runId || record.formatVersion !== 7)
      throw new Error('Journal writer requires its own format-7 run.');
    await this.prepare();
    const previous = this.#previous;
    if (!previous) {
      const initial = { ...record, seq: 0 };
      validateRunRecord(jsonValue(initial));
      await this.compact(initial);
      this.#previous = structuredClone(initial);
      return;
    }
    const entry = parseJournalEntry({
      seq: (previous.seq ?? 0) + 1,
      at: new Date().toISOString(),
      changes: difference(previous, record),
    });
    if (!entry.changes.length) return;
    const bytes = `${JSON.stringify(entry)}\n`;
    const path = join(runDirectory(this.stateDir, this.runId), 'journal.jsonl');
    await using file = await open(path, 'r+');
    // A failed append may have left some bytes. Retry the same transition, never an effect.
    await file.truncate(this.#bytes);
    const buffer = Buffer.from(bytes);
    let written = 0;
    while (written < buffer.length) {
      const result = await file.write(
        buffer,
        written,
        buffer.length - written,
        this.#bytes + written,
      );
      if (!result.bytesWritten) throw new Error('Storage journal write made no progress.');
      written += result.bytesWritten;
    }
    if (durable) await file.sync();
    this.#bytes += Buffer.byteLength(bytes);
    record.seq = entry.seq;
    this.#previous = { ...structuredClone(record), seq: entry.seq };
    if (record.status !== previous.status || this.#bytes >= this.threshold)
      await this.compact(this.#previous);
  }

  /** Persist the snapshot before removing covered journal entries. */
  public async compact(record = this.#previous): Promise<void> {
    if (!record) return;
    const directory = runDirectory(this.stateDir, this.runId);
    await atomicStorageWrite(join(directory, 'run.json'), `${JSON.stringify(jsonValue(record))}\n`);
    await using file = await open(join(directory, 'journal.jsonl'), 'r+');
    await file.truncate(0);
    this.#bytes = 0;
    await file.sync();
  }
}
