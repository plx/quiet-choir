/**
 * Pure parts of the reconciled `quiet-choir/github` writes
 * ([ADR 0046](../../docs/decisions/0046-reconciled-github-writes.md)) and the pull request and
 * check writes ([ADR 0047](../../docs/decisions/0047-pull-request-writes-and-head-pinned-merge.md)):
 * the marker, the request builders and their stdin bodies, the response and result schemas, and the
 * decisions each write makes from its reads. No I/O, clock or process access; an ESLint block enforces it. The step
 * callbacks in `github-writes.ts` run the commands and call these functions.
 *
 * Response schemas list their enums and union branches in the order that makes a `--dry-run`
 * synthesis take the write path: an open issue, an unresolved thread, an unlinked sub-issue.
 */
import { z } from '../index.js';
import {
  apiArgv,
  graphqlArgv,
  INCOMPLETE_COLLECTION_PARAM,
  type GithubRepo,
} from './github-model.js';

// ---------------------------------------------------------------------------------------------
// Options and results

/** Arguments of `comment`. */
export interface GithubCommentOptions {
  /** Issue or pull request number. */
  readonly number: number;
  /** Markdown body, nonempty and without NUL; the marker is appended after a blank line. */
  readonly body: string;
}

/** Arguments of `thread.reply`. */
export interface GithubThreadReplyOptions {
  /** The review thread's GraphQL node ID, such as `PRRT_...` from `pr.reviewThreads`. */
  readonly threadId: string;
  /** Markdown body, nonempty and without NUL; the marker is appended after a blank line. */
  readonly body: string;
  /**
   * Resolve the thread after replying. Defaults to whether the thread's first comment is by a bot:
   * bot threads are resolved, human threads stay open for their author. `false` never unresolves
   * a thread that is already resolved.
   */
  readonly resolve?: boolean;
}

/** Arguments of `issue.create`. */
export interface GithubIssueCreateOptions {
  /** Title, nonempty and without NUL. */
  readonly title: string;
  /** Markdown body, nonempty and without NUL; the marker is appended after a blank line. */
  readonly body: string;
  /** Label names to set on creation; each nonempty. */
  readonly labels?: readonly string[];
  /** An issue number in the same repository to make the new issue a sub-issue of. */
  readonly parent?: number;
}

/** How `issue.close` closes an issue. */
export type GithubIssueCloseReason = 'completed' | 'not_planned';

/** Arguments of `issue.close`. */
export interface GithubIssueCloseOptions {
  /** Issue number. */
  readonly number: number;
  /** A comment posted, reconciled by its marker, just before the issue is closed. */
  readonly comment?: string;
  /** State reason, default `completed`. */
  readonly reason?: GithubIssueCloseReason;
  /** The precondition: act only when the issue is open. The only allowed value, and the default. */
  readonly ifState?: 'open';
}

/** Arguments of `issue.reopen`. */
export interface GithubIssueReopenOptions {
  /** Issue number. */
  readonly number: number;
  /** A comment posted, reconciled by its marker, just before the issue is reopened. */
  readonly comment?: string;
  /** The precondition: act only when the issue is closed. The only allowed value, and the default. */
  readonly ifState?: 'closed';
}

/** A code-scanning dismissal reason, as GitHub spells it. */
export type GithubAlertDismissReason = 'false positive' | 'used in tests' | "won't fix";

/** Arguments of `alert.dismiss`. */
export interface GithubAlertDismissOptions {
  /** Code-scanning alert number. */
  readonly number: number;
  /** Dismissal comment, nonempty; truncated to GitHub's 280 characters. */
  readonly comment: string;
  /**
   * Explicit reason. Without one the reason is `used in tests` for an alert whose most recent
   * instance is in a test-only path (see {@link alertDismissReason}) and `false positive` otherwise.
   */
  readonly reason?: GithubAlertDismissReason;
}

/** Result of `comment`, and the comment of `issue.close` and `issue.reopen`. */
export interface GithubCommentResult {
  /** REST comment ID. */
  readonly id: number;
  /** Web URL. */
  readonly url: string;
  /** Whether this attempt posted it; false when an earlier attempt's marked comment was found. */
  readonly created: boolean;
}

/** Result of `thread.reply`. */
export interface GithubThreadReplyResult {
  /** The reply. */
  readonly comment: {
    /** GraphQL node ID of the reply. */
    readonly id: string;
    /** Web URL. */
    readonly url: string;
  };
  /** Whether this attempt posted the reply; false when the marked reply was found. */
  readonly created: boolean;
  /** Whether the thread is resolved now. */
  readonly resolved: boolean;
}

/** Result of `issue.create`. */
export interface GithubIssueCreateResult {
  /** Issue number. */
  readonly number: number;
  /** Web URL. */
  readonly url: string;
  /** GraphQL node ID. */
  readonly nodeId: string;
  /** Whether this attempt created it; false when an earlier attempt's marked issue was found. */
  readonly created: boolean;
  /** The requested parent, now linked, or null when none was requested. */
  readonly parent: number | null;
}

