// Operator-selected commands as durable effects, each in a runtime-owned checkout. Evidence
// commands run once in a checkout of the base, which holds committed files only: every exit is a
// completed result (okExitCodes: 'any') whose output the checkers read, and code judges it against
// the operator's accepted exits, so a missing build or a crash degrades the run. Verification
// commands run on the integrated fix and pass only on exit 0, however much they print. Both settle
// a timeout, signal or spawn failure with onError: 'return', so it is recorded rather than a crash.
import type { WorkflowContext, WorktreeHandle } from 'quiet-choir';
import type { Check, EvidenceCommand, Ran } from '../contracts.js';
import { fenced } from './policy.js';

/** Retained output per stream; an oversized one keeps its head and tail and reports truncated. */
const maxOutputBytes = 16_384;

/** One settled command run as a check row, `ok` when it exited with an accepted code. */
async function run(
  ctx: WorkflowContext,
  id: string,
  tree: WorktreeHandle,
  argv: Check['argv'],
  okExitCodes: readonly number[],
) {
  const result = await ctx.exec(id, argv, {
    worktree: tree,
    maxOutputBytes,
    okExitCodes: 'any',
    onError: 'return',
  });
  const check: Check = result.ok
    ? {
        argv,
        code: result.value.code,
        truncated: result.value.truncated,
        failure: null,
        // A signal is a settled failure, so a completed run always has its exit code.
        ok: okExitCodes.includes(result.value.code),
      }
    : {
        argv,
        code: result.error.code ?? null,
        truncated: null,
        failure: result.error.kind,
        ok: false,
      };
  const output = result.ok
    ? [result.value.stdout, result.value.stderr].filter(Boolean).join('\n')
    : [result.error.stdoutTail, result.error.stderrTail, result.error.message]
        .filter(Boolean)
        .join('\n');
  return { check, output };
}

/**
 * Run every evidence command in order in one checkout of `base`, so its output describes the
 * commit the docs were read at, recording each outcome and its output for the checkers.
 */
export async function gatherEvidence(
  ctx: WorkflowContext,
  base: string,
  commands: EvidenceCommand[],
): Promise<Ran[]> {
  if (!commands.length) return [];
  const tree = await ctx.worktree('evidence-tree', { base: { commit: base } });
  const ran: Ran[] = [];
  for (const [index, command] of commands.entries()) {
    const { argv, okExitCodes } = Array.isArray(command)
      ? { argv: command, okExitCodes: [0] }
      : command;
    const { check, output } = await run(ctx, ctx.id('evidence', index), tree, argv, okExitCodes);
    const outcome = [
      check.failure ?? `exit ${String(check.code)}`,
      ...(check.truncated ? ['output truncated'] : []),
    ].join(', ');
    ran.push({
      ...check,
      outcome: check.ok ? outcome : `${outcome}; failed`,
      output: fenced(output.trimEnd() || '(no output)', 'evidence'),
    });
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
  for (const [index, argv] of commands.entries())
    checks.push((await run(ctx, ctx.id('verify', index), tree, argv, [0])).check);
  return checks;
}

/** Every command exited 0 with no settled failure; truncated output does not fail a command. */
export const passed = (checks: Check[]) => checks.every((check) => check.ok);
