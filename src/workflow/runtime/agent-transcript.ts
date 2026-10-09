import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentTranscript, AgentTranscriptWriter } from './agent-stream-model.js';
import { syncDirectory, syncHandle } from './storage-io.js';

const marker = `${JSON.stringify({ type: 'truncated', reason: 'maxTranscriptBytes' })}\n`;
/** Longest transcript line {@link readAttemptTranscript} accepts by default, in bytes. */
const maxTranscriptLineBytes = 64 * 1024 * 1024;
/** Base64 alphabet with up to two trailing `=`: one flat class, so a long line cannot overflow. */
const base64Characters = /^[A-Za-z0-9+/]*={0,2}$/u;

/** Padded base64, checked without a repeated group (which backtracks per quantum). */
function isBase64(text: string): boolean {
  return text.length % 4 === 0 && base64Characters.test(text);
}

async function privateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Transcript directory is not a real directory: ${path}`);
  await chmod(path, 0o700);
}

/** The directory under a run's `attempts/` that holds a step's transcripts. @internal */
export function transcriptDirectoryName(stepId: string): string {
  return createHash('sha256').update(stepId).digest('hex');
}

/** Runtime-owned raw byte transcript, bounded independently of protocol parsing. @internal */
export class AttemptTranscript implements AgentTranscriptWriter {
  readonly #path: string;
  readonly #file: FileHandle;
  readonly #cap: number;
  #bytes = 0;
  #truncated = false;
  #retained = true;
  #pending: Promise<void> = Promise.resolve();
  #closed: Promise<void> | undefined;

  private constructor(path: string, file: FileHandle, cap: number) {
    this.#path = path;
    this.#file = file;
    this.#cap = cap;
  }

  public static async create(
    runDirectory: string,
    stepId: string,
    attempt: number,
    harness: string,
    cap = 64 * 1024 * 1024,
  ): Promise<AttemptTranscript> {
    if (!Number.isSafeInteger(cap) || cap < 128)
      throw new Error('maxTranscriptBytes must be a safe integer of at least 128.');
    const parent = join(runDirectory, 'attempts');
    const directory = join(parent, transcriptDirectoryName(stepId));
    await privateDirectory(parent);
    await privateDirectory(directory);
    await syncDirectory(runDirectory);
    await syncDirectory(parent);
    const path = join(directory, `${String(attempt)}.${harness}.jsonl`);
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await syncHandle(file);
      await syncDirectory(directory);
      return new AttemptTranscript(path, file, cap);
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  public snapshot(): AgentTranscript {
    return {
      path: this.#path,
      bytes: this.#bytes,
      truncated: this.#truncated,
      retained: this.#retained,
    };
  }

  public write(stream: 'stdout' | 'stderr', chunk: Uint8Array): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Transcript is already closed.'));
    const write = this.#pending.then(async () => {
      if (this.#truncated || chunk.length === 0) return;
      const available = this.#cap - this.#bytes - Buffer.byteLength(marker);
      const overhead = Buffer.byteLength(`${JSON.stringify({ stream, base64: '' })}\n`);
      const length = Math.min(
        chunk.length,
        Math.max(0, Math.floor((available - overhead) / 4) * 3),
      );
      if (length > 0) {
        const base64 = Buffer.from(chunk.buffer, chunk.byteOffset, length).toString('base64');
        const line = `${JSON.stringify({ stream, base64 })}\n`;
        await this.#file.writeFile(line);
        this.#bytes += Buffer.byteLength(line);
      }
      if (length < chunk.length) {
        await this.#file.writeFile(marker);
        this.#bytes += Buffer.byteLength(marker);
        this.#truncated = true;
      }
    });
    this.#pending = write;
    return write;
  }

  public close(): Promise<void> {
    this.#closed ??= (async () => {
      try {
        await this.#pending;
        await syncHandle(this.#file);
      } finally {
        await this.#file.close();
      }
    })();
    return this.#closed;
  }

  public async discard(): Promise<void> {
    await this.close();
    await rm(this.#path, { force: true });
    await syncDirectory(dirname(this.#path));
    this.#retained = false;
  }
}

/** What {@link readAttemptTranscript} decoded. @internal */
export interface TranscriptReadResult {
  /** Decoded bytes of the selected stream passed to the callback. */
  readonly bytes: number;
  /** Whether the transcript ends with the `maxTranscriptBytes` truncation marker. */
  readonly truncated: boolean;
}

/**
 * Decode one stream of an {@link AttemptTranscript} file, in order, passing each entry's raw bytes
 * to `onChunk` (awaited, so a slow writer applies backpressure). Bytes are not re-encoded, so a
 * UTF-8 character split across two chunks arrives intact. The file is opened without following a
 * symlink and read line by line; a line longer than `maxLineBytes`, an entry that is neither
 * `{stream, base64}` nor the final truncation marker, or anything after that marker throws an
 * Error naming the line. @internal
 */
export async function readAttemptTranscript(
  path: string,
  stream: 'stdout' | 'stderr',
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  maxLineBytes = maxTranscriptLineBytes,
): Promise<TranscriptReadResult> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes = 0;
  let truncated = false;
  let lineNumber = 0;
  const consume = async (line: Buffer): Promise<void> => {
    lineNumber++;
    const where = `Transcript line ${String(lineNumber)} of ${path}`;
    if (truncated) throw new Error(`${where} follows the truncation marker.`);
    let entry: unknown;
    try {
      entry = JSON.parse(line.toString('utf8'));
    } catch {
      throw new Error(`${where} is not valid JSON.`);
    }
    const fields =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : undefined;
    const keys = fields === undefined ? [] : Object.keys(fields).sort().join(',');
    if (
      keys === 'base64,stream' &&
      (fields?.['stream'] === 'stdout' || fields?.['stream'] === 'stderr') &&
      typeof fields['base64'] === 'string' &&
      isBase64(fields['base64'])
    ) {
      if (fields['stream'] !== stream) return;
      const chunk = Buffer.from(fields['base64'], 'base64');
      bytes += chunk.length;
      if (chunk.length > 0) await onChunk(chunk);
      return;
    }
    if (
      keys === 'reason,type' &&
      fields?.['type'] === 'truncated' &&
      fields['reason'] === 'maxTranscriptBytes'
    ) {
      truncated = true;
      return;
    }
    throw new Error(`${where} is not a transcript entry.`);
  };
  try {
    if (!(await file.stat()).isFile()) throw new Error(`Transcript is not a regular file: ${path}`);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    for await (const data of file.createReadStream({ autoClose: false, start: 0 })) {
      let chunk = data as Buffer;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10)) {
        if (pendingBytes + end > maxLineBytes)
          throw new Error(
            `Transcript line ${String(lineNumber + 1)} of ${path} is longer than ${String(maxLineBytes)} bytes.`,
          );
        pending.push(chunk.subarray(0, end));
        await consume(Buffer.concat(pending));
        pending = [];
        pendingBytes = 0;
        chunk = chunk.subarray(end + 1);
      }
      pendingBytes += chunk.length;
      if (pendingBytes > maxLineBytes)
        throw new Error(
          `Transcript line ${String(lineNumber + 1)} of ${path} is longer than ${String(maxLineBytes)} bytes.`,
        );
      if (chunk.length > 0) pending.push(chunk);
    }
    // A final line without a newline is still an entry; a torn one fails as malformed.
    if (pendingBytes > 0) await consume(Buffer.concat(pending));
    return { bytes, truncated };
  } finally {
    await file.close();
  }
}