/** Result of `issue.close` and `issue.reopen`. */
export interface GithubIssueStateResult {
  /** Issue number. */
  readonly number: number;
  /** The issue's state after the op. */
  readonly state: 'OPEN' | 'CLOSED';
  /** GitHub's state reason, such as `COMPLETED`, `NOT_PLANNED` or `REOPENED`, or null. */
  readonly stateReason: string | null;
  /**
   * Whether this attempt changed the state. After a crash it can be false although an earlier
   * attempt of the same step changed it: the retry finds the state no longer matching `ifState`.
   */
  readonly acted: boolean;
  /** The comment, when one was requested and the op acted; otherwise null. */
  readonly comment: GithubCommentResult | null;
}

/** Result of `alert.dismiss`. */
export interface GithubAlertDismissResult {
  /** Alert number. */
  readonly number: number;
  /** The alert's state after the op, such as `dismissed` or `fixed`. */
  readonly state: string;
  /** The dismissal reason, or null when the alert is not dismissed. */
  readonly reason: string | null;
  /** Whether this attempt dismissed it; false for an alert already dismissed or fixed. */
  readonly dismissed: boolean;
}

const commentResult = z.object({
  id: z.int().nonnegative(),
  url: z.string(),
  created: z.boolean(),
});

/** Step schema of `comment`. @internal */
export const commentResultSchema: z.ZodType<GithubCommentResult> = commentResult;

/** Step schema of `thread.reply`. @internal */
export const threadReplyResultSchema: z.ZodType<GithubThreadReplyResult> = z.object({
  comment: z.object({ id: z.string(), url: z.string() }),
  created: z.boolean(),
  resolved: z.boolean(),
});

/** Step schema of `issue.create`. @internal */
export const issueCreateResultSchema: z.ZodType<GithubIssueCreateResult> = z.object({
  number: z.int().positive(),
  url: z.string(),
  nodeId: z.string(),
  created: z.boolean(),
  parent: z.int().positive().nullable(),
});

/** Step schema of `issue.close` and `issue.reopen`. @internal */
export const issueStateResultSchema: z.ZodType<GithubIssueStateResult> = z.object({
  number: z.int().positive(),
  state: z.enum(['OPEN', 'CLOSED']),
  stateReason: z.string().nullable(),
  acted: z.boolean(),
  comment: commentResult.nullable(),
});

/** Step schema of `alert.dismiss`. @internal */
export const alertDismissResultSchema: z.ZodType<GithubAlertDismissResult> = z.object({
  number: z.int().positive(),
  state: z.string(),
  reason: z.string().nullable(),
  dismissed: z.boolean(),
});

// ---------------------------------------------------------------------------------------------
// Marker

/** GitHub's limit on an issue, comment or reply body, in characters. @internal */
export const GITHUB_BODY_LIMIT = 65_536;

/** A step's idempotency key: a run ID and a scoped step ID, which cannot contain `>`. */
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

/**
 * The marker of a write: `<!-- quiet-choir:RUN/STEP -->`, an HTML comment that GitHub does not
 * render. The key is the step's idempotency key; its characters cannot end the comment early.
 * @internal
 */
export function githubMarker(idempotencyKey: string): string {
  if (!keyPattern.test(idempotencyKey))
    throw new Error(`Invalid idempotency key ${JSON.stringify(idempotencyKey)} for a marker.`);
  return `<!-- quiet-choir:${idempotencyKey} -->`;
}

/** Whether `body` carries the exact, full marker of `idempotencyKey`. @internal */
export function hasMarker(body: string | null | undefined, idempotencyKey: string): boolean {
  return typeof body === 'string' && body.includes(githubMarker(idempotencyKey));
}

/** The first item whose body carries the marker. @internal */
export function findMarked<T extends { readonly body?: string | null | undefined }>(
  items: readonly T[],
  idempotencyKey: string,
): T | undefined {
  return items.find((item) => hasMarker(item.body, idempotencyKey));
}

const characters = (value: string): number => Array.from(value).length;

/**
 * Throw unless `body` alone fits GitHub's 65536-character limit; checked before the step opens.
 * The step checks again with its marker, before any write. @internal
 */
export function checkBodyLength(body: string, label: string): void {
  if (characters(body) > GITHUB_BODY_LIMIT)
    throw new Error(`${label} exceeds GitHub's ${String(GITHUB_BODY_LIMIT)}-character limit.`);
}

/**
 * `body`, a blank line and the marker. Throws a plain Error, before any write, when the result
 * exceeds GitHub's 65536-character limit. @internal
 */
export function withMarker(body: string, idempotencyKey: string): string {
  const marked = `${body}\n\n${githubMarker(idempotencyKey)}`;
  const length = characters(marked);
  if (length > GITHUB_BODY_LIMIT)
    throw new Error(
      `GitHub body with its marker is ${String(length)} characters; GitHub accepts at most ${String(GITHUB_BODY_LIMIT)}.`,
    );
  return marked;
}

// ---------------------------------------------------------------------------------------------
// Decisions

/**
 * Whether `thread.reply` resolves the thread: `resolve` when given, otherwise whether the first
 * comment's author is a bot (merge-down's rule). @internal
 */
