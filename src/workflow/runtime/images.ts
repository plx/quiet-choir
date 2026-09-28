import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ImageAttachment } from './model.js';

// Opening a FIFO without a writer would otherwise block before the abort signal is observable.
// Windows defines no O_NONBLOCK; its opens do not block on special files in the same way.
const flags = constants.O_RDONLY | ((constants.O_NONBLOCK as number | undefined) ?? 0);

/** Read one regular file, observing `signal` between chunks. */
async function readImage(path: string, signal: AbortSignal | undefined): Promise<Buffer> {
  signal?.throwIfAborted();
  const handle = await open(path, flags);
  try {
    if (!(await handle.stat()).isFile())
      throw new Error(`image source is not a regular file: ${path}`);
    signal?.throwIfAborted();
    return await readFile(handle, signal === undefined ? {} : { signal });
  } finally {
    await handle.close();
  }
}

/**
 * Capture exactly the bytes fingerprinted; adapters must not reopen mutable source images.
 * Non-regular sources (FIFOs, devices, directories) are rejected, and `signal` cancels the read.
 * One failed read cancels its siblings, and every read settles (closing its handle) before the
 * snapshot rejects with that first failure.
 * @internal
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
