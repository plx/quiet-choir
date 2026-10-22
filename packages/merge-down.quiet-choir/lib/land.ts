// The merge at land as one durable step. Its guards (the PR's state, head and base, the CI rollup,
// unanswered review threads and open code-scanning alerts) are read inside the step, right before
// the REST merge pinned to the gated head. Every attempt, a retry's or a resumed run's included,
// therefore merges only on reads it took itself, never on reads checkpointed before an earlier
// attempt failed. The queries match the response schemas `quiet-choir/github` exports.
import { setTimeout as delay } from 'node:timers/promises';
import { z, type WorkflowContext } from 'quiet-choir';
import {
  codeScanningResponseSchema,
  parseGithubRepo,
  pullRequestHeadResponseSchema,
  reviewThreadsResponseSchema,
  summarizeChecks,
  type RawCodeScanningAlert,
  type RawReviewThread,
} from 'quiet-choir/github';
import { Landed } from '../contracts.js';

const compact = (query: string): string => query.replace(/\s+/gu, ' ').trim();

/** The PR's state, head and last commit's check rollup (`pr.head` of the GitHub helpers). */
const PR_HEAD_QUERY = compact(`
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number state headRefOid
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun {
                    name status conclusion detailsUrl checkSuite { workflowRun { databaseId } }
                  }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}`);

/** Every review thread with up to 100 comments each (`pr.reviewThreads` of the GitHub helpers). */
const REVIEW_THREADS_QUERY = compact(`
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes { databaseId author { login __typename } body url createdAt }
          }
        }
      }
    }
  }
}`);

