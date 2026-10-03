/**
 * Pure parts of `quiet-choir/github` (ADR 0044): repository specs, `gh api` argv, GraphQL
 * queries, response schemas with their completeness checks, and the mappers from a validated
 * response to a typed result. No I/O, clock or process access; an ESLint block enforces it.
 *
 * Schemas only validate and strip; they never transform. The exec checkpoints the validated raw
 * response, replay re-parses it with the same schema, and the mappers run after the exec and on
 * replay alike.
 */
import { z } from '../index.js';

// ---------------------------------------------------------------------------------------------
// Repository specs and argv

/** A parsed `OWNER/REPO` or `HOST/OWNER/REPO` repository spec. */
export interface GithubRepo {
  /** Host passed to `gh api --hostname`, or null for gh's default host (`GH_HOST` or github.com). */
  readonly host: string | null;
  /** Repository owner. */
  readonly owner: string;
  /** Repository name. */
  readonly name: string;
  /** `OWNER/REPO`, without the host. */
  readonly nameWithOwner: string;
}

const segmentPattern = /^[A-Za-z0-9_.-]+$/u;
const hostLabelPattern = /^[A-Za-z0-9-]+$/u;

function validSegment(segment: string): boolean {
  return segmentPattern.test(segment) && !segment.startsWith('-') && !/^\.+$/u.test(segment);
}

function validHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  return host
    .split('.')
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        hostLabelPattern.test(label) &&
        !label.startsWith('-') &&
        !label.endsWith('-'),
    );
}

/**
 * Parse `OWNER/REPO` or `HOST/OWNER/REPO`. Owner and name segments use `[A-Za-z0-9_.-]`, never
 * start with `-` and are not all dots; the host must be a hostname. Throws on anything else, so a
 * spec can never smuggle a flag or a path into `gh` argv.
 */
export function parseGithubRepo(spec: string): GithubRepo {
  const invalid = (reason: string): Error =>
    new Error(
      `Invalid GitHub repository ${JSON.stringify(spec)}: ${reason}. Use OWNER/REPO or HOST/OWNER/REPO.`,
    );
  if (typeof spec !== 'string') throw invalid('expected a string');
  const parts = spec.split('/');
  if (parts.length !== 2 && parts.length !== 3)
    throw invalid('expected two or three slash-separated parts');
  const [owner = '', name = ''] = parts.slice(-2);
  const host = parts.length === 3 ? (parts[0] ?? '') : null;
  if (!validSegment(owner) || !validSegment(name))
    throw invalid(
      'owner and name must use letters, digits, ".", "_" or "-" and not start with "-"',
    );
  if (host !== null && !validHost(host)) throw invalid('the host must be a hostname');
  return { host, owner, name, nameWithOwner: `${owner}/${name}` };
}

/**
 * `gh api` argv for a repository: `--hostname HOST` follows `api` only for a host-qualified spec.
 * @internal
 */
export function apiArgv(repo: GithubRepo, ...rest: readonly string[]): [string, ...string[]] {
  return ['gh', 'api', ...(repo.host === null ? [] : ['--hostname', repo.host]), ...rest];
}

/**
 * One GraphQL read: `-f` for strings, `-F` for numbers, `--paginate --slurp` when paginated.
 * @internal
 */
export function graphqlArgv(
  repo: GithubRepo,
  query: string,
  paginated: boolean,
  strings: Readonly<Record<string, string | undefined>>,
  numbers: Readonly<Record<string, number>> = {},
): [string, ...string[]] {
  return apiArgv(
    repo,
    'graphql',
    ...(paginated ? ['--paginate', '--slurp'] : []),
    '-f',
    `query=${query}`,
    '-f',
    `owner=${repo.owner}`,
    '-f',
    `name=${repo.name}`,
    ...Object.entries(strings).flatMap(([key, value]) =>
      value === undefined ? [] : ['-f', `${key}=${value}`],
    ),
    ...Object.entries(numbers).flatMap(([key, value]) => ['-F', `${key}=${String(value)}`]),
  );
}

// ---------------------------------------------------------------------------------------------
// Queries
//
// gh's GraphQL `--paginate` follows the first `pageInfo { hasNextPage endCursor }` in the response,
// which is document order. A paginated query therefore declares `$endCursor: String`, passes
// `after: $endCursor` to exactly one connection, and requests that connection's pageInfo before
// its nodes and before every other connection. Nested connections request only `hasNextPage`;
// the response schemas fail a read when any of them reports more.

const compact = (query: string): string => query.replace(/\s+/gu, ' ').trim();

const commentFields = 'databaseId author { login __typename } body url createdAt';

/** Viewer and repository facts. @internal */
export const REPO_INFO_QUERY: string = compact(`
query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner isPrivate viewerPermission defaultBranchRef { name }
  }
}`);

/** The last commit's SHA and check rollup, shared by `pr.view` and the waits' `pr.head`. */
const lastCommitRollup = `
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
      }`;

/** One pull request with its closing issues and the last commit's check rollup. @internal */
export const PR_VIEW_QUERY: string = compact(`
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url body state isDraft mergeable mergeStateStatus
      headRefOid headRefName baseRefName
      closingIssuesReferences(first: 100) {
        pageInfo { hasNextPage }
        nodes { number repository { nameWithOwner } }
      }
      ${lastCommitRollup}
    }
  }
}`);

/** Pull request states `pr.list` filters by; `all` applies no filter. */
export type GithubPrListState = 'open' | 'closed' | 'merged' | 'all';

const prListStates: Readonly<Record<GithubPrListState, string | null>> = {
  open: '[OPEN]',
  closed: '[CLOSED]',
  merged: '[MERGED]',
  all: null,
};

/** Every pull request matching the filters, paginated over `pullRequests`. @internal */
export function prListQuery(state: GithubPrListState): string {
  const states = prListStates[state];
  return compact(`
query($owner: String!, $name: String!, $head: String, $base: String, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, headRefName: $head, baseRefName: $base,${states === null ? '' : ` states: ${states},`} after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes { number title state isDraft headRefName baseRefName headRefOid url body }
    }
  }
}`);
}

/** Every review thread of a pull request, with up to 100 comments each. @internal */
export const REVIEW_THREADS_QUERY: string = compact(`
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 100) { pageInfo { hasNextPage } nodes { ${commentFields} } }
        }
      }
    }
  }
}`);

const issueFields = 'number title state body url author { login __typename }';

/** One issue and its labels. @internal */
export const ISSUE_VIEW_QUERY: string = compact(`
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      ${issueFields}
      labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
    }
  }
}`);

/** One issue with every comment, paginated over `comments`, which precede `labels`. @internal */
export const ISSUE_VIEW_COMMENTS_QUERY: string = compact(`
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      ${issueFields}
      comments(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${commentFields} }
      }
      labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
    }
  }
}`);

// ---------------------------------------------------------------------------------------------
// Raw responses

/** A connection's page information; only `hasNextPage` is kept. */
export interface RawPageInfo {
  /** Whether the connection has more items than this response holds. */
  readonly hasNextPage: boolean;
}

/** One page of a GraphQL connection. */
export interface RawConnection<T> {
  /** Page information, checked for completeness. */
  readonly pageInfo: RawPageInfo;
  /** The items of this page. */
  readonly nodes: readonly T[];
}

/** A GraphQL actor. */
export interface RawActor {
  /** Login. */
  readonly login: string;
  /** GraphQL type, such as `User` or `Bot`. */
  readonly __typename: string;
}

