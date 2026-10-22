// The local Codex review: `codex review --base origin/<default>` of one head, in a throwaway
// worktree of its own (the PR worktree is shared with the check suite and later fix rounds). It is
// a durable command effect, not an agent call: the Codex harness has no review mode. The runtime's
// process lifecycle replaces the native start, wait, stop and reap subcommands, and the effect IDs
// are keyed by head, model and effort, so a resumed run reuses a finished review.
import { existsSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z, type StepContext, type WorkflowContext } from 'quiet-choir';
import { dependencyKey, dependencyStamp, provisionDependencies } from './checks.js';
import { git, run, type Paths } from './git.js';
import { reviewFindings, stripAnsi, tail } from './policy.js';

const MINUTE = 60_000;

/** `path` with symlinks resolved, or as given when it does not exist (as `ctx.exec` treats a cwd). */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return path;
    throw error;
  }
}

/** What one local review produced, in the ledger's `localReviews` shape plus the review's head. */
export interface LocalReview {
  readonly sha: string;
  readonly model: string;
  readonly effort: string | null;
  readonly file: string | null;
  readonly log: string | null;
  readonly exitCode: number | null;
  readonly elapsedSeconds: number | null;
  readonly deps: string | null;
  readonly findings: number;
  readonly priorities: Readonly<Record<string, number>> | null;
  readonly error: string | null;
}

/** The input of {@link localCodexReview}. */
export interface LocalReviewInput {
  /** The round, such as `r0`; a failed review of the same head in a later round runs again. */
  readonly label: string;
  readonly paths: Paths;
  readonly base: string;
  readonly sha: string;
  readonly model: string;
  readonly effort: string | null;
}

const Setup = z.object({
  deps: z.enum(['none', 'cloned', 'installed', 'missing']),
  review: z.string(),
});
const Teardown = z.object({ moved: z.boolean(), dirty: z.array(z.string()) });

/**
 * Review head `sha` locally. Steps (under `codex/<label>/<sha>/<model>/<effort>/`): `setup` adds
 * the review worktree at `<dir>/review-<sha12>`, records its canonical path for `review`'s cwd, and
 * gives it dependencies (a copy-on-write clone of the PR worktree's node_modules when package.json
 * and the lockfile match, else `npm ci`); `review` runs codex there with a 54-minute deadline and
 * its stderr in a log; `file` saves the review text; `teardown`, in a finally that also covers a
 * failed setup, notes whether the review moved its worktree and removes it. A failure is returned
 * in `error`, never thrown: the gate proceeds on CI without the review.
 */
