// Operator commands as durable effects in the checkout. Every command settles: an ordinary nonzero
// exit is a completed result (okExitCodes: 'any') so its whole output survives, and a timeout,
// signal or spawn failure is a recorded failure (onError: 'return'), never a crash.
import type { WorkflowContext } from 'quiet-choir';
import type { Assessed, Dimension, Excerpt, Run, TestCheck } from '../contracts.js';
import { ending, outcome, tail } from './policy.js';

/** Characters of each output stream an assessor or a finding sees, from the end. */
export const outputChars = 16_000;

/** A settled failure keeps only the last 1024 characters of each stream (docs/command-effects.md). */
const settledTailChars = 1024;

interface Ran {
  readonly row: Run;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  ctx: WorkflowContext,
  id: string,
  argv: Run['argv'],
  timeoutMs: number,
): Promise<Ran> {
  const result = await ctx.exec(id, argv, { okExitCodes: 'any', onError: 'return', timeoutMs });
  if (result.ok) {
    const { code, signal, truncated, stdout, stderr } = result.value;
    return { row: { argv, code, signal, failure: null, error: null, truncated }, stdout, stderr };
  }
  const { code, signal, kind, message, stdoutTail = '', stderrTail = '' } = result.error;
  return {
    row: {
      argv,
      code: code ?? null,
      signal: signal ?? null,
      failure: kind,
      error: message,
      // A full-length tail may have cut the stream; a shorter one is the whole of it.
      truncated: Math.max(stdoutTail.length, stderrTail.length) >= settledTailChars,
    },
    stdout: stdoutTail,
    stderr: stderrTail,
  };
}

/** Characters of a test command's output its finding quotes, from the end. */
const findingChars = 2_000;

/** A test command with the end of its output, for the code-owned tests finding. */
export type TestRun = TestCheck & { readonly output: Excerpt };

/**
 * Run each test command once and rerun one that started and did not pass, once. Passing on the
 * rerun is flaky; failing (a nonzero exit or a crash) on either run without passing is failed; two
 * runs without an exit status (timeouts) are unfinished; a command that could not start is not
 * rerun and was not run. The finding quotes a failed run's output when there is one, else the last
 * run's. Commands run in order, so they cannot race each other.
 */
export async function runTests(
  ctx: WorkflowContext,
  commands: readonly Run['argv'][],
  timeoutMs: number,
): Promise<TestRun[]> {
  const checks: TestRun[] = [];
  for (const [index, argv] of commands.entries()) {
    const first = await run(ctx, ctx.id('test', index), argv, timeoutMs);
    const once = ending(first.row);
    const rerun =
      once === 'passed' || once === 'not-started'
        ? null
        : await run(ctx, ctx.id('retest', index), argv, timeoutMs);
    const again = rerun && ending(rerun.row);
    const quoted =
      [rerun, first].find((ran) => ran !== null && ending(ran.row) === 'failed') ?? rerun ?? first;
    checks.push({
      ...first.row,
      rerun: rerun?.row ?? null,
      verdict:
        once === 'passed'
          ? 'pass'
          : once === 'not-started'
            ? 'not-run'
            : again === 'passed'
              ? 'flaky'
              : once === 'failed' || again === 'failed'
                ? 'failed'
                : 'unfinished',
      output: tail(`${quoted.stdout}\n${quoted.stderr}`.trim(), findingChars),
    });
  }
  return checks;
}

/** An evidence command with the excerpt of its output an assessor receives. */
export interface Evidence {
  readonly dimension: Assessed;
  readonly row: Run;
  readonly outcome: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly clipped: boolean;
}

/** Run each evidence command in order and keep the end of each stream for its assessor. */
export async function gatherEvidence(
  ctx: WorkflowContext,
  commands: readonly { readonly dimension: Assessed; readonly argv: Run['argv'] }[],
  timeoutMs: number,
): Promise<Evidence[]> {
  const gathered: Evidence[] = [];
  for (const [index, { dimension, argv }] of commands.entries()) {
    const ran = await run(ctx, ctx.id('evidence', index), argv, timeoutMs);
    const stdout = tail(ran.stdout, outputChars),
      stderr = tail(ran.stderr, outputChars);
    gathered.push({
      dimension,
      row: ran.row,
      outcome: outcome(ran.row),
      stdout: stdout.text,
      stderr: stderr.text,
      clipped: stdout.clipped || stderr.clipped || ran.row.truncated,
    });
  }
  return gathered;
}

/**
 * The excerpts of the commands run for one dimension, as the assessor and the confirmer of a
 * blocker there both receive them.
 */
export const forDimension = <D extends Dimension>(evidence: readonly Evidence[], dimension: D) => ({
  dimension,
  commands: evidence
    .filter((ran) => ran.dimension === dimension)
    .map(({ row, outcome, stdout, stderr, clipped }) => ({
      argv: [...row.argv],
      outcome,
      error: row.error,
      stdout,
      stderr,
      clipped,
    })),
});
