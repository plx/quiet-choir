// The local check suite as one durable step, for the ticket worktree. A workflow step has no shell
// time limit, so the native check-start/check-wait slices and the implementer-runs-the-gate
// protocol are gone: the step installs dependencies when package.json or the lockfile changed,
// runs the suite with its output in a log file, and returns a small verdict pinned to the head it
// ran at. Modelled on merge-down's runCheck, whose dependency provisioning and log helpers it
// reuses; ownership here is the ticket branch rather than a PR's local branch.
import { availableParallelism, loadavg } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settled, WorkflowContext } from 'quiet-choir';
import { Check, type Check as CheckResult } from '../../merge-down.quiet-choir/contracts.js';
import { provisionDependencies } from '../../merge-down.quiet-choir/lib/checks.js';
import { checkedOut, git, run } from '../../merge-down.quiet-choir/lib/git.js';
import {
  dirtyTreeLog,
  failedStep,
  stripAnsi,
  tail,
} from '../../merge-down.quiet-choir/lib/policy.js';

export type { CheckResult };

const MINUTE = 60_000;

/** The input of {@link runCheck}. */
export interface CheckInput {
  readonly workdir: string;
  /** The ticket branch the worktree must be on. */
  readonly branch: string;
  readonly dir: string;
  readonly label: string;
  readonly command: string;
}

/** The failed step of a check that refused a worktree not on the ticket branch. */
export const FOREIGN_WORKTREE = 'foreign worktree';

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Run the check suite (`command`, default `npm run check`) at the worktree's HEAD with a 45-minute
 * deadline, its output in `<dir>/<label>.log` and the last 40 lines in `<label>.excerpt.txt` when
 * it fails. A worktree not on `branch` fails as `foreign worktree`, running nothing. The suite
 * certifies a clean HEAD only: uncommitted or untracked changes fail as `dirty worktree` without
 * running it (the log and excerpt list them), a HEAD that moved while the suite ran fails as
 * `HEAD moved`, and a tree the install or the suite left dirty fails as `dirty worktree` too. Under
 * load (1-minute load above the core count) Vitest is capped at 4 workers. A step failure, such as
 * a command that cannot start, settles as a failed check with its message in `error`.
 */
export async function runCheck(
  ctx: WorkflowContext,
  id: string,
  input: CheckInput,
): Promise<CheckResult> {
  const settled: Settled<CheckResult> = await ctx.step(id, {
    identity: 'version',
    version: 'epic-ticket.check/1',
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
      const verdict = (fields: Partial<CheckResult>): CheckResult => ({
        passed: false,
        head,
        failedStep: null,
        exitCode: null,
        seconds: seconds(),
        installedDependencies: false,
        maxWorkers: null,
        log,
        excerptFile,
        error: null,
        ...fields,
      });
      const head = await git(context, W, ['rev-parse', 'HEAD']);
      const ref = await checkedOut(context, W);
      if (ref !== `refs/heads/${input.branch}`)
        return verdict({
          failedStep: FOREIGN_WORKTREE,
          log: null,
          excerptFile: null,
          error: `the worktree is on ${ref?.replace(/^refs\/heads\//, '') ?? 'a detached HEAD'}, not ${input.branch}`,
        });
      const dirtyListing = async (): Promise<string | null> => {
        const status = await run(
          context,
          ['git', 'status', '--porcelain', '--untracked-files=normal'],
          { cwd: W },
        );
        if (status.code !== 0)
          throw new Error(`git status failed: ${tail(status.stderr || status.stdout, 20)}`);
        return dirtyTreeLog(head, status.stdout);
      };
      const dirty = async (
        listing: string,
        installed: boolean,
        suite: { text: string; exitCode: number | null; maxWorkers: string | null } | null,
      ): Promise<CheckResult> => {
        if (suite === null) await writeFile(log, listing);
        await writeFile(
          excerptFile,
          suite === null ? listing : `${listing}${tail(suite.text, 40)}\n`,
        );
        return verdict({
          failedStep: 'dirty worktree',
          exitCode: suite?.exitCode ?? null,
          installedDependencies: installed,
          maxWorkers: suite?.maxWorkers ?? null,
        });
      };
      const before = await dirtyListing();
      if (before !== null) return dirty(before, false, null);
      const deps = await provisionDependencies(context, W);
      if (deps.failure !== null) {
        await writeFile(log, deps.failure);
        await writeFile(excerptFile, `${tail(deps.failure, 30)}\n`);
        return verdict({ failedStep: 'npm ci' });
      }
      const provisioned = await dirtyListing();
      if (provisioned !== null) return dirty(provisioned, deps.installed, null);
      const maxWorkers = (loadavg()[0] ?? 0) > availableParallelism() ? '4' : null;
      // Grouped so every part of a compound command logs; the newline ends a trailing comment.
      const suite = await run(
        context,
        ['bash', '-c', `{ ${input.command}\n} > "$1" 2>&1`, 'epic-ticket-check', log],
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
      const after = await git(context, W, ['rev-parse', 'HEAD']);
      const moved = after !== head;
      const left = moved ? null : await dirtyListing();
      if (left !== null)
        return dirty(left, deps.installed, { text, exitCode: suite.code, maxWorkers });
      const passed = suite.code === 0 && !moved;
      if (moved)
        await writeFile(
          excerptFile,
          `HEAD moved from ${head} to ${after} while the suite ran.\n${tail(text, 40)}\n`,
        );
      else if (!passed) await writeFile(excerptFile, `${tail(text, 40)}\n`);
      return verdict({
        passed,
        failedStep: passed ? null : moved ? 'HEAD moved' : failedStep(text),
        exitCode: suite.code,
        installedDependencies: deps.installed,
        maxWorkers,
        excerptFile: passed ? null : excerptFile,
      });
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
