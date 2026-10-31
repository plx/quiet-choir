// Stress and verification mechanics as durable commands. Every run settles: okExitCodes 'any'
// keeps a failing test's exit code and duration as data, and onError: 'return' records a timeout,
// a signal or a command that could not start, so resume replays the same verdict. The pass
// pattern is applied in code to the recorded output, so it is not part of a run's identity.
import type {
  ExecResult,
  ExecStepError,
  Settled,
  WorkflowContext,
  WorktreeHandle,
} from 'quiet-choir';
import type { Check, Restressed, Run, Stress } from '../contracts.js';
import { summarize, tail } from './policy.js';

/**
 * What one run's settled outcome says about the test. Some runners exit 0 when no test matches
 * the name, so with a pass pattern an exit 0 counts as a pass only when its output matches.
 */
function observe(result: Settled<ExecResult, ExecStepError>, passPattern: RegExp | null): Run {
  if (result.ok) {
    const { code, stdout, stderr } = result.value;
    const matched = passPattern === null || passPattern.test(`${stdout}\n${stderr}`);
    return {
      outcome: code !== 0 ? 'fail' : matched ? 'pass' : 'unmatched',
      code,
      durationMs: Math.round(result.value.durationMs),
    };
  }
  const { kind, code = null, signal = null } = result.error;
  // A settled failure carries no duration (see the findings); only an exit is timed.
  if (kind === 'timeout') return { outcome: 'timeout', code: null, durationMs: null };
  if (signal !== null) return { outcome: 'signal', code: null, durationMs: null };
  // Under okExitCodes 'any' an exit is data, so what remains is a command that never ran.
  return { outcome: 'error', code, durationMs: null };
}

const output = (result: Settled<ExecResult, ExecStepError>) =>
  tail(
    (result.ok
      ? `${result.value.stdout}\n${result.value.stderr}`
      : `${result.error.stdoutTail ?? ''}\n${result.error.stderrTail ?? ''}\n${result.error.message}`
    ).trim(),
  );

/**
 * Run `argv` up to `runs` times in order, as steps `run/<n>` in the caller's scope. A command that
 * cannot start, or a pass that ran no matching test, stops the loop: repeating it measures nothing.
 */
export async function stress(
  ctx: WorkflowContext,
  argv: Stress['argv'],
  runs: number,
  options: { timeoutMs: number; tree: WorktreeHandle | null; passPattern: RegExp | null },
): Promise<Stress> {
  const outcomes: Run[] = [];
  const samples = { sample: null as string | null, passSample: null as string | null };
  for (let n = 0; n < runs; n++) {
    const result = await ctx.exec(ctx.id('run', n), argv, {
      ...(options.tree ? { worktree: options.tree } : {}),
      okExitCodes: 'any',
      timeoutMs: options.timeoutMs,
      maxOutputBytes: 65_536,
      onError: 'return',
    });
    const run = observe(result, options.passPattern);
    outcomes.push(run);
    if (run.outcome === 'pass') samples.passSample ??= output(result);
    else samples.sample ??= output(result);
    if (run.outcome === 'error' || run.outcome === 'unmatched') break;
  }
  return summarize(argv, outcomes, samples);
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

/** Every re-stressed test passed every run and every verification command exited cleanly. */
export const held = (restress: Restressed[], checks: Check[]) =>
  restress.every((row) => row.stress.verdict === 'stable') &&
  checks.every((check) => check.failure === null && !check.truncated);