export function shouldResolve(
  firstAuthor: { readonly __typename: string } | null | undefined,
  resolve: boolean | undefined,
): boolean {
  return resolve ?? firstAuthor?.__typename === 'Bot';
}

/** What `issue.create` does about `parent`. @internal */
export type ParentDecision = 'same' | 'link' | 'different';

/**
 * Compare the issue's current parent with the wanted one by node ID: already linked, unlinked
 * (link it), or linked elsewhere (never moved). @internal
 */
export function parentDecision(
  current: { readonly id: string } | null,
  wanted: { readonly id: string },
): ParentDecision {
  if (current === null) return 'link';
  return current.id === wanted.id ? 'same' : 'different';
}

/** Whether a GraphQL issue state matches the precondition. @internal */
export function stateMatches(state: string, ifState: 'open' | 'closed'): boolean {
  return state === ifState.toUpperCase();
}

/** Whether an alert needs no dismissal: it is already dismissed or fixed. @internal */
export function alertSettled(state: string): boolean {
  return state === 'dismissed' || state === 'fixed';
}

/**
 * Whether a path is test-only: a directory segment is `test`, `tests` or `__tests__`, or the file
 * name ends in `.test` or `.spec` plus `.js`, `.ts`, `.cjs`, `.mjs`, `.cts` or `.mts`. @internal
 */
export function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]s$/u.test(path);
}

/**
 * The reason `alert.dismiss` sends: an explicit `reason` wins; otherwise `used in tests` when the
 * alert's path is test-only (a `test`, `tests` or `__tests__` directory segment, or a
 * `.test`/`.spec` JavaScript or TypeScript file), and `false positive` otherwise, including for an
 * alert without a path.
 */
export function alertDismissReason(
  path: string | null,
  reason?: GithubAlertDismissReason,
): GithubAlertDismissReason {
  if (reason !== undefined) return reason;
  return path !== null && isTestPath(path) ? 'used in tests' : 'false positive';
}

/** GitHub's limit on a code-scanning dismissal comment, in characters. @internal */
export const DISMISS_COMMENT_LIMIT = 280;

/** Truncate a dismissal comment to 280 code points, never splitting a surrogate pair. @internal */
export function truncateDismissComment(comment: string): string {
  const points = Array.from(comment);
  return points.length <= DISMISS_COMMENT_LIMIT
    ? comment
    : points.slice(0, DISMISS_COMMENT_LIMIT).join('');
}

// ---------------------------------------------------------------------------------------------
// Requests

/** One gh command a write runs: argv, and its request body for stdin. @internal */
export interface GithubWriteRequest {
  /** Pure `gh api` argv; never holds the body. */
  readonly argv: [string, ...string[]];
  /** JSON request body, delivered on stdin through `--input -`. */
  readonly input: string;
}

/** A REST write: `gh api [--hostname H] -X METHOD PATH --input -` with a JSON body. @internal */
export function restWrite(
  repo: GithubRepo,
  method: 'POST' | 'PATCH',
  path: string,
  body: Readonly<Record<string, unknown>>,
): GithubWriteRequest {
  return {
    argv: apiArgv(repo, '-X', method, `repos/${repo.owner}/${repo.name}/${path}`, '--input', '-'),
    input: JSON.stringify(body),
  };
}

/** A GraphQL mutation: `gh api [--hostname H] graphql --input -` with `{ query, variables }`. @internal */
export function graphqlWrite(
  repo: GithubRepo,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): GithubWriteRequest {
  return {
    argv: apiArgv(repo, 'graphql', '--input', '-'),
    input: JSON.stringify({ query, variables }),
  };
}

const compact = (query: string): string => query.replace(/\s+/gu, ' ').trim();

/**
 * A review thread with every comment, paginated over `comments` (the only connection, so gh's
 * `--paginate` follows it). @internal
 */
export const THREAD_QUERY: string = compact(`
query($threadId: ID!, $endCursor: String) {
  node(id: $threadId) {
    __typename
    ... on PullRequestReviewThread {
      isResolved
      comments(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id url body author { login __typename } }
      }
    }
  }
}`);

/** Reply to a review thread. @internal */
export const REPLY_MUTATION: string = compact(`
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id url }
  }
}`);

/** Resolve a review thread. @internal */
export const RESOLVE_MUTATION: string = compact(`
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`);

/** An issue's node ID and parent, and the wanted parent's node ID. @internal */
export const PARENT_QUERY: string = compact(`
query($owner: String!, $name: String!, $child: Int!, $parent: Int!) {
  repository(owner: $owner, name: $name) {
    child: issue(number: $child) {
      id number
      parent { id number repository { nameWithOwner } }
    }
    wanted: issue(number: $parent) { id number }
  }
}`);

/** Link a sub-issue, without `replaceParent`. @internal */
export const ADD_SUB_ISSUE_MUTATION: string = compact(`
mutation($issueId: ID!, $subIssueId: ID!) {
  addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
    issue { number }
    subIssue { number }
  }
}`);

/** An issue's state and state reason. @internal */
export const ISSUE_STATE_QUERY: string = compact(`
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { number state stateReason }
  }
}`);