/** The REST pull request fields the merge precheck reads. */
const Pull = z.object({
  state: z.string(),
  merged: z.boolean(),
  merge_commit_sha: z.string().nullable(),
  head: z.object({ sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

/** GitHub's answer to the merge PUT: the merge, or its error body (gh exits 1 and prints it). */
const MergeResponse = z.union([
  z.object({ merged: z.literal(true), sha: z.string() }),
  z.object({ message: z.string(), status: z.union([z.string(), z.int()]).optional() }),
]);

/** Reads after a merge until the PR reports it, and the pause between them. */
const CONFIRM_READS = 10;
const CONFIRM_DELAY_MS = 2_000;

/** A thread's first and last comment authors, as `pr.reviewThreads` maps them. */
function authors(thread: RawReviewThread): { first: string; last: string } {
  const logins = thread.comments.nodes.map((c) => c.author?.login ?? 'ghost');
  return { first: logins[0] ?? 'ghost', last: logins.at(-1) ?? 'ghost' };
}

/** The first line of a thread, with a priority badge shown as `[P1]` and no bold markers. */
function threadTitle(thread: RawReviewThread): string {
  const body = thread.comments.nodes[0]?.body ?? '';
  const first = body.split('\n').find((line) => line.trim().length > 0) ?? '';
  return first
    .replace(/<sub><sub>!\[(P\d) Badge\]\([^)]*\)<\/sub><\/sub>/u, '[$1]')
    .replaceAll('**', '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The input of {@link landMerge}. */
export interface LandInput {
  /** `OWNER/REPO` or `HOST/OWNER/REPO`. */
  readonly repo: string;
  readonly pr: number;
  /** The gated head, the only SHA the merge may land. */
  readonly head: string;
  /** The branch the PR must target. */
  readonly base: string;
  /** The login whose last word on a thread counts as an answer. */
  readonly viewer: string;
  /** Names of the checks that must be on the head at landing, whatever else CI reports. */
  readonly requiredChecks: readonly string[];
}

/**
 * Check the landing guards and squash-merge the PR at `head`, in one step. A PR already merged at
 * `head` is reported merged (`acted: false`), so a retry after a merge whose answer was lost finds
 * it. Any guard that fails (the PR closed, merged at another head, moved, retargeted, a CI rollup
 * of another commit, CI pending or failed or lacking a required check, a thread whose last comment is not the viewer's, an open alert) and a merge GitHub refuses
 * return `merged: false` with the reason. A failed read or merge command fails the attempt; it is
 * retried, and a resumed run runs the step again, each time from the guard reads.
 */
export function landMerge(ctx: WorkflowContext, id: string, input: LandInput): Promise<Landed> {
  return ctx.step(id, {
    identity: 'version',
    version: 'merge-down.land/2',
    input: { ...input },
    schema: Landed,
    retry: { maxAttempts: 3, on: ['process', 'timeout'] },
    async run(context): Promise<Landed> {
      const repo = parseGithubRepo(input.repo);
      const slug = `repos/${repo.owner}/${repo.name}`;
      const api = (...rest: string[]): [string, ...string[]] => [
        'gh',
        'api',
        ...(repo.host === null ? [] : ['--hostname', repo.host]),
        ...rest,
      ];
      const graphql = (query: string, paginated: boolean): [string, ...string[]] =>
        api(
          'graphql',
          ...(paginated ? ['--paginate', '--slurp'] : []),
          '-f',
          `query=${query}`,
          '-f',
          `owner=${repo.owner}`,
          '-f',
          `name=${repo.name}`,
          '-F',
          `number=${String(input.pr)}`,
        );
      const pullPath = `${slug}/pulls/${String(input.pr)}`;
      const readPull = () => context.exec.json(api(pullPath), { schema: Pull });
      const refuse = (reason: string): Landed => ({ merged: false, reason });

      const pull = await readPull();
      if (pull.merged)
        return pull.head.sha === input.head
          ? { merged: true, mergeCommit: pull.merge_commit_sha, acted: false }
          : refuse(`merged at ${pull.head.sha}, not at the gated head ${input.head}`);
      if (pull.state !== 'open') return refuse(`PR is ${pull.state.toUpperCase()}`);
      if (pull.head.sha !== input.head) return refuse(`head moved to ${pull.head.sha}`);
      if (pull.base.ref !== input.base)
        return refuse(`base is ${pull.base.ref}, expected ${input.base}`);

      const rollup = (
        await context.exec.json(graphql(PR_HEAD_QUERY, false), {
          schema: pullRequestHeadResponseSchema,
        })
      ).data.repository.pullRequest;
      if (rollup.headRefOid !== input.head) return refuse(`head moved to ${rollup.headRefOid}`);
      // The rollup belongs to the PR's last commit; a lagging read may still show another commit.
      const last = rollup.commits.nodes.at(-1)?.commit;
      if (last?.oid !== input.head)
        return refuse(
          `CI rollup is for ${last?.oid ?? 'no commit'}, not the gated head ${input.head}`,
        );
      const checks = summarizeChecks(last.statusCheckRollup?.contexts.nodes ?? []);
      if (checks.state === 'failure' || checks.state === 'pending')
        return refuse(
          `CI is ${checks.state} at landing: ${(checks.state === 'failure' ? checks.failed : checks.pending).join(', ')}`,
        );
      const registered = new Set(checks.items.map((item) => item.name));
      const missing = input.requiredChecks.filter((name) => !registered.has(name));
      if (missing.length || (checks.state === 'none' && input.requiredChecks.length))
        return refuse(`required checks missing at landing: ${missing.join(', ')}`);

      const pages = await context.exec.json(graphql(REVIEW_THREADS_QUERY, true), {
        schema: reviewThreadsResponseSchema,
        maxOutputBytes: 16 * 1024 * 1024,
      });
      const untriaged = pages
        .flatMap((page) => page.data.repository.pullRequest.reviewThreads.nodes)
        .filter((t) => !t.isResolved && authors(t).last !== input.viewer);
      if (untriaged.length)
        return refuse(
          `unanswered review threads: ${untriaged.map((t) => `${t.id} (${authors(t).first}: ${threadTitle(t)})`).join('; ')}`,
        );

      // gh exits 1 on an HTTP error and prints its body; the schema accepts only "unavailable".
      const ref = encodeURIComponent(`refs/pull/${String(input.pr)}/merge`);
      const scan = await context.exec.json(
        api('--paginate', `${slug}/code-scanning/alerts?ref=${ref}&state=open&per_page=100`),
        { schema: codeScanningResponseSchema, okExitCodes: [0, 1] },
      );
      const alerts = Array.isArray(scan) ? (scan as readonly RawCodeScanningAlert[]) : [];
      if (alerts.length)
        return refuse(
          `open code-scanning alerts on the PR: ${alerts.map((x) => `#${String(x.number)} ${String(x.rule.id)} ${String(x.most_recent_instance.location?.path ?? null)}:${String(x.most_recent_instance.location?.start_line ?? null)}`).join('; ')}`,
        );

      const response = await context.exec.json(
        api(
          '-X',
          'PUT',
          `${pullPath}/merge`,
          '-f',
          'merge_method=squash',
          '-f',
          `sha=${input.head}`,
        ),
        { schema: MergeResponse, okExitCodes: [0, 1] },
      );
      if ('merged' in response) {
        // Wait until the PR says so, so the issue and children reads that follow never see it open.
        for (let read = 1; read <= CONFIRM_READS; read++) {
          if ((await readPull()).merged)
            return { merged: true, mergeCommit: response.sha, acted: true };
          if (read < CONFIRM_READS)
            await delay(CONFIRM_DELAY_MS, undefined, { signal: context.signal });
        }
        throw new Error(
          `GitHub merged #${String(input.pr)} but did not report it merged after ${String(CONFIRM_READS)} reads; a resumed run finds the merge`,
        );
      }
      const after = await readPull();
      if (after.merged && after.head.sha === input.head)
        return { merged: true, mergeCommit: after.merge_commit_sha, acted: false };
      return refuse(
        `GitHub refused the merge${response.status === undefined ? '' : ` (HTTP ${String(response.status)})`}: ${response.message}`,
      );
    },
  });
}
