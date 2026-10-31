// The snapshot the local roles read: HEAD, pinned once before any of them runs, and a check that a
// read-only role's call left it unchanged and named no path outside it.
import type { WorkflowContext, WorktreeChange } from 'quiet-choir';
import { Path, Sha } from '../contracts.js';

/**
 * HEAD's commit, or null outside a Git repository or before its first commit. The failure is
 * settled, so a context given anywhere still grounds the prompts, and only the local sweep is
 * skipped; std.exec.git always throws, so this runs the command directly.
 */
export async function pinHead(ctx: WorkflowContext): Promise<string | null> {
  const head = await ctx.exec('head', ['git', 'rev-parse', '--verify', 'HEAD^{commit}'], {
    onError: 'return',
  });
  return head.ok ? Sha.parse(head.value.stdout.trim()) : null;
}

/**
 * A local role's output, refused when the call changed its snapshot or when a ref it names (the
 * `named` refs) is not a repository-relative Path. A refusal fails the map item, not the run.
 */
export function unchanged<T>(
  result: { output: T; worktree?: WorktreeChange },
  named: (output: T) => string[] = () => [],
): T {
  if (!result.worktree) throw new Error('A snapshot call returned no receipt');
  if (result.worktree.files.length)
    throw new Error(
      `A read-only role changed its snapshot: ${JSON.stringify(result.worktree.files)}`,
    );
  const outside = named(result.output).filter((ref) => !Path.safeParse(ref).success);
  if (outside.length)
    throw new Error(`A local role named refs outside the repository: ${JSON.stringify(outside)}`);
  return result.output;
}
