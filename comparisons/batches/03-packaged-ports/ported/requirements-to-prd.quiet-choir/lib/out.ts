// The PRD's destination as durable effects: code checks out before any agent runs, so an existing
// PRD, or a dirty checkout a commit cannot merge into, is refused rather than discovered at the
// write after every call was paid for; then it writes or commits the rendered document against the
// baseline it checked.
import type { WorkflowContext, WriteFileResult } from 'quiet-choir';
import * as std from 'quiet-choir/std';

/** Where out stands: the baseline the write must match, or why the run must not start. */
export type Target = { readonly ifMatch: string | null } | { readonly refusal: string };

/**
 * Read out once. A missing file is created; an existing one is replaced only when `replace` names
 * its current sha256 and the publication is a file, since a managed commit only creates. Settled
 * file failures carry no "missing" kind, so this reads the errno code Node puts first in the
 * message; any other failure (a directory, an oversized file) means something is there. A managed
 * commit merges into the checkout, which refuses any change Git reports, untracked files included,
 * so that is checked here too rather than after every agent call was paid for.
 */
export async function checkOut(
  ctx: WorkflowContext,
  out: string,
  replace: string | null,
  publication: 'file' | 'commit',
): Promise<Target> {
  const existing = await ctx.readFile('existing', out, { onError: 'return' });
  const missing = !existing.ok && /^ENOENT\b/u.test(existing.error.message);
  if (!existing.ok && !missing)
    return {
      refusal: `Not run: ${out} exists but is not a readable PRD (${existing.error.message}).`,
    };
  if (existing.ok) {
    const { sha256 } = existing.value;
    if (publication === 'commit')
      return {
        refusal: `Not run: ${out} exists (sha256 ${sha256}), and a managed commit only creates; use publication 'file' with replace to redo it.`,
      };
    if (replace === null)
      return {
        refusal: `Not run: ${out} exists (sha256 ${sha256}); pass that digest as replace to redo it.`,
      };
    if (replace !== sha256)
      return {
        refusal: `Not run: ${out} has sha256 ${sha256}, not the replace digest ${replace}; it changed since.`,
      };
    return { ifMatch: sha256 };
  }
  if (publication === 'commit') {
    const dirty = await dirtyPaths(ctx);
    if (dirty.length)
      return {
        refusal: `Not run: publication 'commit' merges into a clean checkout, and Git reports ${listed(dirty)}; commit or stash them (with --include-untracked), or use publication 'file'.`,
      };
  }
  return { ifMatch: null };
}

/** The paths the publish merge's own check would report: changed, staged or untracked. */
async function dirtyPaths(ctx: WorkflowContext): Promise<string[]> {
  const status = await std.exec.git(ctx, 'clean-checkout', [
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--no-renames',
  ]);
  return status
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
}

const listed = (paths: readonly string[]) =>
  paths.length > 5
    ? `${paths.slice(0, 5).join(', ')} and ${String(paths.length - 5)} more`
    : paths.join(', ');

/**
 * Publish the document at out: a file written against the checked baseline (exclusive creation
 * when out was missing), or a managed commit that later stages can build on. A file's receipt
 * names that baseline as previousSha256: the runtime reports the hash its attempt observed, which
 * is the new digest when a crash after the write re-executes it, so a resumed run would differ.
 */
export async function publish(
  ctx: WorkflowContext,
  out: string,
  content: string,
  publication: 'file' | 'commit',
  ifMatch: string | null,
): Promise<WriteFileResult> {
  if (publication === 'commit') return std.exec.committedArtifact(ctx, out, content);
  const receipt = await ctx.writeFile('write', out, content, { ifMatch });
  return { ...receipt, previousSha256: ifMatch };
}