export async function localCodexReview(
  ctx: WorkflowContext,
  input: LocalReviewInput,
): Promise<LocalReview> {
  const { paths, sha, model, effort } = input;
  const W = paths.workdir;
  const short = sha.slice(0, 12);
  const RW = join(paths.dir, `review-${short}`);
  const stem = join(paths.dir, `codex-review-${short}`);
  const at = (step: string): string =>
    ctx.id('codex', input.label, sha, model, effort ?? 'default', step);
  const failed = (error: string, extra: Partial<LocalReview> = {}): LocalReview => ({
    sha,
    model,
    effort,
    file: null,
    log: null,
    exitCode: null,
    elapsedSeconds: null,
    deps: null,
    findings: 0,
    priorities: null,
    error,
    ...extra,
  });
  const remove = async (context: StepContext): Promise<void> => {
    await run(context, ['git', 'worktree', 'remove', '--force', RW], { cwd: W });
    await rm(RW, { recursive: true, force: true });
    await run(context, ['git', 'worktree', 'prune'], { cwd: W });
  };
  const setUp = () =>
    ctx.step(at('setup'), {
      identity: 'version',
      version: 'merge-down.review-setup/2',
      input: { workdir: W, review: RW, sha },
      schema: Setup,
      onError: 'return',
      async run(context) {
        await remove(context); // left behind by a review that was killed
        await git(context, W, ['worktree', 'add', '--detach', RW, sha]);
        // The review's cwd, canonical while the worktree exists: `ctx.exec` records the resolved
        // cwd, and a resume after teardown must present the same one.
        const review = await canonical(RW);
        const key = await dependencyKey(context, RW);
        if (key === null) return { deps: 'none' as const, review };
        if ((await dependencyStamp(W))?.trim() === key) {
          const cloned = await run(
            context,
            ['cp', '-c', '-R', join(W, 'node_modules'), join(RW, 'node_modules')],
            { timeoutMs: 10 * MINUTE },
          );
          if (cloned.code === 0) return { deps: 'cloned' as const, review };
          await rm(join(RW, 'node_modules'), { recursive: true, force: true });
        }
        const deps = await provisionDependencies(context, RW);
        return {
          deps: deps.failure === null ? ('installed' as const) : ('missing' as const),
          review,
        };
      },
    });
  const reviewed = async ({ deps, review: cwd }: z.output<typeof Setup>): Promise<LocalReview> => {
    const config = [
      '-c',
      `model="${model}"`,
      // A user-config review_model takes precedence over model for `codex review`.
      '-c',
      `review_model="${model}"`,
      // workspace-write: the review's worktree is its own and discarded, so it may run tests there.
      '-c',
      'sandbox_mode="workspace-write"',
      ...(effort === null ? [] : ['-c', `model_reasoning_effort="${effort}"`]),
    ];
    const log = `${stem}.log`;
    const review = await ctx.exec(
      at('review'),
      [
        'sh',
        '-c',
        'exec "$@" 2>"$MERGE_DOWN_REVIEW_LOG"',
        'merge-down-review',
        'codex',
        'review',
        '--base',
        `origin/${input.base}`,
        ...config,
      ],
      {
        cwd,
        env: { MERGE_DOWN_REVIEW_LOG: log },
        scrubEnv: true,
        okExitCodes: 'any',
        timeoutMs: 54 * MINUTE,
        maxOutputBytes: 8 * 1024 * 1024,
        onError: 'return',
      },
    );
    if (!review.ok)
      return failed(`codex review failed to run: ${review.error.message}`, { deps, log });
    const text = stripAnsi(review.value.stdout).trim();
    const file = `${stem}.md`;
    await ctx.writeFile(at('file'), file, `${text}\n`, { allowOutsideCwd: true });
    const counts = reviewFindings(text);
    const result: LocalReview = {
      sha,
      model,
      effort,
      file,
      log,
      exitCode: review.value.code,
      elapsedSeconds: Math.round(review.value.durationMs / 1000),
      deps,
      findings: counts.findings,
      priorities: counts.priorities,
      error:
        review.value.code !== 0
          ? `codex review exited ${String(review.value.code)}: ${tail(stripAnsi(review.value.stderr), 5)}`
          : text
            ? null
            : 'codex review printed no review',
    };
    return result;
  };
  let outcome: LocalReview;
  let teardown: z.output<typeof Teardown>;
  try {
    const setup = await setUp();
    outcome = setup.ok
      ? await reviewed(setup.value)
      : failed(`could not prepare the review worktree: ${setup.error.message}`);
  } finally {
    teardown = await ctx.step(at('teardown'), {
      identity: 'version',
      version: 'merge-down.review-teardown/1',
      input: { workdir: W, review: RW, sha },
      schema: Teardown,
      async run(context) {
        if (!existsSync(RW)) return { moved: false, dirty: [] };
        const dirty = (await run(context, ['git', 'status', '--porcelain'], { cwd: RW })).stdout
          .split('\n')
          .filter(Boolean);
        const head = (await run(context, ['git', 'rev-parse', 'HEAD'], { cwd: RW })).stdout.trim();
        await remove(context);
        return { moved: head !== sha, dirty };
      },
    });
  }
  // About the review's own worktree, which is discarded: a move invalidates what it reviewed.
  if (teardown.moved && outcome.error === null)
    return { ...outcome, error: `the review moved its worktree off ${sha.slice(0, 7)}` };
  return outcome;
}