/** An issue, pull request or review comment. */
export interface RawComment {
  /** REST database ID. */
  readonly databaseId: number | null;
  /** Author, or null for a deleted account. */
  readonly author: RawActor | null;
  /** Markdown body. */
  readonly body: string;
  /** Web URL. */
  readonly url: string;
  /** ISO 8601 creation time. */
  readonly createdAt: string;
}

/** `repo.info` response. */
export interface RawRepoInfoResponse {
  /** GraphQL data. */
  readonly data: {
    /** The authenticated user. */
    readonly viewer: {
      /** The authenticated login. */
      readonly login: string;
    };
    /** The repository. */
    readonly repository: {
      /** Canonical `OWNER/REPO`. */
      readonly nameWithOwner: string;
      /** Whether the repository is private. */
      readonly isPrivate: boolean;
      /** The viewer's permission, such as `ADMIN` or `READ`. */
      readonly viewerPermission: string | null;
      /** The default branch, or null for an empty repository. */
      readonly defaultBranchRef: {
        /** Branch name. */
        readonly name: string;
      } | null;
    };
  };
}

/** A check run in a status check rollup. */
export interface RawCheckRun {
  /** Discriminator. */
  readonly __typename: 'CheckRun';
  /** Check name. */
  readonly name: string;
  /** Status, such as `QUEUED`, `IN_PROGRESS` or `COMPLETED`. */
  readonly status: string;
  /** Conclusion once completed, such as `SUCCESS` or `FAILURE`. */
  readonly conclusion: string | null;
  /** Details URL. */
  readonly detailsUrl: string | null;
  /** The check suite. */
  readonly checkSuite: {
    /** The Actions workflow run, or null for a check from another app. */
    readonly workflowRun: {
      /** REST ID of the workflow run, as `gh run` uses it. */
      readonly databaseId: number;
    } | null;
  } | null;
}

/** A commit status in a status check rollup. */
export interface RawStatusContext {
  /** Discriminator. */
  readonly __typename: 'StatusContext';
  /** Status context name. */
  readonly context: string;
  /** State, such as `SUCCESS`, `PENDING` or `FAILURE`. */
  readonly state: string;
  /** Target URL. */
  readonly targetUrl: string | null;
}

/** One entry of a status check rollup. */
export type RawCheckContext = RawCheckRun | RawStatusContext;

/** The pull request fields `pr.view` reads. */
export interface RawPullRequest {
  /** Pull request number. */
  readonly number: number;
  /** Title. */
  readonly title: string;
  /** Web URL. */
  readonly url: string;
  /** Markdown body. */
  readonly body: string;
  /** `OPEN`, `CLOSED` or `MERGED`. */
  readonly state: string;
  /** Whether the pull request is a draft. */
  readonly isDraft: boolean;
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
  readonly mergeable: string;
  /** Merge state status, such as `CLEAN`, `BLOCKED` or `BEHIND`. */
  readonly mergeStateStatus: string;
  /** Head commit SHA. */
  readonly headRefOid: string;
  /** Head branch. */
  readonly headRefName: string;
  /** Base branch. */
  readonly baseRefName: string;
  /** Issues the pull request closes on merge. */
  readonly closingIssuesReferences: RawConnection<{
    /** Issue number. */
    readonly number: number;
    /** The issue's repository. */
    readonly repository: {
      /** `OWNER/REPO`. */
      readonly nameWithOwner: string;
    };
  }>;
  /** The last commit. */
  readonly commits: {
    /** Zero or one commit. */
    readonly nodes: readonly {
      /** The commit. */
      readonly commit: {
        /** Commit SHA. */
        readonly oid: string;
        /** Check rollup, or null when the commit has no checks. */
        readonly statusCheckRollup: {
          /** GitHub's own rollup state. */
          readonly state: string;
          /** Check runs and commit statuses. */
          readonly contexts: RawConnection<RawCheckContext>;
        } | null;
      };
    }[];
  };
}

/** `pr.view` response. */
export interface RawPullRequestViewResponse {
  /** GraphQL data. */
  readonly data: {
    /** The repository. */
    readonly repository: {
      /** The pull request. */
      readonly pullRequest: RawPullRequest;
    };
  };
}

/** One pull request row of `pr.list`. */
export interface RawPullRequestRow {
  /** Pull request number. */
  readonly number: number;
  /** Title. */
  readonly title: string;
  /** `OPEN`, `CLOSED` or `MERGED`. */
  readonly state: string;
  /** Whether the pull request is a draft. */
  readonly isDraft: boolean;
  /** Head branch. */
  readonly headRefName: string;
  /** Base branch. */
  readonly baseRefName: string;
  /** Head commit SHA. */
  readonly headRefOid: string;
  /** Web URL. */
  readonly url: string;
  /** Markdown body. */
  readonly body: string;
}

/** One page of `pr.list`. */
export interface RawPullRequestListPage {
  /** GraphQL data. */
  readonly data: {
    /** The repository. */
    readonly repository: {
      /** One page of pull requests. */
      readonly pullRequests: RawConnection<RawPullRequestRow>;
    };
  };
}

/** `pr.list` response: every page `gh api --paginate --slurp` fetched, in order. */
export type RawPullRequestListResponse = readonly RawPullRequestListPage[];

/** One review thread. */
export interface RawReviewThread {
  /** GraphQL node ID, used to reply to or resolve the thread. */
  readonly id: string;
  /** Whether the thread is resolved. */
  readonly isResolved: boolean;
  /** Whether the diff has changed under the thread. */
  readonly isOutdated: boolean;
  /** File path. */
  readonly path: string;
  /** Line in the current diff, or null when outdated or file-level. */
  readonly line: number | null;
  /** Line in the original diff. */
  readonly originalLine: number | null;
  /** The thread's comments. */
  readonly comments: RawConnection<RawComment>;
}

/** One page of `pr.reviewThreads`. */
export interface RawReviewThreadsPage {
  /** GraphQL data. */
  readonly data: {
    /** The repository. */
    readonly repository: {
      /** The pull request. */
      readonly pullRequest: {
        /** One page of review threads. */
        readonly reviewThreads: RawConnection<RawReviewThread>;
      };
    };
  };
}

/** `pr.reviewThreads` response: every page, in order. */
export type RawReviewThreadsResponse = readonly RawReviewThreadsPage[];

/** The issue fields `issue.view` reads. */
export interface RawIssue {
  /** Issue number. */
  readonly number: number;
  /** Title. */
  readonly title: string;
  /** `OPEN` or `CLOSED`. */
  readonly state: string;
  /** Markdown body. */
  readonly body: string;
  /** Web URL. */
  readonly url: string;
  /** Author, or null for a deleted account. */
  readonly author: RawActor | null;
  /** Labels. */
  readonly labels: RawConnection<{
    /** Label name. */
    readonly name: string;
  }>;
}

/** `issue.view` response without comments. */
export interface RawIssueViewResponse {
  /** GraphQL data. */
  readonly data: {
    /** The repository. */
    readonly repository: {
      /** The issue. */
      readonly issue: RawIssue;
    };
  };
}

/** One page of `issue.view` with comments. */
export interface RawIssueCommentsPage {
  /** GraphQL data. */
  readonly data: {
    /** The repository. */
    readonly repository: {
      /** The issue, repeated on every page, with one page of comments. */
      readonly issue: RawIssue & {
        /** One page of comments. */
        readonly comments: RawConnection<RawComment>;
      };
    };
  };
}