/** The thread read argv; the thread ID goes in as a raw `-f` string. @internal */
export function threadReadArgv(repo: GithubRepo, threadId: string): [string, ...string[]] {
  return apiArgv(
    repo,
    'graphql',
    '--paginate',
    '--slurp',
    '-f',
    `query=${THREAD_QUERY}`,
    '-f',
    `threadId=${threadId}`,
  );
}

/** One page of the viewer's issues in the repository, newest first. @internal */
export function issueListArgv(
  repo: GithubRepo,
  login: string,
  page: number,
): [string, ...string[]] {
  return apiArgv(
    repo,
    `repos/${repo.owner}/${repo.name}/issues?creator=${encodeURIComponent(login)}&state=all&sort=created&direction=desc&per_page=${String(ISSUE_PAGE_SIZE)}&page=${String(page)}`,
  );
}

/** Rows per page of the issue list; a shorter page is the last. @internal */
export const ISSUE_PAGE_SIZE = 100;

/** The parent read argv. @internal */
export function parentReadArgv(
  repo: GithubRepo,
  child: number,
  parent: number,
): [string, ...string[]] {
  return graphqlArgv(repo, PARENT_QUERY, false, {}, { child, parent });
}

/** The issue state read argv. @internal */
export function issueStateArgv(repo: GithubRepo, number: number): [string, ...string[]] {
  return graphqlArgv(repo, ISSUE_STATE_QUERY, false, {}, { number });
}

/** The alert read argv. @internal */
export function alertReadArgv(repo: GithubRepo, number: number): [string, ...string[]] {
  return apiArgv(repo, `repos/${repo.owner}/${repo.name}/code-scanning/alerts/${String(number)}`);
}

// ---------------------------------------------------------------------------------------------
// Response schemas: only the fields used; unknown keys are stripped, so a real response with more
// fields never fails a write that GitHub already committed.

const id = z.int().nonnegative();
const issueNumber = z.int().positive();

/** `POST repos/O/R/issues/N/comments` response. @internal */
export const commentPostResponseSchema = z.object({ id, html_url: z.string() });

/** `thread.reply`'s thread read: every page, the last reporting no next page. @internal */
export const threadReadResponseSchema = z
  .array(
    z.object({
      data: z.object({
        node: z
          .object({
            __typename: z.literal('PullRequestReviewThread'),
            isResolved: z.boolean(),
            comments: z.object({
              pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
              nodes: z.array(
                z.object({
                  id: z.string(),
                  url: z.string(),
                  body: z.string(),
                  author: z.object({ login: z.string(), __typename: z.string() }).nullable(),
                }),
              ),
            }),
          })
          .nullable(),
      }),
    }),
  )
  .min(1)
  .superRefine((pages, ctx) => {
    // gh stopped before the end, for example on a page limit: fail instead of a partial list.
    const last = pages.length - 1;
    if (pages[last]?.data.node?.comments.pageInfo.hasNextPage === true)
      ctx.addIssue({
        code: 'custom',
        message:
          'reviewThread.comments has more items than one read returned (pageInfo.hasNextPage is true).',
        path: [last, 'data', 'node', 'comments', 'pageInfo', 'hasNextPage'],
        params: { [INCOMPLETE_COLLECTION_PARAM]: 'reviewThread.comments' },
      });
  });

/** A validated thread read. @internal */
export type ThreadReadResponse = z.infer<typeof threadReadResponseSchema>;

/** `addPullRequestReviewThreadReply` response. @internal */
export const replyResponseSchema = z.object({
  data: z.object({
    addPullRequestReviewThreadReply: z.object({
      comment: z.object({ id: z.string(), url: z.string() }),
    }),
  }),
});

/** `resolveReviewThread` response. @internal */
export const resolveResponseSchema = z.object({
  data: z.object({
    resolveReviewThread: z.object({ thread: z.object({ isResolved: z.boolean() }) }),
  }),
});

/** One page of the REST issue list; pull requests carry `pull_request`. @internal */
export const issueListPageSchema = z.array(
  z.object({
    number: issueNumber,
    html_url: z.string(),
    node_id: z.string(),
    body: z.string().nullish(),
    pull_request: z.unknown().optional(),
  }),
);

/** `POST repos/O/R/issues` response. @internal */
export const issuePostResponseSchema = z.object({
  number: issueNumber,
  html_url: z.string(),
  node_id: z.string(),
});

const childFields = { id: z.string(), number: issueNumber };

/** The parent read; the unlinked branch comes first, so synthesis takes the link path. @internal */
export const parentReadResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      child: z.union([
        z.object({ ...childFields, parent: z.null() }),
        z.object({
          ...childFields,
          parent: z.object({
            id: z.string(),
            number: issueNumber,
            repository: z.object({ nameWithOwner: z.string() }),
          }),
        }),
      ]),
      wanted: z.object({ id: z.string(), number: issueNumber }),
    }),
  }),
});

/** `addSubIssue` response. @internal */
export const addSubIssueResponseSchema = z.object({
  data: z.object({
    addSubIssue: z.object({
      issue: z.object({ number: issueNumber }),
      subIssue: z.object({ number: issueNumber }),
    }),
  }),
});

