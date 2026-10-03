/**
 * `quiet-choir/github`: typed, complete-or-throw GitHub reads over the installed `gh`
 * ([ADR 0044](../../docs/decisions/0044-gh-backed-github-reads.md)). Each read is exactly one
 * `ctx.exec.json` with the caller's ID, pure `gh` argv, no environment overlay or stdin, and the
 * workflow cwd, so its identity is the argv, the response schema and the fixed exec defaults.
 * Authentication stays in gh and its inherited environment.
 */
import { ExecError, type ExecOptions, type RetryPolicy, type WorkflowContext } from '../index.js';
// The brand registry is a contract between quiet-choir copies (ADR 0028), not runtime state.
import { brandError, isBranded } from '../workflow/runtime/error-brand.js';
import {
  codeScanningRead,
  INCOMPLETE_COLLECTION_PARAM,
  issueCommentsRead,
  issueViewRead,
  parseGithubRepo,
  prListRead,
  prViewRead,
  repoInfoRead,
  reviewThreadsRead,
  type GithubCodeScanning,
  type GithubCodeScanningState,
  type GithubIssue,
  type GithubIssueWithComments,
  type GithubPrListState,
  type GithubPullRequest,
  type GithubPullRequestSummary,
  type GithubReadSpec,
  type GithubRepoInfo,
  type GithubReviewThread,
} from './github-model.js';

export {
  codeScanningResponseSchema,
  issueCommentsResponseSchema,
  issueViewResponseSchema,
  parseGithubRepo,
  pullRequestListResponseSchema,
  pullRequestViewResponseSchema,
  repoInfoResponseSchema,
  reviewThreadsResponseSchema,
  summarizeChecks,
} from './github-model.js';
export type {
  GithubCheck,
  GithubChecks,
  GithubCodeScanning,
  GithubCodeScanningAlert,
  GithubCodeScanningAvailable,
  GithubCodeScanningState,
  GithubCodeScanningUnavailable,
  GithubComment,
  GithubIssue,
  GithubIssueRef,
  GithubIssueWithComments,
  GithubPrListState,
  GithubPullRequest,
  GithubPullRequestSummary,
  GithubRepo,
  GithubRepoInfo,
  GithubReviewThread,
  RawActor,
  RawCheckContext,
  RawCheckRun,
  RawCodeScanningAlert,
  RawCodeScanningResponse,
  RawComment,
  RawConnection,
  RawGithubErrorBody,
  RawIssue,
  RawIssueCommentsPage,
  RawIssueCommentsResponse,
  RawIssueViewResponse,
  RawPageInfo,
  RawPullRequest,
  RawPullRequestListPage,
  RawPullRequestListResponse,
  RawPullRequestRow,
  RawPullRequestViewResponse,
  RawRepoInfoResponse,
  RawReviewThread,
  RawReviewThreadsPage,
  RawReviewThreadsResponse,
  RawStatusContext,
} from './github-model.js';

/**
 * A read whose response had a truncated connection: a nested connection, or the last page of a
 * paginated one, reported `pageInfo.hasNextPage`. The read fails instead of returning a partial
 * list, and is never checkpointed as completed, so a resume runs it again. Its `cause` is the
 * read's schema `ExecError`, so the run's root cause names the read's step.
 */
export class IncompleteCollectionError extends Error {
  static {
    brandError(this, 'IncompleteCollectionError');
  }

  /** Recognize an instance from any quiet-choir module instance, such as a CLI workflow's own import. */
  public static override [Symbol.hasInstance](value: unknown): value is IncompleteCollectionError {
    return isBranded(this, value);
  }

  /** The truncated connection, such as `pullRequest.reviewThreads[PRRT_x].comments`. */
  public readonly connection: string;
  /** The ID the read was called with, without enclosing scope prefixes. */
  public readonly stepId: string;

