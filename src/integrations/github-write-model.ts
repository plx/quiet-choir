/**
 * Pure parts of the reconciled `quiet-choir/github` writes
 * ([ADR 0046](../../docs/decisions/0046-reconciled-github-writes.md)): the marker, the request
 * builders and their stdin bodies, the response and result schemas, and the decisions each write
 * makes from its reads. No I/O, clock or process access; an ESLint block enforces it. The step
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