/** `issue.view` response with comments: every page, in order. */
export type RawIssueCommentsResponse = readonly RawIssueCommentsPage[];

/** One code-scanning alert, as the REST API returns it. */
export interface RawCodeScanningAlert {
  /** Alert number. */
  readonly number: number;
  /** `open`, `dismissed`, `fixed` or `closed`. */
  readonly state: string;
  /** Web URL. */
  readonly html_url: string;
  /** The rule. */
  readonly rule: {
    /** Rule ID, such as `js/bad-code-sanitization`. */
    readonly id: string | null;
    /** Rule severity, such as `error`. */
    readonly severity: string | null;
    /** Security severity, such as `high`, when the rule has one. */
    readonly security_severity_level?: string | null | undefined;
  };
  /** The most recent instance. */
  readonly most_recent_instance: {
    /** Location. */
    readonly location?:
      | {
          /** File path. */
          readonly path?: string | undefined;
          /** First line. */
          readonly start_line?: number | undefined;
        }
      | undefined;
    /** Message. */
    readonly message?:
      | {
          /** Message text. */
          readonly text?: string | undefined;
        }
      | undefined;
  };
}

/** A GitHub REST error body, which `gh api` prints on stdout for an HTTP error. */
export interface RawGithubErrorBody {
  /** Error message. */
  readonly message: string;
}

/**
 * `codeScanning.alerts` response: every alert of every page, merged by gh into one array, or a
 * GitHub error body, accepted only when it says code scanning is unavailable.
 */
export type RawCodeScanningResponse = readonly RawCodeScanningAlert[] | RawGithubErrorBody;

// ---------------------------------------------------------------------------------------------
// Schemas

/** Zod issue param that marks a truncated connection; see `IncompleteCollectionError`. @internal */
export const INCOMPLETE_COLLECTION_PARAM = 'incompleteCollection';

/** Messages GitHub uses when code scanning is not set up for a repository. @internal */
export const CODE_SCANNING_UNAVAILABLE =
  /no analysis found|code scanning is not enabled|advanced security must be enabled/iu;

function incomplete(
  ctx: z.RefinementCtx,
  connection: string,
  path: readonly (string | number)[],
): void {
  ctx.addIssue({
    code: 'custom',
    message: `${connection} has more items than one read returned (pageInfo.hasNextPage is true).`,
    path: [...path],
    params: { [INCOMPLETE_COLLECTION_PARAM]: connection },
  });
}

const pageInfo = z.object({ hasNextPage: z.boolean() });
const connection = <T extends z.ZodType>(node: T) => z.object({ pageInfo, nodes: z.array(node) });
const count = z.int().nonnegative();
const issueNumber = z.int().positive();
const actor = z.object({ login: z.string(), __typename: z.string() });
const comment = z.object({
  databaseId: count.nullable(),
  author: actor.nullable(),
  body: z.string(),
  url: z.string(),
  createdAt: z.string(),
});

/** Schema of the `repo.info` response. */
export const repoInfoResponseSchema: z.ZodType<RawRepoInfoResponse> = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    repository: z.object({
      nameWithOwner: z.string(),
      isPrivate: z.boolean(),
      viewerPermission: z.string().nullable(),
      defaultBranchRef: z.object({ name: z.string() }).nullable(),
    }),
  }),
});

const checkContext = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().nullable(),
    checkSuite: z.object({ workflowRun: z.object({ databaseId: count }).nullable() }).nullable(),
  }),
  z.object({
    __typename: z.literal('StatusContext'),
    context: z.string(),
    state: z.string(),
    targetUrl: z.string().nullable(),
  }),
]);

/** The last commit and its check rollup, as `pr.view` and `pr.head` select it. */
const lastCommit = z.object({
  nodes: z.array(
    z.object({
      commit: z.object({
        oid: z.string(),
        statusCheckRollup: z
          .object({ state: z.string(), contexts: connection(checkContext) })
          .nullable(),
      }),
    }),
  ),
});

/** Flag a truncated check rollup of the last commit. */
function incompleteContexts(
  ctx: z.RefinementCtx,
  commits: RawPullRequest['commits'],
  at: readonly string[],
): void {
  commits.nodes.forEach((node, index) => {
    if (node.commit.statusCheckRollup?.contexts.pageInfo.hasNextPage)
      incomplete(ctx, 'pullRequest.commits.statusCheckRollup.contexts', [
        ...at,
        'commits',
        'nodes',
        index,
        'commit',
        'statusCheckRollup',
        'contexts',
      ]);
  });
}

/** Schema of the `pr.view` response; truncated closing issues or checks fail it. */
export const pullRequestViewResponseSchema: z.ZodType<RawPullRequestViewResponse> = z
  .object({
    data: z.object({
      repository: z.object({
        pullRequest: z.object({
          number: issueNumber,
          title: z.string(),
          url: z.string(),
          body: z.string(),
          state: z.string(),
          isDraft: z.boolean(),
          mergeable: z.string(),
          mergeStateStatus: z.string(),
          headRefOid: z.string(),
          headRefName: z.string(),
          baseRefName: z.string(),
          closingIssuesReferences: connection(
            z.object({
              number: issueNumber,
              repository: z.object({ nameWithOwner: z.string() }),
            }),
          ),
          commits: lastCommit,
        }),
      }),
    }),
  })
  .superRefine((response, ctx) => {
    const pr = response.data.repository.pullRequest;
    const at = ['data', 'repository', 'pullRequest'];
    if (pr.closingIssuesReferences.pageInfo.hasNextPage)
      incomplete(ctx, 'pullRequest.closingIssuesReferences', [...at, 'closingIssuesReferences']);
    incompleteContexts(ctx, pr.commits, at);
  });

/**
 * The last page of a paginated read must report no next page: otherwise gh stopped before the
 * end, for example because the query's pageInfo ordering misled `--paginate`.
 */
function lastPage<T>(
  ctx: z.RefinementCtx,
  pages: readonly T[],
  connectionOf: (page: T) => RawConnection<unknown>,
  name: string,
  path: readonly (string | number)[],
): void {
  const last = pages.length - 1;
  const page = pages[last];
  if (page !== undefined && connectionOf(page).pageInfo.hasNextPage)
    incomplete(ctx, name, [last, ...path]);
}

/** Schema of the `pr.list` response; every page, the last reporting no next page. */
export const pullRequestListResponseSchema: z.ZodType<RawPullRequestListResponse> = z
  .array(
    z.object({
      data: z.object({
        repository: z.object({
          pullRequests: connection(
            z.object({
              number: issueNumber,
              title: z.string(),
              state: z.string(),
              isDraft: z.boolean(),
              headRefName: z.string(),
              baseRefName: z.string(),
              headRefOid: z.string(),
              url: z.string(),
              body: z.string(),
            }),
          ),
        }),
      }),
    }),
  )
  .min(1)
  .superRefine((pages, ctx) => {
    lastPage(ctx, pages, (page) => page.data.repository.pullRequests, 'repository.pullRequests', [
      'data',
      'repository',
      'pullRequests',
    ]);
  });

