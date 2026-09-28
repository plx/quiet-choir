import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentTranscript, AgentTranscriptWriter } from './agent-stream-model.js';
import { syncDirectory } from './storage-io.js';

const marker = `${JSON.stringify({ type: 'truncated', reason: 'maxTranscriptBytes' })}\n`;

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
    provider: 'claude' | 'codex',
    cap = 64 * 1024 * 1024,
  ): Promise<AttemptTranscript> {
    if (!Number.isSafeInteger(cap) || cap < 128)
      throw new Error('maxTranscriptBytes must be a safe integer of at least 128.');
    const parent = join(runDirectory, 'attempts');
    const directory = join(parent, createHash('sha256').update(stepId).digest('hex'));
    await privateDirectory(parent);
    await privateDirectory(directory);
    await syncDirectory(runDirectory);
    await syncDirectory(parent);
    const path = join(directory, `${String(attempt)}.${provider}.jsonl`);
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.sync();
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
        await this.#file.sync();
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
