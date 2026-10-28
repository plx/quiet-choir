// Durable mechanics: the backlog snapshot, the clean-checkout refusal, the pinned base, and one
// probe run in its own checkout. Probes settle with onError: 'return' and okExitCodes: 'any', so
// an exit code is data and a timeout or signal is a recorded result, not a crash.
import type { WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha, type Run } from '../contracts.js';

/** Text with a newline is the backlog itself; anything else is a path read once and memoized. */
export async function readBacklog(ctx: WorkflowContext, tickets: string) {
  if (tickets.includes('\n')) return { path: null, content: tickets };
  return { path: tickets, content: (await ctx.readFile('backlog', tickets)).content };
}

/**
 * Every path that differs from HEAD anywhere in the repository, untracked files included, except
 * the backlog file: agents and probes see the committed tree, so uncommitted work would go unchecked.
 */
export async function dirtyPaths(ctx: WorkflowContext, backlog: string | null) {
  const exclude = backlog === null ? [] : [`:(exclude,literal)${backlog}`];
  const status = await std.exec.git(ctx, 'status', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ':/',
    ...exclude,
  ]);
  return status
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
}

/** The commit every agent reads and every probe runs against. */
export const baseCommit = async (ctx: WorkflowContext) =>
  Sha.parse((await std.exec.git(ctx, 'base', ['rev-parse', 'HEAD'])).trim());

const tail = (text: string) => text.slice(-1000);

/**
 * Run one approved probe alone: a fresh checkout pinned at `base` (step `tree`), then the
 * operator's command with the probe on stdin (step `probe`). No probe sees another's side effects.
 * It inherits the operator's environment and privileges, as the approval question says.
 */
export async function runProbe(
  ctx: WorkflowContext,
  request: { base: string; argv: [string, ...string[]]; probe: string; timeoutMs: number },
): Promise<Run> {
  const tree = await ctx.worktree('tree', { base: { commit: request.base } });
  const result = await ctx.exec('probe', request.argv, {
    worktree: tree,
    input: request.probe,
    okExitCodes: 'any',
    timeoutMs: request.timeoutMs,
    onError: 'return',
  });
  if (result.ok) {
    const { code, signal, stdout, stderr } = result.value;
    return { code, signal, failure: null, stdout: tail(stdout), stderr: tail(stderr) };
  }
  const { code, signal, kind, message, stdoutTail, stderrTail } = result.error;
  return {
    code: code ?? null,
    signal: signal ?? null,
    failure: { kind, message: message.slice(0, 500) },
    stdout: stdoutTail ?? '',
    stderr: stderrTail ?? '',
  };
}