/** Schema of the `pr.reviewThreads` response; truncated threads or comments fail it. */
export const reviewThreadsResponseSchema: z.ZodType<RawReviewThreadsResponse> = z
  .array(
    z.object({
      data: z.object({
        repository: z.object({
          pullRequest: z.object({
            reviewThreads: connection(
              z.object({
                id: z.string(),
                isResolved: z.boolean(),
                isOutdated: z.boolean(),
                path: z.string(),
                line: count.nullable(),
                originalLine: count.nullable(),
                comments: connection(comment),
              }),
            ),
          }),
        }),
      }),
    }),
  )
  .min(1)
  .superRefine((pages, ctx) => {
    const at = ['data', 'repository', 'pullRequest', 'reviewThreads'];
    lastPage(
      ctx,
      pages,
      (page) => page.data.repository.pullRequest.reviewThreads,
      'pullRequest.reviewThreads',
      at,
    );
    pages.forEach((page, index) => {
      page.data.repository.pullRequest.reviewThreads.nodes.forEach((thread, position) => {
        if (thread.comments.pageInfo.hasNextPage)
          incomplete(ctx, `pullRequest.reviewThreads[${thread.id}].comments`, [
            index,
            ...at,
            'nodes',
            position,
            'comments',
          ]);
      });
    });
  });

const issueShape = {
  number: issueNumber,
  title: z.string(),
  state: z.string(),
  body: z.string(),
  url: z.string(),
  author: actor.nullable(),
  labels: connection(z.object({ name: z.string() })),
};

function issueLabels(
  ctx: z.RefinementCtx,
  issue: { readonly labels: RawConnection<unknown> },
  path: readonly (string | number)[],
): void {
  if (issue.labels.pageInfo.hasNextPage) incomplete(ctx, 'issue.labels', [...path, 'labels']);
}

/** Schema of the `issue.view` response without comments; truncated labels fail it. */
export const issueViewResponseSchema: z.ZodType<RawIssueViewResponse> = z
  .object({
    data: z.object({ repository: z.object({ issue: z.object(issueShape) }) }),
  })
  .superRefine((response, ctx) => {
    issueLabels(ctx, response.data.repository.issue, ['data', 'repository', 'issue']);
  });

/** Schema of the `issue.view` response with comments; every page, comments complete. */
export const issueCommentsResponseSchema: z.ZodType<RawIssueCommentsResponse> = z
  .array(
    z.object({
      data: z.object({
        repository: z.object({
          issue: z.object({ ...issueShape, comments: connection(comment) }),
        }),
      }),
    }),
  )
  .min(1)
  .superRefine((pages, ctx) => {
    const at = ['data', 'repository', 'issue'];
    lastPage(ctx, pages, (page) => page.data.repository.issue.comments, 'issue.comments', [
      ...at,
      'comments',
    ]);
    pages.forEach((page, index) => {
      issueLabels(ctx, page.data.repository.issue, [index, ...at]);
    });
  });

const codeScanningAlert = z.object({
  number: issueNumber,
  state: z.string(),
  html_url: z.string(),
  rule: z.object({
    id: z.string().nullable(),
    severity: z.string().nullable(),
    security_severity_level: z.string().nullish(),
  }),
  most_recent_instance: z.object({
    location: z.object({ path: z.string().optional(), start_line: count.optional() }).optional(),
    message: z.object({ text: z.string().optional() }).optional(),
  }),
});

/**
 * Schema of the `codeScanning.alerts` response: one alert array (every page, merged by gh) or a
 * GitHub error body saying code scanning is unavailable; any other error body fails it. The
 * alert-array branch comes first, so `--dry-run` synthesizes alerts.
 */
export const codeScanningResponseSchema: z.ZodType<RawCodeScanningResponse> = z
  .union([z.array(codeScanningAlert), z.object({ message: z.string() })])
  .superRefine((response, ctx) => {
    if (Array.isArray(response) || CODE_SCANNING_UNAVAILABLE.test(response.message)) return;
    ctx.addIssue({
      code: 'custom',
      message: `GitHub returned an error: ${response.message}`,
      path: ['message'],
    });
  });

// ---------------------------------------------------------------------------------------------
// Results and mappers

/** Repository facts and the authenticated viewer. */
export interface GithubRepoInfo {
  /** Host from the repository spec, or null for gh's default host. */
  readonly host: string | null;
  /** Owner, as GitHub spells it. */
  readonly owner: string;
  /** Name, as GitHub spells it. */
  readonly name: string;
  /** `OWNER/REPO`, as GitHub spells it. */
  readonly nameWithOwner: string;
  /** Default branch, or null for an empty repository. */
  readonly defaultBranch: string | null;
  /** Whether the repository is private. */
  readonly isPrivate: boolean;
  /** The authenticated login. */
  readonly viewer: string;
  /** The viewer's permission, such as `ADMIN` or `READ`. */
  readonly viewerPermission: string | null;
}

/** One check, classified by the rules of {@link summarizeChecks}. */
export interface GithubCheck {
  /** Check run name or status context. */
  readonly name: string;
  /** A check run or a commit status. */
  readonly kind: 'check-run' | 'status';
  /** Classification. */
  readonly outcome: 'passed' | 'failed' | 'pending';
  /** A check run's conclusion, or its status while incomplete; a commit status's state. */
  readonly state: string;
  /** Details or target URL. */
  readonly url: string | null;
  /** Actions workflow run ID, for `gh run`; null for a commit status or another app's check. */
  readonly workflowRunId: number | null;
}

/** Checks of a commit, summarized. */
export interface GithubChecks {
  /** `none` without checks; otherwise `pending` while any is pending, then `failure`, then `success`. */
  readonly state: 'none' | 'pending' | 'failure' | 'success';
  /** Number of passed checks. */
  readonly passed: number;
  /** Names of failed checks. */
  readonly failed: readonly string[];
  /** Names of pending checks. */
  readonly pending: readonly string[];
  /** Every check, in GitHub's order. */
  readonly items: readonly GithubCheck[];
}

/**
 * Classify checks. A commit status passes when `SUCCESS`, is pending when `PENDING` or
 * `EXPECTED`, and fails otherwise. A check run is pending until `COMPLETED`, then passes when
 * its conclusion is `SUCCESS`, `NEUTRAL` or `SKIPPED`, and fails otherwise.
 */
export function summarizeChecks(contexts: readonly RawCheckContext[]): GithubChecks {
  const items = contexts.map((context): GithubCheck => {
    if (context.__typename === 'StatusContext')
      return {
        name: context.context,
        kind: 'status',
        outcome:
          context.state === 'SUCCESS'
            ? 'passed'
            : context.state === 'PENDING' || context.state === 'EXPECTED'
              ? 'pending'
              : 'failed',
        state: context.state,
        url: context.targetUrl,
        workflowRunId: null,
      };
    const completed = context.status === 'COMPLETED';
    return {
      name: context.name,
      kind: 'check-run',
      outcome: !completed
        ? 'pending'
        : ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(context.conclusion ?? '')
          ? 'passed'
          : 'failed',
      state: completed ? (context.conclusion ?? context.status) : context.status,
      url: context.detailsUrl,
      workflowRunId: context.checkSuite?.workflowRun?.databaseId ?? null,
    };
  });
  const named = (outcome: GithubCheck['outcome']) =>
    items.filter((item) => item.outcome === outcome).map((item) => item.name);
  const failed = named('failed');
  const pending = named('pending');
  return {
    state:
      items.length === 0
        ? 'none'
        : pending.length
          ? 'pending'
          : failed.length
            ? 'failure'
            : 'success',
    passed: items.length - failed.length - pending.length,
    failed,
    pending,
    items,
  };
}

