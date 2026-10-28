// The PRD's destination as durable effects: code checks out before any agent runs, so an existing
// PRD is refused rather than discovered at the write after every call was paid for, then writes
// or commits the rendered document against the baseline it checked.
import type { WorkflowContext, WriteFileResult } from 'quiet-choir';
import * as std from 'quiet-choir/std';

/** Where out stands: the baseline the write must match, or why the run must not start. */
export type Target = { readonly ifMatch: string | null } | { readonly refusal: string };

/**
 * Read out once. A missing file is created; an existing one is replaced only when `replace` names
 * its current sha256 and the publication is a file, since a managed commit only creates. Settled
 * file failures carry no "missing" kind, so this reads the errno code Node puts first in the
 * message; any other failure (a directory, an oversized file) means something is there.
 */
export async function checkOut(
  ctx: WorkflowContext,
  out: string,
  replace: string | null,
  publication: 'file' | 'commit',
): Promise<Target> {
  const existing = await ctx.readFile('existing', out, { onError: 'return' });
  if (!existing.ok && /^ENOENT\b/u.test(existing.error.message)) return { ifMatch: null };
  if (!existing.ok)
    return {
      refusal: `Not run: ${out} exists but is not a readable PRD (${existing.error.message}).`,
    };
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

/**
 * Publish the document at out: a file written against the checked baseline (exclusive creation
 * when out was missing), or a managed commit that later stages can build on.
 */
export const publish = (
  ctx: WorkflowContext,
  out: string,
  content: string,
  publication: 'file' | 'commit',
  ifMatch: string | null,
): Promise<WriteFileResult> =>
  publication === 'commit'
    ? std.exec.committedArtifact(ctx, out, content)
    : ctx.writeFile('write', out, content, { ifMatch });
