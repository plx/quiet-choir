import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorktreeLedger } from './worktree-schema.js';
import { ConfigurationError } from './configuration-error.js';
import type { ReadFileResult } from './file-model.js';
import { replaceFile, snapshotFile } from './files.js';

// `.git`, `gitdir` and `commondir` are all small control files Git itself writes atomically.
// A missing file is a normal race with Git's own writer (never linked yet); a non-regular file
// (symlink, directory, FIFO, …) or a validation failure inside `snapshotFile` (over the byte
// limit, not valid UTF-8) means something other than Git wrote it and is registration corruption,
// not a filesystem crash. Cancellation and infrastructure failures (EACCES, EIO, EMFILE, …) are
// reported as-is so they are never retried or journaled as workflow data.
async function registrationFile(
  path: string,
  signal: AbortSignal,
): Promise<ReadFileResult | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (info === null) return undefined;
  if (!info.isFile())
    throw new ConfigurationError('Interrupted worktree registration file is malformed.');
  try {
    return await snapshotFile(path, 4096, signal);
  } catch (error) {
    if (signal.aborted || (error instanceof Error && 'code' in error)) throw error;
    throw new ConfigurationError('Interrupted worktree registration file is malformed.', {
      cause: error,
    });
  }
}

async function regularText(path: string, signal: AbortSignal): Promise<string | undefined> {
  return (await registrationFile(path, signal))?.content;
}

/** Publish a repaired control file, keeping a mid-flight change a configuration failure too. */
async function replaceRegistrationFile(
  path: string,
  content: string,
  expected: ReadFileResult,
  signal: AbortSignal,
): Promise<void> {
  try {
    await replaceFile(path, content, { ifMatch: expected.sha256 }, signal);
  } catch (error) {
    if (signal.aborted || (error instanceof Error && 'code' in error)) throw error;
    throw new ConfigurationError('Interrupted worktree registration changed.', { cause: error });
  }
}

// A removed or only partially created metadata directory is validation, not a filesystem crash:
// surface it the same way as every other pre-launch registration check.
const missingMetadataCodes = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

async function metadataLstat(path: string): ReturnType<typeof lstat> {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && missingMetadataCodes.has(error.code as string))
      throw new ConfigurationError('Interrupted worktree metadata is missing.', { cause: error });
    throw error;
  }
}

async function metadataRealpath(path: string): ReturnType<typeof realpath> {
  try {
    return await realpath(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && missingMetadataCodes.has(error.code as string))
      throw new ConfigurationError('Interrupted worktree metadata is missing.', { cause: error });
    throw error;
  }
}

/** Reconcile one narrow Git add interruption, only after prior process ownership is recovered. @internal */
export async function repairWorktreeRegistrations(
  ledger: WorktreeLedger,
  runId: string,
  common: string,
  signal: AbortSignal,
): Promise<string[]> {
  const repaired: string[] = [];
  const ownedRoot = join(ledger.root, `${runId}-${ledger.namespace}`);
  for (const cache of Object.values(ledger.caches)) {
    if (cache.state !== 'planned') continue;
    const part = relative(ownedRoot, cache.path);
    if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`))
      throw new ConfigurationError('Interrupted worktree cache escaped its run directory.');
    const pointer = await regularText(join(cache.path, '.git'), signal);
    if (pointer === undefined) continue; // Git had not linked this checkout yet.
    const match = /^gitdir: (.+)\n?$/u.exec(pointer);
    if (!match?.[1])
      throw new ConfigurationError('Interrupted worktree has an invalid Git pointer.');
    const metadata = resolve(cache.path, match[1]);
    const info = await metadataLstat(metadata);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      dirname(metadata) !== join(common, 'worktrees') ||
      (await metadataRealpath(metadata)) !== metadata
    )
      throw new ConfigurationError(
        'Interrupted worktree metadata escaped its recorded repository.',
      );
    const backlink = await regularText(join(metadata, 'gitdir'), signal);
    if (backlink?.trimEnd() !== join(cache.path, '.git'))
      throw new ConfigurationError(
        'Interrupted worktree registration has a different checkout owner.',
      );
    const path = join(metadata, 'commondir');
    const content = await regularText(path, signal);
    // Both exact links above prove this planned registration's owner; only its commondir is
    // still unverified. Git itself only ever leaves it at the expected value or, if interrupted
    // mid-write, empty (which makes even unrelated `git worktree add` calls fail, and which Git's
    // own repair cannot read either) — that empty case alone is repaired. Anything else, missing
    // or corrupt, is registration data this recovery cannot trust.
    if (content?.trimEnd() === '../..') continue;
    if (content !== '')
      throw new ConfigurationError('Interrupted worktree registration has an invalid commondir.');
    const expected = await registrationFile(path, signal);
    if (expected?.content !== '')
      throw new ConfigurationError('Interrupted worktree registration changed.');
    await replaceRegistrationFile(path, '../..\n', expected, signal);
    repaired.push(cache.path);
  }
  return repaired;
}
