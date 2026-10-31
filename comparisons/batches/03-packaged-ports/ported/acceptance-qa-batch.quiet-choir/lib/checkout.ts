// Durable mechanics: the backlog snapshot, the clean-checkout refusal, the pinned base, and one
// probe run in its own prepared checkout. Every command settles with onError: 'return', so a
// nonzero exit, a timeout or a signal is a recorded result, not a crash.
import type { WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Run, Sha } from '../contracts.js';

type Argv = [string, ...string[]];

/** Text with a line break, or JSON, is the backlog itself; else a path read once and memoized. */
export async function readBacklog(ctx: WorkflowContext, tickets: string) {
  if (tickets.includes('\n') || /^\s*[[{]/u.test(tickets)) return { path: null, content: tickets };
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

export type ProbeRequest = {
  base: string;
  argv: Argv;
  prepare: Argv[];
  probeEnv: string[];
  probe: string;
  timeoutMs: number;
  prepareTimeoutMs: number;
};

/**
 * Run one approved probe alone: a fresh checkout pinned at `base` (step `tree`), then one local
 * step on it (step `probe`) that runs the operator's prepare commands with the full environment
 * and the probe with only the `probeEnv` variables. The commands are not durable effects of their
 * own, so a rerun of the step prepares the checkout again before its probe, and the variables'
 * values never enter identity (their names do, through the step's input). No probe sees
 * another's side effects.
 */
export async function runProbe(ctx: WorkflowContext, request: ProbeRequest): Promise<Run> {
  const { base, ...input } = request;
  const tree = await ctx.worktree('tree', { base: { commit: base } });
  return ctx.step('probe', {
    worktree: tree,
    input,
    schema: Run,
    run: async (context): Promise<Run> => {
      for (const command of input.prepare) {
        const prepared = await context.exec(command, {
          timeoutMs: input.prepareTimeoutMs,
          onError: 'return',
        });
        if (prepared.ok) continue;
        const { kind, message, stdoutTail, stderrTail } = prepared.error;
        return {
          code: null,
          signal: null,
          failure: {
            stage: 'prepare',
            kind,
            message: `${JSON.stringify(command)}: ${message}`.slice(0, 500),
          },
          stdout: tail(stdoutTail ?? ''),
          stderr: tail(stderrTail ?? ''),
        };
      }
      const env: Record<string, string> = {};
      for (const name of input.probeEnv) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      const result = await context.exec(input.argv, {
        input: input.probe,
        inheritEnv: false,
        env,
        okExitCodes: 'any',
        timeoutMs: input.timeoutMs,
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
        failure: { stage: 'probe', kind, message: message.slice(0, 500) },
        stdout: tail(stdoutTail ?? ''),
        stderr: tail(stderrTail ?? ''),
      };
    },
  });
}
