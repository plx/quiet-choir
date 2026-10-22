// The local check suite as one durable step. A workflow step has no shell time limit, so the
// native check-start/check-wait slices and the fixer-runs-the-suite protocol are gone: the step
// installs dependencies when package.json or the lockfile changed, runs the suite with its output
// in a log file, and returns a small verdict pinned to the head it ran at.
import { availableParallelism, loadavg } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settled, StepContext, WorkflowContext } from 'quiet-choir';
import { Check, type Check as CheckResult } from '../contracts.js';
import { git, run } from './git.js';
import { failedStep, stripAnsi, tail } from './policy.js';

const STAMP = '.merge-down-lock-hash';
const MINUTE = 60_000;

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The dependency key of `dir`: the blob hashes of package.json and package-lock.json, one per line,
 * so a manifest edit without a lockfile update invalidates installed dependencies too. Null when
 * either file is missing.
 */
export async function dependencyKey(context: StepContext, dir: string): Promise<string | null> {
  const hashed = await run(context, ['git', 'hash-object', 'package.json', 'package-lock.json'], {
    cwd: dir,
  });
  if (hashed.code !== 0) return null;
  return hashed.stdout.trim().split(/\s+/).join('\n');
}

/**
 * Install the worktree's dependencies with `npm ci` unless node_modules was installed from the same
 * package.json and lockfile (a stamp holds their {@link dependencyKey}). Returns whether it
 * installed, or the failed install's output; null hash means there is no lockfile.
 */
export async function provisionDependencies(
  context: StepContext,
  workdir: string,
): Promise<{ hash: string | null; installed: boolean; failure: string | null }> {
  const hash = await dependencyKey(context, workdir);
  if (hash === null) return { hash: null, installed: false, failure: null };
  const stamp = join(workdir, 'node_modules', STAMP);
  if ((await readText(stamp))?.trim() === hash) return { hash, installed: false, failure: null };
  const installed = await run(context, ['npm', 'ci', '--no-audit', '--no-fund'], {
    cwd: workdir,
    timeoutMs: 20 * MINUTE,
  });
  if (installed.code !== 0)
    return { hash, installed: false, failure: stripAnsi(installed.stdout + installed.stderr) };
  await mkdir(join(workdir, 'node_modules'), { recursive: true });
  await writeFile(stamp, hash);
  return { hash, installed: true, failure: null };
}

/** The dependency stamp of a provisioned worktree, for a review worktree to compare against. */
export function dependencyStamp(workdir: string): Promise<string | null> {
  return readText(join(workdir, 'node_modules', STAMP));
}

/** The input of {@link runCheck}. */
export interface CheckInput {
  readonly workdir: string;
  readonly dir: string;
  readonly label: string;
  readonly command: string;
}

/**
 * Run the check suite (`command`, default `npm run check`) at the worktree's HEAD, with its output
 * in `<dir>/<label>.log` and the last 40 lines in `<label>.excerpt.txt` when it fails. Under load
 * (1-minute load above the core count) Vitest is capped at 4 workers. A step failure, such as a
 * command that cannot start, settles as a failed check with its message in `error`.
 */
export async function runCheck(
  ctx: WorkflowContext,
  id: string,
  input: CheckInput,
): Promise<CheckResult> {
  const settled: Settled<CheckResult> = await ctx.step(id, {
    identity: 'version',
    version: 'merge-down.check/1',
    input: { ...input },
    schema: Check,
    onError: 'return',
    async run(context) {
      const W = input.workdir;
      const log = join(input.dir, `${input.label}.log`);
      const excerptFile = join(input.dir, `${input.label}.excerpt.txt`);
      await mkdir(input.dir, { recursive: true });
      const started = performance.now();
      const seconds = (): number => Math.round((performance.now() - started) / 1000);
      const head = await git(context, W, ['rev-parse', 'HEAD']);
      const deps = await provisionDependencies(context, W);
      if (deps.failure !== null) {
        await writeFile(log, deps.failure);
        await writeFile(excerptFile, `${tail(deps.failure, 30)}\n`);
        return {
          passed: false,
          head,
          failedStep: 'npm ci',
          exitCode: null,
          seconds: seconds(),
          installedDependencies: false,
          maxWorkers: null,
          log,
          excerptFile,
          error: null,
        };
      }
      const busy = loadavg()[0] ?? 0;
      const maxWorkers = busy > availableParallelism() ? '4' : null;
      // Grouped so every part of a compound command logs; the newline ends a trailing comment.
      const suite = await run(
        context,
        ['bash', '-c', `{ ${input.command}\n} > "$1" 2>&1`, 'merge-down-check', log],
        {
          cwd: W,
          env: {
            NO_COLOR: '1',
            FORCE_COLOR: '0',
            ...(maxWorkers === null ? {} : { VITEST_MAX_WORKERS: maxWorkers }),
          },
          timeoutMs: 45 * MINUTE,
        },
      );
      const text = stripAnsi((await readText(log)) ?? '');
      const passed = suite.code === 0;
      if (!passed) await writeFile(excerptFile, `${tail(text, 40)}\n`);
      return {
        passed,
        head,
        failedStep: passed ? null : failedStep(text),
        exitCode: suite.code,
        seconds: seconds(),
        installedDependencies: deps.installed,
        maxWorkers,
        log,
        excerptFile: passed ? null : excerptFile,
        error: null,
      };
    },
  });
  if (settled.ok) return settled.value;
  return {
    passed: false,
    head: null,
    failedStep: null,
    exitCode: null,
    seconds: 0,
    installedDependencies: false,
    maxWorkers: null,
    log: null,
    excerptFile: null,
    error: settled.error.message,
  };
}