/** An issue a pull request closes. */
export interface GithubIssueRef {
  /** Issue number. */
  readonly number: number;
  /** The issue's `OWNER/REPO`. */
  readonly repository: string;
}

/** A pull request with its closing issues and summarized checks. */
export interface GithubPullRequest {
  /** Pull request number. */
  readonly number: number;
  /** Title. */
  readonly title: string;
  /** Web URL. */
  readonly url: string;
  /** Markdown body. */
  readonly body: string;
  /** `OPEN`, `CLOSED` or `MERGED`. */
  readonly state: string;
  /** Whether the pull request is a draft. */
  readonly isDraft: boolean;
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
  readonly mergeable: string;
  /** Merge state status, such as `CLEAN` or `BLOCKED`. */
  readonly mergeStateStatus: string;
  /** Head commit SHA. */
  readonly headRefOid: string;
  /** Head branch. */
  readonly headRefName: string;
  /** Base branch. */
  readonly baseRefName: string;
  /** Issues the pull request closes on merge, in GitHub's order. */
  readonly closingIssues: readonly GithubIssueRef[];
  /** Checks of the head commit. */
  readonly checks: GithubChecks;
}

/** One row of `pr.list`. */
export interface GithubPullRequestSummary {
  /** Pull request number. */
  readonly number: number;
  /** Title. */
  readonly title: string;
  /** `OPEN`, `CLOSED` or `MERGED`. */
  readonly state: string;
  /** Whether the pull request is a draft. */
  readonly isDraft: boolean;
  /** Head branch. */
  readonly headRefName: string;
  /** Base branch. */
  readonly baseRefName: string;
  /** Head commit SHA. */
  readonly headRefOid: string;
  /** Web URL. */
  readonly url: string;
  /** Markdown body. */
  readonly body: string;
}

/** A comment with its author resolved. */
export interface GithubComment {
  /** REST database ID. */
  readonly id: number | null;
  /** Author login, or `ghost` for a deleted account. */
  readonly author: string;
  /** Whether the author is a bot. */
  readonly isBot: boolean;
  /** Markdown body. */
  readonly body: string;
  /** Web URL. */
  readonly url: string;
  /** ISO 8601 creation time. */
  readonly createdAt: string;
}

/** A review thread, described by its first comment. */
export interface GithubReviewThread {
  /** GraphQL node ID. */
  readonly id: string;
  /** Whether the thread is resolved. */
  readonly isResolved: boolean;
  /** Whether the diff has changed under the thread. */
  readonly isOutdated: boolean;
  /** File path. */
  readonly path: string;
  /** Current line, or the original line when outdated; null for a file-level thread. */
  readonly line: number | null;
  /** First comment's author, or `ghost`. */
  readonly author: string;
  /** Whether the first comment's author is a bot. */
  readonly isBot: boolean;
  /** Author of the last comment, or null without comments. */
  readonly lastAuthor: string | null;
  /** Code-scanning alert number linked from the first comment. */
  readonly alert: number | null;
  /** Priority badge of the first comment, such as `P1`. */
  readonly priority: string | null;
  /** First line of the first comment, without badge markup or bold markers. */
  readonly title: string;
  /** First comment's URL. */
  readonly url: string | null;
  /** Every comment, oldest first. */
  readonly comments: readonly GithubComment[];
}

/** An issue with its labels. */
export interface GithubIssue {
  /** Issue number. */
  readonly number: number;
  /** Title. */
  readonly title: string;
  /** `OPEN` or `CLOSED`. */
  readonly state: string;
  /** Markdown body. */
  readonly body: string;
  /** Web URL. */
  readonly url: string;
  /** Author login, or `ghost`. */
  readonly author: string;
  /** Label names. */
  readonly labels: readonly string[];
}

/** An issue with every comment. */
export interface GithubIssueWithComments extends GithubIssue {
  /** Every comment, oldest first. */
  readonly comments: readonly GithubComment[];
}

/** A code-scanning alert. */
export interface GithubCodeScanningAlert {
  /** Alert number. */
  readonly number: number;
  /** Rule ID. */
  readonly rule: string | null;
  /** Security severity when the rule has one, otherwise the rule severity. */
  readonly severity: string | null;
  /** File path of the most recent instance. */
  readonly path: string | null;
  /** First line of the most recent instance. */
  readonly line: number | null;
  /** Message of the most recent instance. */
  readonly message: string;
  /** `open`, `dismissed`, `fixed` or `closed`. */
  readonly state: string;
  /** Web URL. */
  readonly url: string;
}

/** Code scanning is set up; `alerts` is complete for the requested ref and state. */
export interface GithubCodeScanningAvailable {
  /** Discriminator. */
  readonly status: 'ok';
  /** Every matching alert, in GitHub's order. */
  readonly alerts: readonly GithubCodeScanningAlert[];
}

/** Code scanning is not set up for the repository, or has no analysis yet. */
export interface GithubCodeScanningUnavailable {
  /** Discriminator. */
  readonly status: 'unavailable';
  /** GitHub's message. */
  readonly reason: string;
  /** Always empty. */
  readonly alerts: readonly [];
}

/** Result of `codeScanning.alerts`: no alerts and unavailable code scanning stay distinct. */
export type GithubCodeScanning = GithubCodeScanningAvailable | GithubCodeScanningUnavailable;

const login = (author: RawActor | null): string => author?.login ?? 'ghost';

function mapComment(raw: RawComment): GithubComment {
  return {
    id: raw.databaseId,
    author: login(raw.author),
    isBot: raw.author?.__typename === 'Bot',
    body: raw.body,
    url: raw.url,
    createdAt: raw.createdAt,
  };
}

/** First line of a review comment, with a priority badge shown as `[P1]` and no bold markers. */
function commentTitle(body: string): string {
  const first = body.split('\n').find((line) => line.trim().length > 0) ?? '';
  return first
    .replace(/<sub><sub>!\[(P\d) Badge\]\([^)]*\)<\/sub><\/sub>/u, '[$1]')
    .replaceAll('**', '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** @internal */
export function mapRepoInfo(repo: GithubRepo, raw: RawRepoInfoResponse): GithubRepoInfo {
  const repository = raw.data.repository;
  const [owner = repo.owner, name = repo.name] = repository.nameWithOwner.split('/');
  return {
    host: repo.host,
    owner,
    name,
    nameWithOwner: repository.nameWithOwner,
    defaultBranch: repository.defaultBranchRef?.name ?? null,
    isPrivate: repository.isPrivate,
    viewer: raw.data.viewer.login,
    viewerPermission: repository.viewerPermission,
  };
}

/** @internal */
export function mapPullRequest(raw: RawPullRequestViewResponse): GithubPullRequest {
  const pr = raw.data.repository.pullRequest;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    body: pr.body,
    state: pr.state,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    headRefOid: pr.headRefOid,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    closingIssues: pr.closingIssuesReferences.nodes.map((issue) => ({
      number: issue.number,
      repository: issue.repository.nameWithOwner,
    })),
    checks: lastCommitChecks(pr.commits),
  };
}

/** The summarized checks of the last commit's rollup. */
function lastCommitChecks(commits: RawPullRequest['commits']): GithubChecks {
  return summarizeChecks(commits.nodes.at(-1)?.commit.statusCheckRollup?.contexts.nodes ?? []);
}

