// The Prepare stage's reads through quiet-choir/github, and the state files rendered from them. The
// native helper's `prepare` and `state` subcommands, minus the relay: each read is one durable exec
// keyed by the PR (and its head, where a later round reads again), and each file one ctx.writeFile.
import { dirname, join, resolve } from 'node:path';
import { z, type WorkflowContext } from 'quiet-choir';
import type {
  GithubClient,
  GithubCodeScanningAlert,
  GithubIssueWithComments,
  GithubPullRequest,
  GithubPullRequestSummary,
  GithubRepoInfo,
  GithubReviewThread,
  ReviewerBot,
} from 'quiet-choir/github';
import type { Paths } from './git.js';
import {
  isDependency,
  laterInStack,
  linkedIssue,
  type LinkedIssue,
  type StackEntry,
} from './policy.js';
import { isCodexThread, renderBody, renderIssue, renderStack, renderThreads } from './state.js';

const policy = { retry: { maxAttempts: 3, on: ['process', 'timeout'] as const } };

/** Resolve the repository: the input's, or the current checkout's GitHub repository. */
export async function resolveRepo(ctx: WorkflowContext, repo: string | undefined): Promise<string> {
  if (repo !== undefined) return repo;
  const viewed = await ctx.exec.json('repo', ['gh', 'repo', 'view', '--json', 'nameWithOwner'], {
    schema: z.object({ nameWithOwner: z.string() }),
  });
  return viewed.nameWithOwner;
}

