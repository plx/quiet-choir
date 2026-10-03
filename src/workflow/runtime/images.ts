import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ImageAttachment } from './model.js';

// Opening a FIFO without a writer would otherwise block before the abort signal is observable.
// Windows defines no O_NONBLOCK; its opens do not block on special files in the same way.
const flags = constants.O_RDONLY | ((constants.O_NONBLOCK as number | undefined) ?? 0);

const ignore = (): undefined => undefined;

/**
 * Settle with `op`, or reject with the abort reason as soon as `signal` aborts. An abandoned
 * operation keeps running in the background: `onAbandon` receives it for cleanup, and a late
 * rejection is swallowed.
 */
function abortable<T>(
  op: Promise<T>,
  signal: AbortSignal,
  onAbandon: (late: Promise<T>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      void op.catch(ignore);
      onAbandon(op);
      reject(signal.reason as Error);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void op.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

/**
 * Read one regular file. Cancellation bounds every phase (open, stat, and the chunked read): a
 * syscall stuck on a stalled mount is abandoned, and its handle is closed if it ever returns.
 */
async function readImage(path: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const handle = await abortable(open(path, flags), signal, (late) => {
    void late.then((value) => value.close()).catch(ignore);
  });
  // FileHandle.close waits for pending operations, so an abandoned one must not block the caller.
  const pending = { abandoned: false };
  const bounded = <T>(op: Promise<T>) =>
    abortable(op, signal, () => {
      pending.abandoned = true;
    });
  try {
    if (!(await bounded(handle.stat())).isFile())
      throw new Error(`image source is not a regular file: ${path}`);
    signal.throwIfAborted();
    return await bounded(readFile(handle, { signal }));
  } finally {
    if (pending.abandoned) void handle.close().catch(ignore);
    else await handle.close();
  }
}

/**
 * Capture exactly the bytes fingerprinted; adapters must not reopen mutable source images.
 * Non-regular sources (FIFOs, devices, directories) are rejected, and `signal` bounds the whole
 * snapshot. One failed read cancels its siblings, and every read settles before the snapshot
 * rejects with that first failure. An open, stat, or read still in flight when the signal aborts
 * is abandoned rather than awaited, so a syscall stuck on a stalled mount cannot hold the
 * snapshot; its handle is closed in the background once the operation returns.
 */
export async function snapshotImages(
  paths: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<ImageAttachment[]> {
  signal?.throwIfAborted();
  const siblings = new AbortController();
  const linked =
    signal === undefined ? siblings.signal : AbortSignal.any([signal, siblings.signal]);
  let failure: { readonly error: unknown } | undefined;
  const results = await Promise.allSettled(
    paths.map(async (path) => {
      try {
        const bytes = await readImage(resolve(cwd, path), linked);
        return {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          base64: bytes.toString('base64'),
        };
      } catch (error) {
        // Only a failure seen before any abort is real; later rejections are the siblings stopping.
        if (!linked.aborted) {
          failure = { error };
          siblings.abort(error);
        }
        throw error;
      }
    }),
  );
  const attachments: ImageAttachment[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      attachments.push(result.value);
      continue;
    }
    // Caller cancellation keeps its own reason so the runner reports it as cancellation.
    signal?.throwIfAborted();
    throw failure === undefined ? result.reason : failure.error;
  }
  return attachments;
}