/** @internal */
export function mapPullRequestList(raw: RawPullRequestListResponse): GithubPullRequestSummary[] {
  return raw
    .flatMap((page) => page.data.repository.pullRequests.nodes)
    .map((row) => ({
      number: row.number,
      title: row.title,
      state: row.state,
      isDraft: row.isDraft,
      headRefName: row.headRefName,
      baseRefName: row.baseRefName,
      headRefOid: row.headRefOid,
      url: row.url,
      body: row.body,
    }))
    .sort((left, right) => left.number - right.number);
}

/** Map one review thread; exported for table tests. @internal */
export function mapReviewThread(raw: RawReviewThread): GithubReviewThread {
  const comments = raw.comments.nodes.map(mapComment);
  const first = comments[0];
  const body = first?.body ?? '';
  const alert = /security\/code-scanning\/(\d+)/u.exec(body)?.[1];
  return {
    id: raw.id,
    isResolved: raw.isResolved,
    isOutdated: raw.isOutdated,
    path: raw.path,
    line: raw.line ?? raw.originalLine,
    author: first?.author ?? 'ghost',
    isBot: first?.isBot ?? false,
    lastAuthor: comments.at(-1)?.author ?? null,
    alert: alert === undefined ? null : Number(alert),
    priority: /!\[(P\d) Badge\]/u.exec(body)?.[1] ?? null,
    title: commentTitle(body),
    url: first?.url ?? null,
    comments,
  };
}

/** @internal */
export function mapReviewThreads(raw: RawReviewThreadsResponse): GithubReviewThread[] {
  return raw.flatMap((page) =>
    page.data.repository.pullRequest.reviewThreads.nodes.map(mapReviewThread),
  );
}

function mapIssueFields(issue: RawIssue): GithubIssue {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body: issue.body,
    url: issue.url,
    author: login(issue.author),
    labels: issue.labels.nodes.map((label) => label.name),
  };
}

/** @internal */
export function mapIssue(raw: RawIssueViewResponse): GithubIssue {
  return mapIssueFields(raw.data.repository.issue);
}

/** @internal */
export function mapIssueWithComments(raw: RawIssueCommentsResponse): GithubIssueWithComments {
  const [first] = raw;
  if (first === undefined) throw new Error('A paginated GitHub read returned no pages.');
  return {
    ...mapIssueFields(first.data.repository.issue),
    comments: raw.flatMap((page) => page.data.repository.issue.comments.nodes.map(mapComment)),
  };
}

