// The operator's check commands as durable effects on the runtime-owned checkout of the snapshot. A
// nonzero exit is a completed result (okExitCodes: 'any'), so a red suite keeps its whole capped
// output; a timeout, signal or spawn failure settles with onError: 'return' and keeps its tails.
// Either way it is evidence the checker and challenger read, never a crash, and the source
// checkout is untouched.
import type { WorkflowContext, WorktreeHandle } from 'quiet-choir';
import type { Check, Ran } from '../contracts.js';

/** Retained output per stream; an oversized one keeps its head and tail and reports truncated. */
const maxOutputBytes = 16_384;

/** Run every command in order in `tree`, the snapshot's checkout, recording each outcome. */
export async function runCommands(
  ctx: WorkflowContext,
  tree: WorktreeHandle,
  commands: Check['argv'][],
): Promise<{ checks: Check[]; evidence: Ran[] }> {
  const checks: Check[] = [];
  const evidence: Ran[] = [];
  for (const [index, argv] of commands.entries()) {
    const result = await ctx.exec(ctx.id('command', index), argv, {
      worktree: tree,
      maxOutputBytes,
      okExitCodes: 'any',
      onError: 'return',
    });
    const check: Check = result.ok
      ? { argv, code: result.value.code, truncated: result.value.truncated, failure: null }
      : { argv, code: result.error.code ?? null, truncated: null, failure: result.error.kind };
    const output = result.ok
      ? [result.value.stdout, result.value.stderr].filter(Boolean).join('\n')
      : [result.error.stdoutTail, result.error.stderrTail, result.error.message]
          .filter(Boolean)
          .join('\n');
    checks.push(check);
    evidence.push({
      argv,
      code: check.code,
      failure: check.failure,
      truncated: check.truncated ?? true,
      output: output.trimEnd() || '(no output)',
    });
  }
  return { checks, evidence };
}