/** The run's paths: the input root, or `<main checkout>-merge-down-package` beside the checkout. */
export async function resolvePaths(
  ctx: WorkflowContext,
  root: string | undefined,
  pr: number,
): Promise<Paths> {
  let base = root === undefined ? null : resolve(ctx.cwd, root);
  if (base === null) {
    const common = await ctx.exec('git-common-dir', [
      'git',
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    base = `${dirname(common.stdout.trim())}-merge-down-package`;
  }
  return {
    root: base,
    workdir: join(base, 'worktree'),
    stateDir: join(base, 'state'),
    dir: join(base, 'state', `pr-${String(pr)}`),
  };
}

/** The linked issue with its title, state and URL, as the ledger records it. */
export interface Issue extends LinkedIssue {
  readonly title: string;
  readonly state: string;
  readonly url: string;
}

/** Everything Prepare learned about the PR. */
export interface Prepared {
  readonly info: GithubRepoInfo;
  readonly pr: GithubPullRequest;
  readonly issue: Issue | null;
  readonly parent: { readonly number: number | null; readonly state: string | null } | null;
  readonly children: readonly GithubPullRequestSummary[];
  readonly open: readonly GithubPullRequestSummary[];
  readonly later: readonly StackEntry[];
  readonly threads: readonly GithubReviewThread[];
  readonly alerts: readonly GithubCodeScanningAlert[];
}

/**
 * Snapshot the PR, its linked issue, parent, children, the stack above it, its review threads and
 * open code-scanning alerts, and write body.md, issue.md, stack.md and threads.md into `paths.dir`.
 */
export async function preparePr(
  ctx: WorkflowContext,
  gh: GithubClient,
  input: { readonly number: number; readonly paths: Paths },
): Promise<Prepared> {
  const { number, paths } = input;
  const info = await gh.repo.info('repo-info', policy);
  const pr = await gh.pr.view(ctx.id('pr', number), { number }, policy);
  const write = (name: string, content: string) =>
    ctx.writeFile(ctx.id('state', number, name), join(paths.dir, name), content, {
      allowOutsideCwd: true,
    });
  await write('body.md', renderBody(pr));

  const link = linkedIssue(pr, info.nameWithOwner);
  let issue: Issue | null = null;
  let issueDoc: GithubIssueWithComments | null = null;
  if (link !== null) {
    // A number from a body keyword or a branch name may name a pull request, which issue.view rejects.
    const kind = await ctx.exec.json(
      ctx.id('issue-kind', link.number),
      [
        'gh',
        'api',
        `repos/${info.nameWithOwner}/issues/${String(link.number)}`,
        '--jq',
        '{pullRequest: (.pull_request != null)}',
      ],
      { schema: z.object({ pullRequest: z.boolean() }), ...policy },
    );
    if (!kind.pullRequest) {
      issueDoc = await gh.issue.view(
        ctx.id('issue', link.number),
        { number: link.number, comments: true },
        policy,
      );
      issue = { ...link, title: issueDoc.title, state: issueDoc.state, url: issueDoc.url };
    }
  }
  await write('issue.md', renderIssue(issueDoc));

  let parent: Prepared['parent'] = null;
  if (pr.baseRefName !== info.defaultBranch) {
    const found = await gh.pr.list(
      ctx.id('parent', number),
      { head: pr.baseRefName, state: 'all' },
      policy,
    );
    const newest = found.at(-1);
    parent = newest
      ? { number: newest.number, state: newest.state }
      : { number: null, state: null };
  }
  const children = await gh.pr.list(
    ctx.id('children', number),
    { base: pr.headRefName, state: 'open' },
    policy,
  );
  const open = await gh.pr.list(ctx.id('open', number), { state: 'open' }, policy);
  const later = laterInStack(open, pr.headRefName);
  await write('stack.md', renderStack(later));

  const { threads, alerts } = await readThreads(ctx, gh, {
    number,
    paths,
    key: pr.headRefOid,
  });
  return { info, pr, issue, parent, children, open, later, threads, alerts };
}

/**
 * Read the review threads and the open code-scanning alerts on the PR's merge ref under occurrence
 * IDs keyed by `key` (a head SHA, or a round), and rewrite threads.md.
 */
export async function readThreads(
  ctx: WorkflowContext,
  gh: GithubClient,
  input: { readonly number: number; readonly paths: Paths; readonly key: string },
): Promise<{ threads: GithubReviewThread[]; alerts: readonly GithubCodeScanningAlert[] }> {
  const { number, paths, key } = input;
  const threads = await gh.pr.reviewThreads(
    ctx.id('threads', number, key),
    { number },
    { ...policy, maxOutputBytes: 16 * 1024 * 1024 },
  );
  const scan = await gh.codeScanning.alerts(
    ctx.id('alerts', number, key),
    { ref: `refs/pull/${String(number)}/merge` },
    policy,
  );
  await ctx.writeFile(
    ctx.id('state', number, 'threads.md', key),
    join(paths.dir, 'threads.md'),
    renderThreads(threads, scan.alerts),
    { allowOutsideCwd: true },
  );
  return { threads, alerts: scan.alerts };
}

/** The native state summary of the PR (`prepared.pr` in an `until: prepare` stop). */
export interface PrSummary {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly isDependency: boolean;
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly mergeable: string;
  readonly issue: Issue | null;
  readonly parent: Prepared['parent'];
  readonly children: readonly { readonly pr: number; readonly headRef: string }[];
  readonly ci: {
    readonly state: string;
    readonly failed: readonly string[];
    readonly pending: readonly string[];
    readonly passed: number;
  };
  readonly codex: { readonly reviewed: boolean; readonly unresolvedThreads: number };
  readonly otherUnresolvedThreads: number;
  readonly untriagedThreads: number;
  readonly openAlerts: readonly number[];
  readonly laterInStack: number;
  readonly files: Readonly<Record<'dir' | 'stack' | 'body' | 'issue' | 'threads', string>>;
}

/** Summarize what Prepare read, in the native helper's `state` shape. */
export function summary(prepared: Prepared, paths: Paths): PrSummary {
  const { pr, threads, alerts, info } = prepared;
  const open = threads.filter((t) => !t.isResolved);
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    isDependency: isDependency(pr.headRefName),
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    headSha: pr.headRefOid,
    mergeable: pr.mergeable,
    issue: prepared.issue,
    parent: prepared.parent,
    children: prepared.children.map((c) => ({ pr: c.number, headRef: c.headRefName })),
    ci: {
      state: pr.checks.state,
      failed: pr.checks.failed,
      pending: pr.checks.pending,
      passed: pr.checks.passed,
    },
    codex: {
      reviewed: threads.some(isCodexThread),
      unresolvedThreads: open.filter(isCodexThread).length,
    },
    otherUnresolvedThreads: open.filter((t) => !isCodexThread(t)).length,
    untriagedThreads: open.filter((t) => (t.lastAuthor ?? t.author) !== info.viewer).length,
    openAlerts: alerts.map((x) => x.number),
    laterInStack: prepared.later.length,
    files: {
      dir: paths.dir,
      stack: join(paths.dir, 'stack.md'),
      body: join(paths.dir, 'body.md'),
      issue: join(paths.dir, 'issue.md'),
      threads: join(paths.dir, 'threads.md'),
    },
  };
}

/**
 * The reviewer a `ci: 'ignore'` gate waits for in place of `codeqlReviewer()` (#738): clean at once,
 * since no code-scanning analysis can be published without CI. The reviewer wait itself still reads
 * the unresolved threads and the open alerts, which the gate and land keep guarding.
 */
export const CI_IGNORED_REVIEWER: ReviewerBot = Object.freeze({
  name: 'ci-ignored',
  login: 'quiet-choir[ci-ignored]',
  reads: [],
  identity: { ciIgnored: 1 },
  observe: () => ({ status: 'clean' as const }),
});
