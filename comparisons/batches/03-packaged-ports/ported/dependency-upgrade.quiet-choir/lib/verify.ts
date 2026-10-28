// Verification mechanics: the install command, then every verification command, in one fresh
// checkout of an integrated commit. A nonzero exit is a completed result (okExitCodes: 'any'),
// because a settled failure keeps only 1024 characters of each stream and the triager needs the
// red output; a signal or a timeout settles with onError: 'return'. Call it under a round scope.
import type { WorkflowContext, WorktreeHandle } from 'quiet-choir';
import type { Check, Failure } from '../contracts.js';
import { green, outcomeOf } from './policy.js';

/** How much of a failing command's output the triager and the fixers read. */
const OUTPUT_TAIL = 4096;

async function run(ctx: WorkflowContext, id: string, tree: WorktreeHandle, argv: Check['argv']) {
  const result = await ctx.exec(id, argv, {
    worktree: tree,
    okExitCodes: 'any',
    onError: 'return',
  });
  if (result.ok) {
    const { code, signal, truncated, stdout, stderr } = result.value;
    return {
      check: { argv, code, signal, truncated, failure: null },
      output: `${stdout}${stderr}`.slice(-OUTPUT_TAIL),
    };
  }
  // A settled failure carries no truncation flag, so `truncated: null` means unknown.
  const { code, signal, kind, stdoutTail, stderrTail } = result.error;
  return {
    check: { argv, code: code ?? null, signal: signal ?? null, truncated: null, failure: kind },
    output: `${stdoutTail ?? ''}${stderrTail ?? ''}`,
  };
}

/**
 * Check out `commit` as the round's `tree`, run `install` (step `install`) and each verification
 * command (`verify/<n>`) in it, and collect every command that did not pass.
 */
export async function verifyCommit(
  ctx: WorkflowContext,
  options: { commit: string; install: Check['argv'] | null; commands: Check['argv'][] },
) {
  const tree = await ctx.worktree('tree', { base: { commit: options.commit } });
  const failures: Failure[] = [];
  const record = ({ check, output }: Awaited<ReturnType<typeof run>>) => {
    if (!green(check))
      failures.push({
        command: check.argv.join(' '),
        outcome: outcomeOf(check),
        output: output.trimEnd() || '(no output)',
      });
    return check;
  };
  const install = options.install ? record(await run(ctx, 'install', tree, options.install)) : null;
  const checks: Check[] = [];
  for (const [index, argv] of options.commands.entries())
    checks.push(record(await run(ctx, ctx.id('verify', index), tree, argv)));
  return { tree, install, checks, failures, passed: failures.length === 0 };
}
