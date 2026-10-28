// Operator-selected commands as durable effects. Evidence commands run once in the checkout (whose
// tracked files are the base): a nonzero exit is a completed result (okExitCodes: 'any') whose
// output the checkers read. Verification commands run on the integrated fix; both settle a
// timeout, signal or spawn failure with onError: 'return', so it is recorded rather than a crash.
import type { WorkflowContext, WorktreeHandle } from 'quiet-choir';
import type { Check, Ran } from '../contracts.js';

/** Retained output per stream; an oversized one keeps its head and tail and reports truncated. */
const maxOutputBytes = 16_384;

/** Run every evidence command in order, recording each outcome and its output for the checkers. */
export async function gatherEvidence(ctx: WorkflowContext, commands: Check['argv'][]) {
  const ran: Ran[] = [];
  for (const [index, argv] of commands.entries()) {
    const result = await ctx.exec(ctx.id('evidence', index), argv, {
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
    const outcome =
      check.failure ?? `exit ${String(check.code)}${check.truncated ? ', output truncated' : ''}`;
    ran.push({ ...check, outcome, output: output.trimEnd() || '(no output)' });
  }
  return ran;
}

/** Run every verification command in the integrated tree, in order, recording each outcome. */
export async function verify(
  ctx: WorkflowContext,
  tree: WorktreeHandle,
  commands: Check['argv'][],
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [index, argv] of commands.entries()) {
    const result = await ctx.exec(ctx.id('verify', index), argv, {
      worktree: tree,
      onError: 'return',
    });
    checks.push(
      result.ok
        ? { argv, code: result.value.code, truncated: result.value.truncated, failure: null }
        : { argv, code: result.error.code ?? null, truncated: null, failure: result.error.kind },
    );
  }
  return checks;
}

export const passed = (checks: Check[]) =>
  checks.every((check) => check.failure === null && !check.truncated);
