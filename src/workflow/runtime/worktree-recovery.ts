import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorktreeLedger } from './worktree-schema.js';
import { replaceFile, snapshotFile } from './files.js';

async function regularText(path: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    return (await snapshotFile(path, 4096, signal)).content;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
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
      throw new Error('Interrupted worktree cache escaped its run directory.');
    const pointer = await regularText(join(cache.path, '.git'), signal);
    if (pointer === undefined) continue; // Git had not linked this checkout yet.
    const match = /^gitdir: (.+)\n?$/u.exec(pointer);
    if (!match?.[1]) throw new Error('Interrupted worktree has an invalid Git pointer.');
    const metadata = resolve(cache.path, match[1]);
    const info = await lstat(metadata);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      dirname(metadata) !== join(common, 'worktrees') ||
      (await realpath(metadata)) !== metadata
    )
      throw new Error('Interrupted worktree metadata escaped its recorded repository.');
    const backlink = await regularText(join(metadata, 'gitdir'), signal);
    if (backlink?.trimEnd() !== join(cache.path, '.git'))
      throw new Error('Interrupted worktree registration has a different checkout owner.');
    const path = join(metadata, 'commondir');
    const content = await regularText(path, signal);
    // An empty commondir makes even unrelated `git worktree add` calls fail. Git repair
    // cannot read it either. Both exact links above prove this planned registration's owner.
    if (content !== '') continue;
    const expected = await snapshotFile(path, 4096, signal);
    if (expected.content !== '') throw new Error('Interrupted worktree registration changed.');
    await replaceFile(path, '../..\n', { ifMatch: expected.sha256 }, signal);
    repaired.push(cache.path);
  }
  return repaired;
}
