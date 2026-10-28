// Git facts as durable commands: the clean-checkout check, the pinned commit, the files and the
// manifest lines that name the package, and the files an integrated tree changed.
import type { WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha } from '../contracts.js';

// Listings are complete or fail (std.exec.git refuses truncated output), so allow large ones.
const listing = { maxOutputBytes: 16 * 1024 * 1024 };

/** Fail unless the checkout has no tracked or untracked change: publication needs a clean tree. */
export async function assertClean(ctx: WorkflowContext, id: string) {
  const status = await std.exec.git(ctx, id, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') throw new Error(`Expected a clean repository (${id}): ${status}`);
}

/** The commit the checkout's HEAD names now. */
export const headCommit = async (ctx: WorkflowContext, id: string) =>
  Sha.parse((await std.exec.git(ctx, id, ['rev-parse', 'HEAD'])).trim());

/** `git grep` of a fixed string over `commit`; it exits 1 when nothing matches. */
const grep = (ctx: WorkflowContext, id: string, args: string[]) =>
  std.exec.git(ctx, id, ['grep', '-I', '-F', '--full-name', ...args], {
    ...listing,
    okExitCodes: [0, 1],
  });

/** The tracked text files at `commit` that contain `name`, repository-relative. */
export async function mentions(ctx: WorkflowContext, id: string, commit: string, name: string) {
  const out = await grep(ctx, id, ['-l', '-z', '-e', name, commit, '--', ':(top)']);
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => line.slice(`${commit}:`.length));
}

/** The lines of `files` at `commit` that contain `name`, each with the two lines after it. */
export async function evidence(
  ctx: WorkflowContext,
  id: string,
  commit: string,
  name: string,
  files: string[],
) {
  const pathspecs = files.map((file) => `:(top,literal)${file}`);
  const out = await grep(ctx, id, ['-n', '-A', '2', '-e', name, commit, '--', ...pathspecs]);
  return out
    .split('\n')
    .filter((line) => line !== '' && line !== '--')
    .map((line) => (line.startsWith(`${commit}:`) ? line.slice(`${commit}:`.length) : line));
}

/** The files `head` changes relative to `base`, with Git's status letter. */
export async function changedFiles(ctx: WorkflowContext, id: string, base: string, head: string) {
  const out = await std.exec.git(ctx, id, [
    'diff',
    '--name-status',
    '-z',
    '--no-renames',
    base,
    head,
  ]);
  const parts = out.split('\0').filter(Boolean);
  const files: { path: string; status: string }[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2)
    files.push({ status: parts[index] ?? '', path: parts[index + 1] ?? '' });
  return files;
}