/** @internal */
export function mapCodeScanning(raw: RawCodeScanningResponse): GithubCodeScanning {
  if (!Array.isArray(raw))
    return { status: 'unavailable', reason: (raw as RawGithubErrorBody).message, alerts: [] };
  return {
    status: 'ok',
    alerts: (raw as readonly RawCodeScanningAlert[]).map((alert) => ({
      number: alert.number,
      rule: alert.rule.id,
      severity: alert.rule.security_severity_level ?? alert.rule.severity,
      path: alert.most_recent_instance.location?.path ?? null,
      line: alert.most_recent_instance.location?.start_line ?? null,
      message: alert.most_recent_instance.message?.text ?? '',
      state: alert.state,
      url: alert.html_url,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Read specifications

/** Everything one read needs: label, argv, schema, accepted exits and mapper. @internal */
export interface GithubReadSpec<R, T> {
  /** `meta.op`, such as `pr.view`. */
  readonly op: string;
  /** Pure `gh` argv. */
  readonly argv: [string, ...string[]];
  /** Response schema, with completeness checks. */
  readonly schema: z.ZodType<R>;
  /** Accepted exit codes, when not the default `[0]`. */
  readonly okExitCodes?: readonly number[];
  /** Pure mapper from the validated response to the result. */
  readonly map: (raw: R) => T;
}

/** Throw unless `value` is a positive safe integer. @internal */
export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer.`);
  return value;
}

/** Throw unless `value` is a nonempty string without NUL. @internal */
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    throw new Error(`${label} must be a nonempty string without NUL.`);
  return value;
}

/** Throw unless `value` is one of `choices`. @internal */
export function choice<const T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string,
): T {
  if (!choices.includes(value as T))
    throw new Error(`${label} must be one of ${choices.join(', ')}.`);
  return value as T;
}

/** @internal */
export function repoInfoRead(
  repo: GithubRepo,
): GithubReadSpec<RawRepoInfoResponse, GithubRepoInfo> {
  return {
    op: 'repo.info',
    argv: graphqlArgv(repo, REPO_INFO_QUERY, false, {}),
    schema: repoInfoResponseSchema,
    map: (raw) => mapRepoInfo(repo, raw),
  };
}

/** @internal */
export function prViewRead(
  repo: GithubRepo,
  number: unknown,
): GithubReadSpec<RawPullRequestViewResponse, GithubPullRequest> {
  return {
    op: 'pr.view',
    argv: graphqlArgv(
      repo,
      PR_VIEW_QUERY,
      false,
      {},
      {
        number: positiveInteger(number, 'pr.view number'),
      },
    ),
    schema: pullRequestViewResponseSchema,
    map: mapPullRequest,
  };
}

/** @internal */
export function prListRead(
  repo: GithubRepo,
  options: { readonly head?: unknown; readonly base?: unknown; readonly state?: unknown },
): GithubReadSpec<RawPullRequestListResponse, GithubPullRequestSummary[]> {
  const state = choice(
    options.state ?? 'open',
    Object.keys(prListStates) as GithubPrListState[],
    'pr.list state',
  );
  return {
    op: 'pr.list',
    argv: graphqlArgv(repo, prListQuery(state), true, {
      head: options.head === undefined ? undefined : text(options.head, 'pr.list head'),
      base: options.base === undefined ? undefined : text(options.base, 'pr.list base'),
    }),
    schema: pullRequestListResponseSchema,
    map: mapPullRequestList,
  };
}

/** @internal */
export function reviewThreadsRead(
  repo: GithubRepo,
  number: unknown,
): GithubReadSpec<RawReviewThreadsResponse, GithubReviewThread[]> {
  return {
    op: 'pr.reviewThreads',
    argv: graphqlArgv(
      repo,
      REVIEW_THREADS_QUERY,
      true,
      {},
      {
        number: positiveInteger(number, 'pr.reviewThreads number'),
      },
    ),
    schema: reviewThreadsResponseSchema,
    map: mapReviewThreads,
  };
}

/** @internal */
export function issueViewRead(
  repo: GithubRepo,
  number: unknown,
): GithubReadSpec<RawIssueViewResponse, GithubIssue> {
  return {
    op: 'issue.view',
    argv: graphqlArgv(
      repo,
      ISSUE_VIEW_QUERY,
      false,
      {},
      {
        number: positiveInteger(number, 'issue.view number'),
      },
    ),
    schema: issueViewResponseSchema,
    map: mapIssue,
  };
}

/** @internal */
export function issueCommentsRead(
  repo: GithubRepo,
  number: unknown,
): GithubReadSpec<RawIssueCommentsResponse, GithubIssueWithComments> {
  return {
    op: 'issue.view',
    argv: graphqlArgv(
      repo,
      ISSUE_VIEW_COMMENTS_QUERY,
      true,
      {},
      {
        number: positiveInteger(number, 'issue.view number'),
      },
    ),
    schema: issueCommentsResponseSchema,
    map: mapIssueWithComments,
  };
}

/** Alert states `codeScanning.alerts` filters by. */
export type GithubCodeScanningState = 'open' | 'closed' | 'dismissed' | 'fixed';

/** @internal */
export function codeScanningRead(
  repo: GithubRepo,
  options: { readonly ref?: unknown; readonly state?: unknown },
): GithubReadSpec<RawCodeScanningResponse, GithubCodeScanning> {
  const ref = text(options.ref, 'codeScanning.alerts ref');
  const state = choice(
    options.state ?? 'open',
    ['open', 'closed', 'dismissed', 'fixed'] as const,
    'codeScanning.alerts state',
  );
  return {
    op: 'codeScanning.alerts',
    // No `--slurp`: gh 2.100 (pkg/cmd/api) closes a slurped outer array even when a later page
    // fails, so alerts fetched before a dropped connection would parse as a complete list. Plain
    // `--paginate` merges REST array pages into one array and writes its closing `]` only after
    // the last page; any failure after the first page leaves the array unclosed, and the JSON
    // parse rejects it.
    argv: apiArgv(
      repo,
      '--paginate',
      `repos/${repo.owner}/${repo.name}/code-scanning/alerts?ref=${encodeURIComponent(ref)}&state=${state}&per_page=100`,
    ),
    schema: codeScanningResponseSchema,
    // gh exits 1 on an HTTP error and prints the body; the schema accepts only "unavailable".
    okExitCodes: [0, 1],
    map: mapCodeScanning,
  };
}

// ---------------------------------------------------------------------------------------------
// Wait reads (ADR 0045): the pull request's head and state, REST review activity and compare

/**
 * A pull request's number, state, head and last commit's check rollup, for `waitChecks` and
 * `waitReview`: no title, body or closing issues, so only truncated check contexts fail it.
 * @internal
 */
export const PR_HEAD_QUERY: string = compact(`
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number state headRefOid
      ${lastCommitRollup}
    }
  }
}`);

/** A pull request's state, head and merge commit, for `waitPr`. @internal */
export const PR_STATE_QUERY: string = compact(`
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { state headRefOid mergeCommit { oid } }
  }
}`);

/** A REST user; null for a deleted account. */
export interface RawRestUser {
  /** Login, such as `chatgpt-codex-connector[bot]`. */
  readonly login: string;
}

/** One issue (or pull request conversation) comment, as the REST API returns it. */
export interface RawRestIssueComment {
  /** Comment ID. */
  readonly id: number;
  /** Author, or null for a deleted account. */
  readonly user: RawRestUser | null;
  /** Markdown body. */
  readonly body?: string | null | undefined;
  /** ISO 8601 creation time. */
  readonly created_at: string;
  /** ISO 8601 time of the last edit, or the creation time. */
  readonly updated_at: string;
  /** Web URL. */
  readonly html_url: string;
}

/** One pull request review, as the REST API returns it. */
export interface RawRestReview {
  /** Review ID. */
  readonly id: number;
  /** Author, or null for a deleted account. */
  readonly user: RawRestUser | null;
  /** `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`, `DISMISSED` or `PENDING`. */
  readonly state: string;
  /** The commit the review was submitted against. */
  readonly commit_id: string | null;
  /** ISO 8601 submission time; absent for a pending review. */
  readonly submitted_at?: string | null | undefined;
}

/** One reaction on an issue or pull request, as the REST API returns it. */
export interface RawRestReaction {
  /** Author, or null for a deleted account. */
  readonly user: RawRestUser | null;
  /** Reaction, such as `+1` or `eyes`. */
  readonly content: string;
  /** ISO 8601 creation time. */
  readonly created_at: string;
}

/** `gh api --paginate .../issues/N/comments` response: every page merged by gh into one array. */
export type RawRestIssueCommentsResponse = readonly RawRestIssueComment[];
/** `gh api --paginate .../pulls/N/reviews` response: every page merged into one array. */
export type RawRestReviewsResponse = readonly RawRestReview[];
/** `gh api --paginate .../issues/N/reactions` response: every page merged into one array. */
export type RawRestReactionsResponse = readonly RawRestReaction[];

/** The `pr.head` read of `waitChecks` and `waitReview`. */
export interface RawPullRequestHeadResponse {
  /** GraphQL data. */
  readonly data: {
    /** The repository. */
    readonly repository: {
      /** The pull request. */
      readonly pullRequest: Pick<RawPullRequest, 'number' | 'state' | 'headRefOid' | 'commits'>;
    };
  };
}

/** The pull request state read of `waitPr`. */
export interface RawPullRequestStateResponse {
  /** GraphQL data. */
  readonly data: {
    /** The repository. */
    readonly repository: {
      /** The pull request. */
      readonly pullRequest: {
        /** `OPEN`, `CLOSED` or `MERGED`. */
        readonly state: string;
        /** Head commit SHA. */
        readonly headRefOid: string;
        /** The merge commit once merged, otherwise null. */
        readonly mergeCommit: {
          /** Commit SHA. */
          readonly oid: string;
        } | null;
      };
    };
  };
}

/** `gh api repos/O/R/compare/BASE...HEAD --jq '{status: .status}'` output. */
export interface RawCompareResponse {
  /** `ahead` (HEAD descends from BASE), `behind`, `identical` or `diverged`. */
  readonly status: string;
}

const restUser = z.object({ login: z.string() }).nullable();

/** Schema of the issue comments REST read; one merged array, possibly empty. */
export const restIssueCommentsResponseSchema: z.ZodType<RawRestIssueCommentsResponse> = z.array(
  z.object({
    id: count,
    user: restUser,
    body: z.string().nullish(),
    created_at: z.string(),
    updated_at: z.string(),
    html_url: z.string(),
  }),
);

/** Schema of the pull request reviews REST read; one merged array, possibly empty. */
export const restReviewsResponseSchema: z.ZodType<RawRestReviewsResponse> = z.array(
  z.object({
    id: count,
    user: restUser,
    state: z.string(),
    commit_id: z.string().nullable(),
    submitted_at: z.string().nullish(),
  }),
);

/** Schema of the issue reactions REST read; one merged array, possibly empty. */
export const restReactionsResponseSchema: z.ZodType<RawRestReactionsResponse> = z.array(
  z.object({ user: restUser, content: z.string(), created_at: z.string() }),
);

/** Schema of the `pr.head` read; only truncated check contexts fail it. */
export const pullRequestHeadResponseSchema: z.ZodType<RawPullRequestHeadResponse> = z
  .object({
    data: z.object({
      repository: z.object({
        pullRequest: z.object({
          number: issueNumber,
          state: z.string(),
          headRefOid: z.string(),
          commits: lastCommit,
        }),
      }),
    }),
  })
  .superRefine((response, ctx) => {
    incompleteContexts(ctx, response.data.repository.pullRequest.commits, [
      'data',
      'repository',
      'pullRequest',
    ]);
  });

/** Schema of the `waitPr` state read. */
export const pullRequestStateResponseSchema: z.ZodType<RawPullRequestStateResponse> = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        state: z.string(),
        headRefOid: z.string(),
        mergeCommit: z.object({ oid: z.string() }).nullable(),
      }),
    }),
  }),
});

/** Schema of the compare read's `{status}` projection. */
export const compareResponseSchema: z.ZodType<RawCompareResponse> = z.object({
  status: z.string(),
});

/** An issue comment from the REST read, with its author resolved. @internal */
export interface GithubIssueComment {
  /** Comment ID. */
  readonly id: number;
  /** Author login, or `ghost`. */
  readonly author: string;
  /** Markdown body; empty when GitHub returned none. */
  readonly body: string;
  /** Web URL. */
  readonly url: string;
  /** ISO 8601 creation time. */
  readonly createdAt: string;
  /** ISO 8601 time of the last edit. */
  readonly updatedAt: string;
}

/** A pull request review from the REST read. @internal */
export interface GithubReview {
  /** Review ID. */
  readonly id: number;
  /** Author login, or `ghost`. */
  readonly author: string;
  /** Review state. */
  readonly state: string;
  /** The reviewed commit SHA. */
  readonly commit: string | null;
  /** ISO 8601 submission time, or null for a pending review. */
  readonly submittedAt: string | null;
}

/** A reaction from the REST read. @internal */
export interface GithubReaction {
  /** Author login, or `ghost`. */
  readonly author: string;
  /** Reaction, such as `+1` or `eyes`. */
  readonly content: string;
  /** ISO 8601 creation time. */
  readonly createdAt: string;
}

/** A pull request's state, head, last-commit rollup SHA and summarized checks. @internal */
export interface GithubPullRequestHead {
  /** Pull request number. */
  readonly number: number;
  /** `OPEN`, `CLOSED` or `MERGED`. */
  readonly state: string;
  /** Head commit SHA. */
  readonly headRefOid: string;
  /** SHA of the commit the check rollup belongs to, or null without commits. */
  readonly rollupOid: string | null;
  /** Checks of that commit. */
  readonly checks: GithubChecks;
}

/** A pull request's state for `waitPr`. @internal */
export interface GithubPullRequestState {
  /** `OPEN`, `CLOSED` or `MERGED`. */
  readonly state: string;
  /** Head commit SHA. */
  readonly headRefOid: string;
  /** Merge commit SHA, or null. */
  readonly mergeCommit: string | null;
}

const restLogin = (user: RawRestUser | null): string => user?.login ?? 'ghost';

/** @internal */
export function mapPullRequestHead(raw: RawPullRequestHeadResponse): GithubPullRequestHead {
  const pr = raw.data.repository.pullRequest;
  return {
    number: pr.number,
    state: pr.state,
    headRefOid: pr.headRefOid,
    rollupOid: pr.commits.nodes.at(-1)?.commit.oid ?? null,
    checks: lastCommitChecks(pr.commits),
  };
}

/** @internal */
export function mapPullRequestState(raw: RawPullRequestStateResponse): GithubPullRequestState {
  const pr = raw.data.repository.pullRequest;
  return { state: pr.state, headRefOid: pr.headRefOid, mergeCommit: pr.mergeCommit?.oid ?? null };
}

/** @internal */
export function mapRestIssueComments(raw: RawRestIssueCommentsResponse): GithubIssueComment[] {
  return raw.map((comment) => ({
    id: comment.id,
    author: restLogin(comment.user),
    body: comment.body ?? '',
    url: comment.html_url,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  }));
}

/** @internal */
export function mapRestReviews(raw: RawRestReviewsResponse): GithubReview[] {
  return raw.map((review) => ({
    id: review.id,
    author: restLogin(review.user),
    state: review.state,
    commit: review.commit_id,
    submittedAt: review.submitted_at ?? null,
  }));
}

/** @internal */
export function mapRestReactions(raw: RawRestReactionsResponse): GithubReaction[] {
  return raw.map((reaction) => ({
    author: restLogin(reaction.user),
    content: reaction.content,
    createdAt: reaction.created_at,
  }));
}

const shaPattern = /^[0-9a-f]{7,40}$/u;

/** Throw unless `value` is a 7 to 40 character lowercase hex commit SHA. @internal */
export function commitSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !shaPattern.test(value))
    throw new Error(`${label} must be a commit SHA of 7 to 40 lowercase hex characters.`);
  return value;
}

/** `pr.head`: the pull request's state, head, rollup commit and checks. @internal */
export function prHeadRead(
  repo: GithubRepo,
  number: unknown,
): GithubReadSpec<RawPullRequestHeadResponse, GithubPullRequestHead> {
  return {
    op: 'pr.head',
    argv: graphqlArgv(
      repo,
      PR_HEAD_QUERY,
      false,
      {},
      { number: positiveInteger(number, 'pr.head number') },
    ),
    schema: pullRequestHeadResponseSchema,
    map: mapPullRequestHead,
  };
}

/** @internal */
export function prStateRead(
  repo: GithubRepo,
  number: unknown,
): GithubReadSpec<RawPullRequestStateResponse, GithubPullRequestState> {
  return {
    op: 'pr.state',
    argv: graphqlArgv(
      repo,
      PR_STATE_QUERY,
      false,
      {},
      { number: positiveInteger(number, 'pr.state number') },
    ),
    schema: pullRequestStateResponseSchema,
    map: mapPullRequestState,
  };
}

// No `--slurp`, for the reason given at codeScanningRead: a failure after the first page leaves
// the merged array unclosed, so the read rejects instead of returning a partial list.
function restListArgv(repo: GithubRepo, path: string): [string, ...string[]] {
  return apiArgv(repo, '--paginate', `repos/${repo.owner}/${repo.name}/${path}?per_page=100`);
}

/** @internal */
export function issueCommentsRestRead(
  repo: GithubRepo,
  number: unknown,
): GithubReadSpec<RawRestIssueCommentsResponse, GithubIssueComment[]> {
  const issue = positiveInteger(number, 'issue comments number');
  return {
    op: 'issue.comments',
    argv: restListArgv(repo, `issues/${String(issue)}/comments`),
    schema: restIssueCommentsResponseSchema,
    map: mapRestIssueComments,
  };
}

/** @internal */
export function reviewsRestRead(
  repo: GithubRepo,
  number: unknown,
): GithubReadSpec<RawRestReviewsResponse, GithubReview[]> {
  const pr = positiveInteger(number, 'pr.reviews number');
  return {
    op: 'pr.reviews',
    argv: restListArgv(repo, `pulls/${String(pr)}/reviews`),
    schema: restReviewsResponseSchema,
    map: mapRestReviews,
  };
}

/** @internal */
export function reactionsRestRead(
  repo: GithubRepo,
  number: unknown,
): GithubReadSpec<RawRestReactionsResponse, GithubReaction[]> {
  const issue = positiveInteger(number, 'issue reactions number');
  return {
    op: 'issue.reactions',
    argv: restListArgv(repo, `issues/${String(issue)}/reactions`),
    schema: restReactionsResponseSchema,
    map: mapRestReactions,
  };
}

/**
 * Compare two commits: `ahead` means `head` descends from `base`. Both SHAs are validated, so
 * neither can smuggle a path or flag into argv. @internal
 */
export function compareRead(
  repo: GithubRepo,
  base: unknown,
  head: unknown,
): GithubReadSpec<RawCompareResponse, RawCompareResponse> {
  return {
    op: 'repo.compare',
    argv: apiArgv(
      repo,
      `repos/${repo.owner}/${repo.name}/compare/${commitSha(base, 'compare base')}...${commitSha(head, 'compare head')}`,
      '--jq',
      '{status: .status}',
    ),
    schema: compareResponseSchema,
    map: (raw) => ({ status: raw.status }),
  };
}
