import { randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

let storageSync = true;

/**
 * Turn runtime fsyncs on or off for the current module instance and return the previous setting.
 * The in-process unit suite disables them for speed; production always syncs. Nothing outside
 * the test setup imports this, and a test enforces that.
 * @internal test-only; never reachable from the CLI or public API
 */
export function setStorageSyncForTesting(enabled: boolean): boolean {
  const previous = storageSync;
  storageSync = enabled;
  return previous;
}

/** Flush an open file's content to stable storage. The only in-process call site of `sync()`. @internal */
export async function syncHandle(handle: FileHandle): Promise<void> {
  if (!storageSync) return;
  await handle.sync();
}

/** Flush a directory entry on the supported local POSIX filesystems. @internal */
export async function syncDirectory(path: string): Promise<void> {
  await using directory = await open(path, 'r');
  await syncHandle(directory);
}

/** Replace a file only after its bytes are durable, then flush its parent entry. @internal */
export async function atomicStorageWrite(path: string, bytes: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await using file = await open(temporary, 'wx', 0o600);
    await file.writeFile(bytes);
    await syncHandle(file);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Create private directories and flush each newly created parent entry. @internal */
export async function createStorageDirectory(path: string): Promise<void> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      await stat(current);
      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  for (const directory of missing.reverse()) await syncDirectory(dirname(directory));
}