/** The issue state read; `OPEN` comes first, so synthesis takes `close`'s write path. @internal */
export const issueStateResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      issue: z.object({
        number: issueNumber,
        state: z.enum(['OPEN', 'CLOSED']),
        stateReason: z.string().nullable(),
      }),
    }),
  }),
});

/** `PATCH repos/O/R/issues/N` response. @internal */
export const issuePatchResponseSchema = z.object({ number: issueNumber });

/** `GET repos/O/R/code-scanning/alerts/N` response. @internal */
export const alertResponseSchema = z.object({
  number: issueNumber,
  state: z.string(),
  dismissed_reason: z.string().nullish(),
  most_recent_instance: z
    .object({ location: z.object({ path: z.string().optional() }).optional() })
    .optional(),
});

/** `PATCH repos/O/R/code-scanning/alerts/N` response. @internal */
export const alertPatchResponseSchema = z.object({
  number: issueNumber,
  state: z.string(),
  dismissed_reason: z.string().nullish(),
});

// ---------------------------------------------------------------------------------------------
// Pull request and check writes (ADR 0047)

/** Arguments of `pr.create`. */
export interface GithubPrCreateOptions {
  /** Head branch in the same repository, without an `OWNER:` prefix; cross-fork heads throw. */
  readonly head: string;
  /** Base branch. */
  readonly base: string;
  /** Title, nonempty and without NUL. */
  readonly title: string;
  /** Markdown body, nonempty and without NUL; the marker is appended after a blank line. */
  readonly body: string;
  /** Open the pull request as a draft; default false. */
  readonly draft?: boolean;
}

/** A pull request's state as the PR writes report it. */
export type GithubPrState = 'open' | 'closed' | 'merged';

/** Result of `pr.create`. */
export interface GithubPrCreateResult {
  /** Pull request number. */
  readonly number: number;
  /** Web URL. */
  readonly url: string;
  /** GraphQL node ID. */
  readonly nodeId: string;
  /** Its state when the step found or created it. */
  readonly state: GithubPrState;
  /**
   * Whether this attempt created it; false when a pull request carrying the step's marker, or an
   * open one for the same head and base, already existed.
   */
  readonly created: boolean;
}

/** Arguments of `pr.edit`; at least one of `title`, `body` and `base` is required. */
export interface GithubPrEditOptions {
  /** Pull request number. */
  readonly number: number;
  /** The full 40-character head SHA the pull request must still have; otherwise nothing changes. */
  readonly expectHead: string;
  /** New title, nonempty and without NUL. */
  readonly title?: string;
  /** New body, nonempty and without NUL; sent as given, without a marker. */
  readonly body?: string;
  /** New base branch. */
  readonly base?: string;
}

/** A field `pr.edit` changes. */
export type GithubPrEditField = 'title' | 'body' | 'base';

/** Result of `pr.edit`. */
export interface GithubPrEditResult {
  /** Pull request number. */
  readonly number: number;
  /** Whether this attempt sent the edit. */
  readonly edited: boolean;
  /**
   * Why nothing was sent: `closed` (closed or merged) or `head-moved` (the head is not
   * `expectHead`); null when the edit was sent or nothing differed.
   */
  readonly reason: 'closed' | 'head-moved' | null;
  /** The head SHA the read observed. */
  readonly head: string;
  /** The fields this attempt changed, in `title`, `body`, `base` order. */
  readonly changed: readonly GithubPrEditField[];
}

/** How `pr.merge` merges. */
export type GithubPrMergeMethod = 'squash' | 'merge' | 'rebase';

/** Arguments of `pr.merge`. */
export interface GithubPrMergeOptions {
  /** Pull request number. */
  readonly number: number;
  /** The full 40-character head SHA to merge; GitHub refuses the merge when the head differs. */
  readonly sha: string;
  /** Merge method, default `squash`. */
  readonly method?: GithubPrMergeMethod;
}

/** Why `pr.merge` did not merge. */
export type GithubPrMergeRefusal = 'head-moved' | 'not-mergeable' | 'closed';

/** Result of `pr.merge`: merged at `sha`, or a refusal as data. */
export type GithubPrMergeResult =
  | {
      /** Merged at `sha`. */
      readonly merged: true;
      /** Pull request number. */
      readonly number: number;
      /** The merge commit, or null when GitHub reports none. */
      readonly mergeCommit: string | null;
      /** The merged head, always `sha`. */
      readonly head: string;
      /**
       * Whether this attempt merged it; false when the pull request was already merged at `sha`,
       * for example by an earlier attempt that crashed before its checkpoint.
       */
      readonly acted: boolean;
    }
  | {
      /** Not merged. */
      readonly merged: false;
      /** Pull request number. */
      readonly number: number;
      /**
       * `head-moved`: the head is not `sha`. `not-mergeable`: GitHub refused (HTTP 405), for
       * example for conflicts, required checks or reviews, a draft or a merge queue. `closed`:
       * closed without merging.
       */
      readonly reason: GithubPrMergeRefusal;
      /** The head SHA the step observed. */
      readonly head: string;
      /** GitHub's message when it refused the merge `PUT`; null when the first read refused. */
      readonly message: string | null;
    };