  public constructor(connection: string, stepId: string, options?: ErrorOptions) {
    super(
      `GitHub read ${stepId}: ${connection} has more items than one read returned; it fails instead of returning a partial list.`,
      options,
    );
    this.name = 'IncompleteCollectionError';
    this.connection = connection;
    this.stepId = stepId;
  }
}

/**
 * Execution policy a read passes through to its exec; none of it enters identity. There is no
 * default retry, because telling a transient gh failure from a permanent one would mean guessing
 * from messages. Reads are safe to repeat, so a retry such as
 * `{ maxAttempts: 3, on: ['process', 'timeout'] }` is safe; a network failure that leaves no JSON
 * on stdout is kind `schema`. Raise `maxOutputBytes` (default 1048576) for large thread or comment
 * sets: an oversized read throws, it never shrinks.
 */
export interface GithubReadPolicy {
  /** Deadline in milliseconds, default 300000. */
  readonly timeoutMs?: number;
  /** Retained stdout bytes, default 1048576; larger output rejects the read. */
  readonly maxOutputBytes?: number;
  /** Explicit retries. */
  readonly retry?: RetryPolicy;
}

/** Repository reads. */
export interface GithubRepoReads {
  /** Repository facts and the authenticated viewer: `gh api graphql`. */
  info(id: string, policy?: GithubReadPolicy): Promise<GithubRepoInfo>;
}

/** Filters of `pr.list`. */
export interface GithubPrListOptions {
  /** Head branch name. */
  readonly head?: string;
  /** Base branch name, for example the head of a pull request to find the ones stacked on it. */
  readonly base?: string;
  /** State, default `open`. */
  readonly state?: GithubPrListState;
}

/** Pull request reads. */
export interface GithubPullRequestReads {
  /** One pull request with its closing issues and summarized head checks. */
  view(
    id: string,
    args: { readonly number: number },
    policy?: GithubReadPolicy,
  ): Promise<GithubPullRequest>;
  /** Every matching pull request, sorted by number; paginated in one exec. */
  list(
    id: string,
    args?: GithubPrListOptions,
    policy?: GithubReadPolicy,
  ): Promise<GithubPullRequestSummary[]>;
  /** Every review thread with every comment; paginated in one exec. */
  reviewThreads(
    id: string,
    args: { readonly number: number },
    policy?: GithubReadPolicy,
  ): Promise<GithubReviewThread[]>;
}

/** Issue reads. A pull request number makes gh exit 1, so the read rejects. */
export interface GithubIssueReads {
  /** One issue with every comment; paginated over comments in one exec. */
  view(
    id: string,
    args: { readonly number: number; readonly comments: true },
    policy?: GithubReadPolicy,
  ): Promise<GithubIssueWithComments>;
  /** One issue with its labels. */
  view(
    id: string,
    args: { readonly number: number; readonly comments?: false },
    policy?: GithubReadPolicy,
  ): Promise<GithubIssue>;
}

/** Filters of `codeScanning.alerts`. */
export interface GithubCodeScanningOptions {
  /** Git ref, such as `refs/pull/12/merge` or `refs/heads/main`. */
  readonly ref: string;
  /** Alert state, default `open`. */
  readonly state?: GithubCodeScanningState;
}

/** Code-scanning reads. */
export interface GithubCodeScanningReads {
  /**
   * Every alert for a ref, or `status: 'unavailable'` when GitHub says code scanning is not set
   * up. Every other failure rejects.
   */
  alerts(
    id: string,
    args: GithubCodeScanningOptions,
    policy?: GithubReadPolicy,
  ): Promise<GithubCodeScanning>;
}

/** Typed GitHub reads for one repository. */
export interface GithubClient {
  /** Repository reads. */
  readonly repo: GithubRepoReads;
  /** Pull request reads. */
  readonly pr: GithubPullRequestReads;
  /** Issue reads. */
  readonly issue: GithubIssueReads;
  /** Code-scanning reads. */
  readonly codeScanning: GithubCodeScanningReads;
}

