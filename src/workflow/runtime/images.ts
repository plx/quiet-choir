import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ImageAttachment } from './model.js';

/** Capture exactly the bytes fingerprinted; adapters must not reopen mutable source images. @internal */
export async function snapshotImages(
  paths: readonly string[],
  cwd: string,
): Promise<ImageAttachment[]> {
  return Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(resolve(cwd, path));
      return {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        base64: bytes.toString('base64'),
      };
    }),
  );
}
