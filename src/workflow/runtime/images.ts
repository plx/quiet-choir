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
 * @internal
 */
export async function snapshotImages(
  paths: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<ImageAttachment[]> {
  signal?.throwIfAborted();
  return Promise.all(
    paths.map(async (path) => {
      const bytes = await readImage(resolve(cwd, path), signal);
      return {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        base64: bytes.toString('base64'),
      };
    }),
  );
}