/** Arguments of `checks.rerunFailed`. */
export interface GithubRerunFailedOptions {
  /** The full 40-character commit SHA whose workflow runs to rerun. */
  readonly sha: string;
  /**
   * The baseline: the run attempt the caller observed failing, a positive integer, default 1.
   * Only failed runs at or below it are rerun; a run whose attempt is past it was rerun already.
   * Pass 2 for a second round after a first rerun.
   */
  readonly attempt?: number;
}

/** A workflow run `checks.rerunFailed` acted on or skipped. */
export interface GithubWorkflowRunRef {
  /** Actions run ID. */
  readonly id: number;
  /** Workflow name, or null. */
  readonly name: string | null;
  /** The run attempt the list reported. */
  readonly attempt: number;
}

/** Result of `checks.rerunFailed`. */
export interface GithubRerunFailedResult {
  /** The failed runs this attempt asked GitHub to rerun (their failed jobs). */
  readonly rerun: readonly GithubWorkflowRunRef[];
  /**
   * Runs past the baseline that failed again or are still running: rerun already, so never rerun
   * again.
   */
  readonly skipped: readonly GithubWorkflowRunRef[];
  /**
   * Whether a later list showed every rerun run queued, running or at a higher attempt; true when
   * nothing was rerun. False after the bounded confirmation found a run unchanged.
   */
  readonly confirmed: boolean;
}

const prState = z.enum(['open', 'closed', 'merged']);

/** Step schema of `pr.create`. @internal */
export const prCreateResultSchema: z.ZodType<GithubPrCreateResult> = z.object({
  number: issueNumber,
  url: z.string(),
  nodeId: z.string(),
  state: prState,
  created: z.boolean(),
});

/** Step schema of `pr.edit`. @internal */
export const prEditResultSchema: z.ZodType<GithubPrEditResult> = z.object({
  number: issueNumber,
  edited: z.boolean(),
  reason: z.enum(['closed', 'head-moved']).nullable(),
  head: z.string(),
  changed: z.array(z.enum(['title', 'body', 'base'])),
});

/** Step schema of `pr.merge`. @internal */
export const prMergeResultSchema: z.ZodType<GithubPrMergeResult> = z.discriminatedUnion('merged', [
  z.object({
    merged: z.literal(true),
    number: issueNumber,
    mergeCommit: z.string().nullable(),
    head: z.string(),
    acted: z.boolean(),
  }),
  z.object({
    merged: z.literal(false),
    number: issueNumber,
    reason: z.enum(['head-moved', 'not-mergeable', 'closed']),
    head: z.string(),
    message: z.string().nullable(),
  }),
]);

const runRef = z.object({ id, name: z.string().nullable(), attempt: z.int().positive() });

/** Step schema of `checks.rerunFailed`. @internal */
export const rerunFailedResultSchema: z.ZodType<GithubRerunFailedResult> = z.object({
  rerun: z.array(runRef),
  skipped: z.array(runRef),
  confirmed: z.boolean(),
});

// Requests

/** `GET repos/O/R/pulls/N`. @internal */
export function pullReadArgv(repo: GithubRepo, number: number): [string, ...string[]] {
  return apiArgv(repo, `repos/${repo.owner}/${repo.name}/pulls/${String(number)}`);
}

/**
 * Every pull request, in any state, from the same-repository branch `head` into `base`. The
 * `head` filter is owner-qualified, so a fork's branch of the same name never matches; both values
 * are URL-encoded, so a branch name cannot add query parameters. Plain `--paginate` without
 * `--slurp`, as for code-scanning alerts: a failed later page leaves the merged array unclosed, so
 * the read rejects instead of returning part of the list. @internal
 */
export function pullListArgv(repo: GithubRepo, head: string, base: string): [string, ...string[]] {
  return apiArgv(
    repo,
    '--paginate',
    `repos/${repo.owner}/${repo.name}/pulls?head=${encodeURIComponent(`${repo.owner}:${head}`)}&base=${encodeURIComponent(base)}&state=all&per_page=100`,
  );
}

/**
 * The head-pinned merge: `PUT repos/O/R/pulls/N/merge` with `merge_method` and `sha` as `-f`
 * fields. Both are validated tokens, never free text, and `sha` stays visible in argv. Never
 * `gh pr merge`, which can enable auto-merge or enqueue the pull request instead. @internal
 */
export function mergeArgv(
  repo: GithubRepo,
  number: number,
  method: GithubPrMergeMethod,
  sha: string,
): [string, ...string[]] {
  return apiArgv(
    repo,
    '-X',
    'PUT',
    `repos/${repo.owner}/${repo.name}/pulls/${String(number)}/merge`,
    '-f',
    `merge_method=${method}`,
    '-f',
    `sha=${sha}`,
  );
}

/** Every workflow run of a commit, one slurped array of pages. @internal */
export function runsListArgv(repo: GithubRepo, sha: string): [string, ...string[]] {
  return apiArgv(
    repo,
    '--paginate',
    '--slurp',
    `repos/${repo.owner}/${repo.name}/actions/runs?head_sha=${sha}&per_page=100`,
  );
}

