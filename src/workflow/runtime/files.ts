import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { syncDirectory, syncHandle } from './storage-io.js';
import type { ReadFileResult, WriteFileOptions, WriteFileResult } from './file-model.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
/** @internal */
export const readFileOptionsSchema = z.strictObject({
  maxBytes: z.number().int().positive().max(2_147_483_647).optional(),
  allowOutsideCwd: z.boolean().optional(),
  onError: z.enum(['throw', 'return']).optional(),
});
/** @internal */
export const writeFileOptionsSchema = z.strictObject({
  ifMatch: sha256.nullable().optional(),
  allowOutsideCwd: z.boolean().optional(),
  onError: z.enum(['throw', 'return']).optional(),
});
/** @internal */
export const readFileResultSchema = z.object({ content: z.string(), sha256 });
/** @internal */
export const writeFileResultSchema = z.object({
  path: z.string(),
  sha256,
  bytes: z.number().int().nonnegative(),
  previousSha256: sha256.nullable(),
});
/** @internal */
export function fileDigest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function contained(cwd: string, path: string): boolean {
  const rel = relative(cwd, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
/** Resolve existing symlinks, including parents of targets which do not exist yet. @internal */
export async function filePath(
  cwd: string,
  path: string,
  allowOutsideCwd = false,
): Promise<string> {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0'))
    throw new Error('File path must be a nonempty string without NUL.');
  const lexical = resolve(cwd, path);
  if (!allowOutsideCwd && !contained(cwd, lexical))
    throw new Error('File path escapes cwd; allowOutsideCwd is required.');
  async function canonical(target: string): Promise<string> {
    try {
      return await realpath(target);
    } catch (error) {
      if (!missing(error)) throw error;
      // A dangling symlink is not a missing regular file and must not be replaced implicitly.
      const info = await lstat(target).catch((cause: unknown) => {
        if (!missing(cause)) throw cause;
        return null;
      });
      if (info?.isSymbolicLink())
        throw new Error('Dangling file symlinks are unsupported.', { cause: error });
      const parent = dirname(target);
      if (parent === target) throw error;
      return resolve(await canonical(parent), basename(target));
    }
  }
  const resolved = await canonical(lexical);
  if (!allowOutsideCwd && !contained(cwd, resolved))
    throw new Error('File symlink target escapes cwd; allowOutsideCwd is required.');
  return resolved;
}
async function regular(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('File effects require a regular file.');
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
/** Bounded actual read, independent of a potentially stale stat size. @internal */
export async function snapshotFile(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ReadFileResult> {
  const { handle, info } = await regular(path);
  try {
    if (info.size > maxBytes)
      throw new Error(`File exceeds its ${String(maxBytes)}-byte snapshot limit.`);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytes));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maxBytes)
        throw new Error(`File exceeds its ${String(maxBytes)}-byte snapshot limit.`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const content = Buffer.concat(chunks);
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new Error('File is not valid UTF-8; use a local callback for binary content.', {
        cause: error,
      });
    }
    return { content: decoded, sha256: fileDigest(content) };
  } finally {
    await handle.close();
  }
}
async function currentFile(
  path: string,
  signal: AbortSignal,
): Promise<{ sha256: string; mode: number } | null> {
  const opened = await regular(path).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return null;
  });
  if (!opened) return null;
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await opened.handle.read(buffer);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { sha256: hash.digest('hex'), mode: opened.info.mode & 0o777 };
  } finally {
    await opened.handle.close();
  }
}
async function parents(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent === path) return;
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(parent);
  } catch (error) {
    if (missing(error)) {
      await parents(parent);
      await parents(path);
    } else if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}
/** Atomic publication with an optimistic baseline check; not a lock against external writers. @internal */
export async function replaceFile(
  path: string,
  content: string,
  options: WriteFileOptions,
  signal: AbortSignal,
): Promise<WriteFileResult> {
  const bytes = Buffer.from(content);
  const sha256 = fileDigest(bytes);
  const before = await currentFile(path, signal);
  const receipt = { path, sha256, bytes: bytes.length, previousSha256: before?.sha256 ?? null };
  if (before?.sha256 === sha256) return receipt;
  const match = (): void => {
    if (options.ifMatch !== undefined && options.ifMatch !== (before?.sha256 ?? null))
      throw new Error('File ifMatch failed: current content does not match the expected baseline.');
  };
  match();
  await parents(dirname(path));
  const temporary = resolve(dirname(path), `.quiet-choir-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', before?.mode ?? 0o600);
    try {
      if (before) await handle.chmod(before.mode);
      await handle.writeFile(bytes);
      await syncHandle(handle);
    } finally {
      await handle.close();
    }
    signal.throwIfAborted();
    if (options.ifMatch !== undefined) {
      const current = await currentFile(path, signal);
      if (current?.sha256 === sha256) return { ...receipt, previousSha256: current.sha256 };
      if ((current?.sha256 ?? null) !== options.ifMatch)
        throw new Error('File ifMatch failed before publication: baseline changed.');
    }
    if (options.ifMatch === null) await link(temporary, path);
    else await rename(temporary, path);
    await syncDirectory(dirname(path));
    return receipt;
  } finally {
    await rm(temporary, { force: true });
  }
}