/** Options of {@link github}. */
export interface GithubOptions {
  /** `OWNER/REPO`, or `HOST/OWNER/REPO` for GitHub Enterprise Server (`gh api --hostname HOST`). */
  readonly repo: string;
}

const policyKeys = ['timeoutMs', 'maxOutputBytes', 'retry'] as const;

function policyOptions(
  policy: GithubReadPolicy | undefined,
): Pick<ExecOptions, 'timeoutMs' | 'maxOutputBytes' | 'retry'> {
  if (policy === undefined) return {};
  const unknown = Object.keys(policy).filter(
    (key) => !(policyKeys as readonly string[]).includes(key),
  );
  if (unknown.length)
    throw new Error(
      `GitHub reads accept only timeoutMs, maxOutputBytes and retry as policy; got ${unknown.join(', ')}.`,
    );
  return {
    ...(policy.timeoutMs === undefined ? {} : { timeoutMs: policy.timeoutMs }),
    ...(policy.maxOutputBytes === undefined ? {} : { maxOutputBytes: policy.maxOutputBytes }),
    ...(policy.retry === undefined ? {} : { retry: policy.retry }),
  };
}

/** The connection a schema failure names, duck-typed so another Zod instance's error works too. */
function incompleteConnection(error: ExecError): string | undefined {
  const cause: unknown = error.cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const issues: unknown = Reflect.get(cause, 'issues');
  if (!Array.isArray(issues)) return undefined;
  for (const issue of issues as unknown[]) {
    if (typeof issue !== 'object' || issue === null) continue;
    const params: unknown = Reflect.get(issue, 'params');
    if (typeof params !== 'object' || params === null) continue;
    const connection: unknown = Reflect.get(params, INCOMPLETE_COLLECTION_PARAM);
    if (typeof connection === 'string') return connection;
  }
  return undefined;
}

/**
 * Typed GitHub reads for `repo`. Each read is one `ctx.exec.json(id, argv, { schema, meta })`
 * labelled `{ integration: 'github', op }`. A completed read replays forever under its ID:
 * observe new state with a fresh occurrence ID, such as one keyed by round or head SHA. An
 * invalid `repo` throws here.
 */
export function github(ctx: Pick<WorkflowContext, 'exec'>, options: GithubOptions): GithubClient {
  const repo = parseGithubRepo(options.repo);
  async function read<R, T>(
    id: string,
    spec: GithubReadSpec<R, T>,
    policy: GithubReadPolicy | undefined,
  ): Promise<T> {
    const settings = policyOptions(policy);
    let raw: R;
    try {
      raw = await ctx.exec.json(id, spec.argv, {
        schema: spec.schema,
        meta: { integration: 'github', op: spec.op },
        ...(spec.okExitCodes === undefined ? {} : { okExitCodes: spec.okExitCodes }),
        ...settings,
      });
    } catch (error) {
      if (error instanceof ExecError && error.kind === 'schema') {
        const connection = incompleteConnection(error);
        if (connection !== undefined)
          throw new IncompleteCollectionError(connection, id, { cause: error });
      }
      throw error;
    }
    return spec.map(raw);
  }
  const issueView = (async (
    id: string,
    args: { readonly number: number; readonly comments?: boolean },
    policy?: GithubReadPolicy,
  ) =>
    args.comments === true
      ? read(id, issueCommentsRead(repo, args.number), policy)
      : read(id, issueViewRead(repo, args.number), policy)) as GithubIssueReads['view'];
  return {
    repo: {
      info: async (id, policy) => read(id, repoInfoRead(repo), policy),
    },
    pr: {
      view: async (id, args, policy) => read(id, prViewRead(repo, args.number), policy),
      list: async (id, args = {}, policy) => read(id, prListRead(repo, args), policy),
      reviewThreads: async (id, args, policy) =>
        read(id, reviewThreadsRead(repo, args.number), policy),
    },
    issue: { view: issueView },
    codeScanning: {
      alerts: async (id, args, policy) => read(id, codeScanningRead(repo, args), policy),
    },
  };
}