/** `POST repos/O/R/actions/runs/ID/rerun-failed-jobs`; GitHub answers 201 with no body. @internal */
export function rerunArgv(repo: GithubRepo, runId: number): [string, ...string[]] {
  return apiArgv(
    repo,
    '-X',
    'POST',
    `repos/${repo.owner}/${repo.name}/actions/runs/${String(runId)}/rerun-failed-jobs`,
  );
}

// Response schemas. Head SHAs stay plain strings: a synthesized head is never a SHA, so a
// rehearsed edit or merge reports `head-moved` instead of failing synthesis.

const ref = z.object({ ref: z.string(), sha: z.string() });

/**
 * `GET repos/O/R/pulls/N`. `open` comes first, so a synthesized pull request is open, unmerged
 * and at a head that is not the pinned SHA. @internal
 */
export const pullResponseSchema = z.object({
  number: issueNumber,
  html_url: z.string(),
  node_id: z.string(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  merge_commit_sha: z.string().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  head: ref,
  base: z.object({ ref: z.string() }),
});

/** A validated pull request read. @internal */
export type PullResponse = z.infer<typeof pullResponseSchema>;

/**
 * The pull request list for a head and base. `closed` comes first, so the synthesized row is a
 * closed pull request without the marker and a rehearsed create takes the create path. @internal
 */
export const pullListResponseSchema = z.array(
  z.object({
    number: issueNumber,
    html_url: z.string(),
    node_id: z.string(),
    state: z.enum(['closed', 'open']),
    merged_at: z.string().nullable(),
    body: z.string().nullable(),
  }),
);

/** One row of the pull request list. @internal */
export type PullListRow = z.infer<typeof pullListResponseSchema>[number];

/** `POST repos/O/R/pulls` response. @internal */
export const pullPostResponseSchema = z.object({
  number: issueNumber,
  html_url: z.string(),
  node_id: z.string(),
});

/** `PATCH repos/O/R/pulls/N` response. @internal */
export const pullPatchResponseSchema = z.object({ number: issueNumber });

/**
 * The merge PUT's stdout under `okExitCodes: [0, 1]`: GitHub's success body first, then the error
 * body gh prints on an HTTP error. Newer bodies carry `status` (`"405"`, `"409"`); older ones may
 * not. @internal
 */
export const mergeResponseSchema = z.union([
  z.object({ merged: z.literal(true), sha: z.string(), message: z.string().optional() }),
  z.object({ message: z.string(), status: z.union([z.string(), z.int()]).optional() }),
]);

/** A validated merge response. @internal */
export type MergeResponse = z.infer<typeof mergeResponseSchema>;

/**
 * Every page of a commit's workflow runs. Complete or throw: fewer runs than a page's
 * `total_count` fails as an incomplete collection. More is tolerated, since a run created between
 * pages can repeat a row, and a synthesized list is one row with a count of 0. @internal
 */
export const runsListResponseSchema = z
  .array(
    z.object({
      total_count: z.int().nonnegative(),
      workflow_runs: z.array(
        z.object({
          id,
          name: z.string().nullish(),
          status: z.string().nullish(),
          conclusion: z.string().nullish(),
          run_attempt: z.int().positive(),
        }),
      ),
    }),
  )
  .min(1)
  .superRefine((pages, ctx) => {
    const total = Math.max(...pages.map((page) => page.total_count));
    const listed = pages.reduce((sum, page) => sum + page.workflow_runs.length, 0);
    if (listed < total)
      ctx.addIssue({
        code: 'custom',
        message: `actions.workflowRuns lists ${String(listed)} of ${String(total)} runs.`,
        path: [pages.length - 1, 'workflow_runs'],
        params: { [INCOMPLETE_COLLECTION_PARAM]: 'actions.workflowRuns' },
      });
  });

/** One workflow run of the list. @internal */
export type WorkflowRunRow = z.infer<
  typeof runsListResponseSchema
>[number]['workflow_runs'][number];

// Decisions

/** A list row's state, `merged` when it has a merge time. @internal */
export function pullListState(row: Pick<PullListRow, 'state' | 'merged_at'>): GithubPrState {
  return row.merged_at === null ? row.state : 'merged';
}

/** A pull request read's state. @internal */
export function pullState(pull: Pick<PullResponse, 'state' | 'merged'>): GithubPrState {
  return pull.merged ? 'merged' : pull.state;
}

/** What `pr.create` does with the pull requests listed for its head and base. @internal */
export type CreateDecision<T> =
  | { readonly kind: 'found-marked'; readonly row: T }
  | { readonly kind: 'found-open'; readonly row: T }
  | { readonly kind: 'create' };

/**
 * `pr.create`'s order: a pull request in any state carrying the step's marker (so a step never
 * opens a second one, even after its first was closed), then any open one for the same head and
 * base, whoever opened it; otherwise create. @internal
 */
export function createDecision<
  T extends { readonly body?: string | null | undefined; readonly state: string },
>(rows: readonly T[], idempotencyKey: string): CreateDecision<T> {
  const marked = findMarked(rows, idempotencyKey);
  if (marked !== undefined) return { kind: 'found-marked', row: marked };
  const open = rows.find((row) => row.state === 'open');
  return open === undefined ? { kind: 'create' } : { kind: 'found-open', row: open };
}

/** The fields `pr.edit` wants, null for a field it leaves alone. @internal */
export interface PrEditWanted {
  /** New title. */
  readonly title: string | null;
  /** New body. */
  readonly body: string | null;
  /** New base. */
  readonly base: string | null;
}

/**
 * The fields of `wanted` that differ from the pull request, as the PATCH body and the changed
 * names in `title`, `body`, `base` order. A missing body equals no body. @internal
 */
export function editChanges(
  pull: Pick<PullResponse, 'title' | 'body' | 'base'>,
  wanted: PrEditWanted,
): { readonly changed: GithubPrEditField[]; readonly patch: Record<string, string> } {
  const current: Record<GithubPrEditField, string> = {
    title: pull.title,
    body: pull.body ?? '',
    base: pull.base.ref,
  };
  const changed: GithubPrEditField[] = [];
  const patch: Record<string, string> = {};
  for (const field of ['title', 'body', 'base'] as const) {
    const value = wanted[field];
    if (value === null || value === current[field]) continue;
    changed.push(field);
    patch[field] = value;
  }
  return { changed, patch };
}

/** What `pr.merge` does after reading the pull request. @internal */
export type MergePrecheck = 'merged' | 'merged-elsewhere' | 'closed' | 'head-moved' | 'put';

/**
 * Merged at `sha` is success with no PUT (an earlier attempt may have merged it); merged at
 * another head refuses; closed and a moved head are refusals as data; otherwise PUT. @internal
 */
export function mergePrecheck(
  pull: Pick<PullResponse, 'state' | 'merged' | 'head'>,
  sha: string,
): MergePrecheck {
  if (pull.merged) return pull.head.sha === sha ? 'merged' : 'merged-elsewhere';
  if (pull.state !== 'open') return 'closed';
  return pull.head.sha === sha ? 'put' : 'head-moved';
}

/** What a refused PUT means after the pull request is read again. @internal */
export type MergeFailure = Exclude<MergePrecheck, 'put'> | 'not-mergeable' | 'unknown';

/**
 * Classify a refused PUT from the re-read and GitHub's error body: the re-read wins (merged at
 * `sha` is success, elsewhere refuses, closed, head moved); then status 409 is `head-moved` and
 * 405 `not-mergeable`. Anything else, such as 403, 404, 422 or a body without status, is
 * `unknown`: never claimed not mergeable without GitHub saying so. @internal
 */
export function mergeFailure(
  error: { readonly status?: string | number | undefined },
  reread: Pick<PullResponse, 'state' | 'merged' | 'head'>,
  sha: string,
): MergeFailure {
  const settled = mergePrecheck(reread, sha);
  if (settled !== 'put') return settled;
  const status = error.status === undefined ? null : String(error.status);
  if (status === '409') return 'head-moved';
  if (status === '405') return 'not-mergeable';
  return 'unknown';
}

/** Every run once, by ID, across the pages. @internal */
export function uniqueRuns(
  pages: readonly { readonly workflow_runs: readonly WorkflowRunRow[] }[],
): WorkflowRunRow[] {
  const byId = new Map<number, WorkflowRunRow>();
  for (const page of pages) for (const run of page.workflow_runs) byId.set(run.id, run);
  return [...byId.values()];
}

const failed = (run: WorkflowRunRow): boolean =>
  run.status === 'completed' && run.conclusion === 'failure';

/** A run as a result reference. @internal */
export function runRefOf(run: WorkflowRunRow): GithubWorkflowRunRef {
  return { id: run.id, name: run.name ?? null, attempt: run.run_attempt };
}

/**
 * Which runs `checks.rerunFailed` reruns: completed with conclusion `failure` at or below the
 * baseline `attempt`. Runs past the baseline that failed again or are still running are
 * `skipped`: they were rerun already. Successful, cancelled and other runs are neither. @internal
 */
export function rerunSelection(
  runs: readonly WorkflowRunRow[],
  attempt: number,
): { readonly rerun: WorkflowRunRow[]; readonly skipped: WorkflowRunRow[] } {
  return {
    rerun: runs.filter((run) => failed(run) && run.run_attempt <= attempt),
    skipped: runs.filter(
      (run) => run.run_attempt > attempt && (failed(run) || run.status !== 'completed'),
    ),
  };
}

/**
 * Whether every rerun run now shows the rerun: not completed (queued or running) or at a higher
 * attempt than the one rerun. @internal
 */
export function rerunConfirmed(
  runs: readonly WorkflowRunRow[],
  rerun: readonly GithubWorkflowRunRef[],
): boolean {
  return rerun.every((wanted) => {
    const run = runs.find((candidate) => candidate.id === wanted.id);
    return run !== undefined && (run.status !== 'completed' || run.run_attempt > wanted.attempt);
  });
}
