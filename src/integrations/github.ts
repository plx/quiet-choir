/**
 * `quiet-choir/github`: typed, complete-or-throw GitHub reads over the installed `gh`
 * ([ADR 0044](../../docs/decisions/0044-gh-backed-github-reads.md)), head-pinned waits for CI,
 * reviews and merges ([ADR 0045](../../docs/decisions/0045-head-pinned-github-waits.md)),
 * reconciled writes ([ADR 0046](../../docs/decisions/0046-reconciled-github-writes.md)), and pull
 * request writes with a head-pinned merge and a failed-run rerun
 * ([ADR 0047](../../docs/decisions/0047-pull-request-writes-and-head-pinned-merge.md)), and an epic
 * snapshot with a pure next-ticket selector
 * ([ADR 0048](../../docs/decisions/0048-epic-snapshot-and-next-ticket-selector.md)). Each read
 * is exactly one `ctx.exec.json` with the caller's ID, pure `gh` argv, no environment overlay or
 * stdin, and the workflow cwd, so its identity is the argv, the response schema and the fixed exec
 * defaults. Each wait is exactly one `ctx.poll`. Each write is exactly one version-identified
 * `ctx.step` that reads before it writes, so a rerun after a crash does not write twice (a
 * failed-run rerun holds this only for runs at the attempt baseline).
 * Authentication stays in gh and its inherited environment.
 */
import { createHash } from 'node:crypto';
import {
  ExecError,
  type CommandPollOptions,
  type ExecOptions,
  type JsonValue,
  type PollContext,
  type PollInterval,
  type PollOptions,
  type RetryPolicy,
  type WorkflowContext,
} from '../index.js';
// The brand registry is a contract between quiet-choir copies (ADR 0028), not runtime state.
import { brandError, isBranded } from '../workflow/runtime/error-brand.js';
// So is the poll-identity registry key (ADR 0045): a wait's identity is a versioned constant.
// The helper-refinements key is the same kind of contract: a rehearsal skips the marked schemas.
import { helperRefinements } from '../workflow/runtime/helper-refinements.js';
import { pollIdentityKey, type InternalPollIdentity } from '../workflow/runtime/poll-identity.js';
import {
  codeScanningRead,
  commitSha,
  compareRead,
  INCOMPLETE_COLLECTION_PARAM,
  issueCommentsRead,
  issueCommentsRestRead,
  issueViewRead,
  parseGithubRepo,
  prHeadRead,
  prListRead,
  prStateRead,
  prViewRead,
  reactionsRestRead,
  repoInfoRead,
  reviewsRestRead,
  reviewThreadsRead,
  type GithubCodeScanning,
  type GithubCodeScanningState,
  type GithubIssue,
  type GithubIssueWithComments,
  type GithubPrListState,
  type GithubPullRequest,
  type GithubPullRequestSummary,
  type GithubReadSpec,
  type GithubRepo,
  type GithubRepoInfo,
  type GithubReviewThread,
} from './github-model.js';
import {
  aggregateReview,
  bounded,
  checksNoteSchema,
  checksTimeout,
  classifyWaitError,
  CODEQL_LOGIN,
  codeqlObserve,
  CODEX_LOGIN,
  codexObserve,
  decideChecks,
  decidePr,
  headDecision,
  isFinalStatus,
  openAlertNumbers,
  isNotFound,
  parseNote,
  prTimeout,
  rememberStale,
  reviewerObservation,
  reviewNoteSchema,
  reviewTimeout,
  staleFromCompare,
  untriagedThreads,
  validateReviewers,
  verdicts,
  waitChecksValueSchema,
  waitPrValueSchema,
  waitReviewValueSchema,
  type BotNote,
  type CodeqlReviewerOptions,
  type ReviewActivity,
  type ReviewerBot,
  type WaitChecksResult,
  type WaitChecksTerminal,
  type WaitPrResult,
  type WaitPrTerminal,
  type WaitReviewResult,
  type WaitReviewTerminal,
} from './github-wait-model.js';
import { epicSnapshotRead, type GithubEpicSnapshot } from './github-epic-model.js';
import { githubWrites } from './github-writes.js';
import type {
  GithubAlertDismissOptions,
  GithubAlertDismissResult,
  GithubCommentOptions,
  GithubCommentResult,
  GithubIssueCloseOptions,
  GithubIssueCreateOptions,
  GithubIssueCreateResult,
  GithubIssueReopenOptions,
  GithubIssueStateResult,
  GithubPrCreateOptions,
  GithubPrCreateResult,
  GithubPrEditOptions,
  GithubPrEditResult,
  GithubPrMergeOptions,
  GithubPrMergeResult,
  GithubRerunFailedOptions,
  GithubRerunFailedResult,
  GithubThreadReplyOptions,
  GithubThreadReplyResult,
} from './github-write-model.js';

export {
  codeScanningResponseSchema,
  compareResponseSchema,
  issueCommentsResponseSchema,
  issueViewResponseSchema,
  parseGithubRepo,
  pullRequestHeadResponseSchema,
  pullRequestListResponseSchema,
  pullRequestStateResponseSchema,
  pullRequestViewResponseSchema,
  repoInfoResponseSchema,
  restIssueCommentsResponseSchema,
  restReactionsResponseSchema,
  restReviewsResponseSchema,
  reviewThreadsResponseSchema,
  summarizeChecks,
} from './github-model.js';
export { CODEQL_LOGIN, CODEX_LOGIN } from './github-wait-model.js';
export {
  epicSnapshotResponseSchema,
  nextTicket,
  outsideReferences,
  parseDependencies,
  parseEpicChecklist,
  parseSplit,
} from './github-epic-model.js';
export type {
  GithubEpicBlocker,
  GithubEpicChecklistEntry,
  GithubEpicChecklistLine,
  GithubEpicItem,
  GithubEpicItemStatus,
  GithubEpicPullRequest,
  GithubEpicSnapshot,
  GithubEpicSource,
  NextTicketOutsideIssue,
  NextTicketPick,
  NextTicketPolicy,
  NextTicketResult,
  NextTicketSkip,
  NextTicketSkipReason,
  RawEpicBlocker,
  RawEpicComment,
  RawEpicIssue,
  RawEpicPullRequestRef,
  RawEpicRepositoryRef,
  RawEpicSnapshotResponse,
  RawEpicSubIssue,
} from './github-epic-model.js';
export { alertDismissReason } from './github-write-model.js';
export type {
  GithubAlertDismissOptions,
  GithubAlertDismissReason,
  GithubAlertDismissResult,
  GithubCommentOptions,
  GithubCommentResult,
  GithubIssueCloseOptions,
  GithubIssueCloseReason,
  GithubIssueCreateOptions,
  GithubIssueCreateResult,
  GithubIssueReopenOptions,
  GithubIssueStateResult,
  GithubPrCreateOptions,
  GithubPrCreateResult,
  GithubPrEditField,
  GithubPrEditOptions,
  GithubPrEditResult,
  GithubPrMergeMethod,
  GithubPrMergeOptions,
  GithubPrMergeRefusal,
  GithubPrMergeResult,
  GithubPrState,
  GithubRerunFailedOptions,
  GithubRerunFailedResult,
  GithubThreadReplyOptions,
  GithubThreadReplyResult,
  GithubWorkflowRunRef,
} from './github-write-model.js';
export type {
  CodeqlReviewerOptions,
  GithubCheckFailure,
  ReviewActivity,
  ReviewComment,
  ReviewerBot,
  ReviewerContext,
  ReviewerObservation,
  ReviewerRead,
  ReviewerStatus,
  ReviewerVerdict,
  ReviewReaction,
  ReviewSubmission,
  WaitChecksResult,
  WaitPrResult,
  WaitReviewResult,
} from './github-wait-model.js';
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
  RawCompareResponse,
  RawConnection,
  RawGithubErrorBody,
  RawIssue,
  RawIssueCommentsPage,
  RawIssueCommentsResponse,
  RawIssueViewResponse,
  RawPageInfo,
  RawPullRequest,
  RawPullRequestHeadResponse,
  RawPullRequestListPage,
  RawPullRequestListResponse,
  RawPullRequestRow,
  RawPullRequestStateResponse,
  RawPullRequestViewResponse,
  RawRepoInfoResponse,
  RawRestIssueComment,
  RawRestIssueCommentsResponse,
  RawRestReaction,
  RawRestReactionsResponse,
  RawRestReview,
  RawRestReviewsResponse,
  RawRestUser,
  RawReviewThread,
  RawReviewThreadsPage,
  RawReviewThreadsResponse,
  RawStatusContext,
} from './github-model.js';

/**
 * A read whose response had a truncated connection: a nested connection, or the last page of a
 * paginated one, reported `pageInfo.hasNextPage`, or (for `epic.snapshot`) fewer sub-issues were
 * listed than GitHub counts. The read fails instead of returning a partial list, and is never checkpointed as completed, so a resume runs it again. Its `cause` is the
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

/**
 * Execution policy of a write, with the keys of {@link GithubReadPolicy}: `timeoutMs` and
 * `maxOutputBytes` apply to each gh command of the write, and `retry` is the step's retry policy.
 * None of it enters identity. There is no default retry; the reconciled ops are safe to repeat, so
 * a retry such as `{ maxAttempts: 3, on: ['process', 'timeout'] }` is recommended.
 */
export type GithubWritePolicy = GithubReadPolicy;

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

/**
 * Issue writes. Each is one `ctx.step` under `id`; see {@link GithubClient.comment} for the marker
 * and identity rules they share.
 */
export interface GithubIssueWrites {
  /**
   * Create an issue, reconciled by its marker: read the viewer, then the viewer's issues in the
   * repository newest first, page by page, and create the issue only when none carries the marker.
   * A miss scans every issue the viewer created there. With `parent`, read the issue's parent:
   * link it with `addSubIssue` when it has none, do nothing when it already is `parent`, and throw
   * without any write when it has a different parent.
   */
  create(
    id: string,
    args: GithubIssueCreateOptions,
    policy?: GithubWritePolicy,
  ): Promise<GithubIssueCreateResult>;
  /**
   * Close an open issue, check-then-act: read its state, and act only when it is open; a closed
   * issue returns `acted: false` with no write. `comment`, reconciled by its marker, is posted
   * before the state change. GitHub has no conditional update, so a concurrent change between the
   * read and the write is not detected.
   */
  close(
    id: string,
    args: GithubIssueCloseOptions,
    policy?: GithubWritePolicy,
  ): Promise<GithubIssueStateResult>;
  /** Reopen a closed issue, check-then-act, like {@link GithubIssueWrites.close}. */
  reopen(
    id: string,
    args: GithubIssueReopenOptions,
    policy?: GithubWritePolicy,
  ): Promise<GithubIssueStateResult>;
}

/** Review thread writes. */
export interface GithubThreadWrites {
  /**
   * Reply to a review thread, reconciled by its marker, then resolve it when wanted and not yet
   * resolved. By default bot threads are resolved and human threads stay open; `resolve` overrides
   * it, and never unresolves a thread.
   */
  reply(
    id: string,
    args: GithubThreadReplyOptions,
    policy?: GithubWritePolicy,
  ): Promise<GithubThreadReplyResult>;
}

/**
 * Pull request writes ([ADR 0047](../../docs/decisions/0047-pull-request-writes-and-head-pinned-merge.md)).
 * Each is one `ctx.step` under `id` with the identity rules of {@link GithubClient.comment}, and
 * uses only `gh api`, never `gh pr`.
 */
export interface GithubPullRequestWrites {
  /**
   * Open a pull request from the same-repository branch `head` into `base`, reconciled: list every
   * pull request for that head in any state and into any base, and return one carrying the step's
   * marker (even if it was retargeted), else an open one into `base` (whoever opened it, unchanged; use {@link GithubPullRequestWrites.edit} to
   * change it), with `created: false`. Only when there is neither does it `POST` the pull request,
   * with the marker appended to `body`. A head with an `OWNER:` prefix throws.
   */
  create(
    id: string,
    args: GithubPrCreateOptions,
    policy?: GithubWritePolicy,
  ): Promise<GithubPrCreateResult>;
  /**
   * Change the title, body or base of an open pull request whose head is still `expectHead`,
   * check-then-act: read it, return `reason: 'closed'` or `'head-moved'` with no write, and
   * otherwise `PATCH` only the fields that differ (none after a committed edit, so a retry sends
   * nothing). GitHub has no `If-Match`: a push or edit between the read and the `PATCH` is not
   * detected, and a concurrent edit is overwritten.
   */
  edit(
    id: string,
    args: GithubPrEditOptions,
    policy?: GithubWritePolicy,
  ): Promise<GithubPrEditResult>;
  /**
   * Merge at exactly head `sha` with `PUT repos/O/R/pulls/N/merge` and its `sha` parameter, which
   * GitHub checks atomically; never `gh pr merge`, auto-merge or a merge queue. It reads the pull
   * request first: merged at `sha` returns the merge commit with `acted: false` and no `PUT` (an
   * earlier attempt merged it), merged at another head throws, closed and another head return
   * `merged: false` with `closed` or `head-moved`. A refused `PUT` reads again and returns
   * `head-moved` (HTTP 409), `not-mergeable` (HTTP 405, with GitHub's message) or throws for
   * anything else. After a merge it reads until GitHub reports it merged, up to 20 reads 3 seconds
   * apart. Readiness (base branch, review threads, alerts) is the caller's to check.
   */
  merge(
    id: string,
    args: GithubPrMergeOptions,
    policy?: GithubWritePolicy,
  ): Promise<GithubPrMergeResult>;
}

/** Check writes ([ADR 0047](../../docs/decisions/0047-pull-request-writes-and-head-pinned-merge.md)). */
export interface GithubChecksWrites {
  /**
   * Rerun the failed jobs of the workflow runs of commit `sha` whose failure the caller saw, one
   * `ctx.step` under `id`: list every run (complete or throw), and rerun each completed run with
   * conclusion `failure` at or below the baseline `attempt` (default 1). A run past the baseline was
   * rerun already, by this step before a crash, a person or an earlier round, and is reported in
   * `skipped`, never rerun again. At most once holds for runs at the baseline: a run below it that
   * this step reran before a crash and that failed again before the retry or resume is rerun again,
   * so a caller that needs strictly once-only reruns across mixed attempts passes the lowest failing
   * attempt it saw. Then it reads the runs until each rerun shows (bounded, best
   * effort; see `confirmed`). Check-then-act on the baseline: a rerun started between the list and
   * the `POST` is not detected.
   */
  rerunFailed(
    id: string,
    args: GithubRerunFailedOptions,
    policy?: GithubWritePolicy,
  ): Promise<GithubRerunFailedResult>;
}

/** Code-scanning alert writes. */
export interface GithubAlertWrites {
  /**
   * Dismiss an alert, check-then-act: read it, and dismiss it only when it is neither dismissed nor
   * fixed; otherwise return `dismissed: false` with no write. The reason follows
   * {@link alertDismissReason}; the comment is truncated to 280 characters.
   */
  dismiss(
    id: string,
    args: GithubAlertDismissOptions,
    policy?: GithubWritePolicy,
  ): Promise<GithubAlertDismissResult>;
}

/** Filters of `codeScanning.alerts`. */
export interface GithubCodeScanningOptions {
  /** Git ref, such as `refs/pull/12/merge` or `refs/heads/main`. */
  readonly ref: string;
  /** Alert state, default `open`. */
  readonly state?: GithubCodeScanningState;
}

/** Epic reads ([ADR 0048](../../docs/decisions/0048-epic-snapshot-and-next-ticket-selector.md)). */
export interface GithubEpicReads {
  /**
   * One epic's items in one `gh api graphql` (`-F number=N`, no pagination): the sub-issues with
   * state, labels, assignees, blocked-by relations, linked pull requests, declared dependencies and
   * split markers, ordered by the epic body's checklist; or, for an epic without sub-issues, the
   * checklist itself. Complete or throw: any truncated connection, or fewer sub-issues listed than
   * GitHub counts, throws `IncompleteCollectionError`. `maxOutputBytes` defaults to 8 MiB. Pass the
   * result to {@link nextTicket}.
   */
  snapshot(
    id: string,
    args: { readonly number: number },
    policy?: GithubReadPolicy,
  ): Promise<GithubEpicSnapshot>;
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

/**
 * A wait's time bound: exactly one of a relative `timeoutMs`, pinned when the wait first opens, or
 * an absolute `deadline` from input or recorded data. At the bound the wait returns `timeout`.
 */
export type GithubWaitBound =
  | {
      /** Relative bound in milliseconds, pinned on first open. */
      readonly timeoutMs: number;
      /** Mutually exclusive with `timeoutMs`. */
      readonly deadline?: never;
    }
  | {
      /** Absolute Unix epoch milliseconds. */
      readonly deadline: number;
      /** Mutually exclusive with `deadline`. */
      readonly timeoutMs?: never;
    };

/** Execution policy of a wait; none of it enters the wait's identity. */
export interface GithubWaitPolicy {
  /** Spacing between checks; see `ctx.poll`. */
  readonly every?: PollInterval;
  /** Consecutive transient errors to tolerate, a positive integer; default 5. */
  readonly tolerate?: number;
  /** Bound of one check in milliseconds (`ctx.poll`'s `observeTimeoutMs`). */
  readonly observeTimeoutMs?: number;
}

/** Options of {@link GithubClient.waitChecks}. */
export type GithubWaitChecksOptions = GithubWaitBound &
  GithubWaitPolicy & {
    /** Pull request number. */
    readonly pr: number;
    /** The head SHA to pin: the full 40 lowercase hex characters; an abbreviated SHA throws. */
    readonly sha: string;
    /** Milliseconds from the first check before "no checks" is final; default 300000. */
    readonly graceMs?: number;
    /**
     * Milliseconds from the first check during which a head that `sha` descends from is a stale
     * view, not a move; default 0 (strict).
     */
    readonly staleGraceMs?: number;
    /** Retained stdout bytes of each read, default 1048576. */
    readonly maxOutputBytes?: number;
  };

/** Options of {@link GithubClient.waitPr}. */
export type GithubWaitPrOptions = GithubWaitBound &
  GithubWaitPolicy & {
    /** Pull request number. */
    readonly pr: number;
    /** The full 40-character head SHA a merge must have to count as `merged`. */
    readonly sha: string;
    /**
     * `merged`: end at a merge, a close, or as soon as the head leaves `sha`. `closed`: wait
     * through pushes for any closure.
     */
    readonly until: 'merged' | 'closed';
  };

/** Options of {@link GithubClient.waitReview}. */
export type GithubWaitReviewOptions = GithubWaitBound &
  GithubWaitPolicy & {
    /** Pull request number. */
    readonly pr: number;
    /** The full 40-character head SHA to pin. */
    readonly sha: string;
    /**
     * Unix epoch milliseconds at or after the push of `sha`, such as `await ctx.now('since')`:
     * reviewer activity older than this is ignored.
     */
    readonly since: number;
    /** The reviewers to wait for, with unique names; at least one. */
    readonly reviewers: readonly ReviewerBot[];
    /** As for `waitChecks`; default 0. */
    readonly staleGraceMs?: number;
    /** Retained stdout bytes of each read, default 1048576. */
    readonly maxOutputBytes?: number;
  };

/** Typed GitHub reads, waits and reconciled writes for one repository. */
export interface GithubClient {
  /** Repository reads. */
  readonly repo: GithubRepoReads;
  /** Pull request reads and writes. */
  readonly pr: GithubPullRequestReads & GithubPullRequestWrites;
  /** Issue reads and writes. */
  readonly issue: GithubIssueReads & GithubIssueWrites;
  /** Code-scanning reads. */
  readonly codeScanning: GithubCodeScanningReads;
  /** Epic reads. */
  readonly epic: GithubEpicReads;
  /** Review thread writes. */
  readonly thread: GithubThreadWrites;
  /** Code-scanning alert writes. */
  readonly alert: GithubAlertWrites;
  /** Check writes. */
  readonly checks: GithubChecksWrites;
  /**
   * Comment on an issue or pull request, reconciled by its marker: one `ctx.step` under `id`
   * (version `github.comment/1`) that reads every comment and posts only when none carries the
   * marker `<!-- quiet-choir:RUN/STEP -->`, the step's idempotency key, appended after a blank
   * line. A rerun after a crash between the post and the checkpoint finds the comment instead of
   * posting it again. Each write's identity is its version, the repository and its arguments; the
   * request body goes to gh on stdin, never in argv.
   */
  comment(
    id: string,
    args: GithubCommentOptions,
    policy?: GithubWritePolicy,
  ): Promise<GithubCommentResult>;
  /**
   * Wait for the checks of head `sha` to finish: one `ctx.poll` under `id`, reading the pull
   * request view on every check. Head-pinned: `success` and `failure` only for `sha`; any other
   * head ends with `head-moved` (after `staleGraceMs`, see {@link GithubWaitChecksOptions}).
   */
  waitChecks(id: string, options: GithubWaitChecksOptions): Promise<WaitChecksResult>;
  /**
   * Wait for the pull request to merge or close: one command `ctx.poll` under `id`. `merged` only
   * when the merged head is `sha`; a pull request closed without merging is `closed` at once.
   */
  waitPr(id: string, options: GithubWaitPrOptions): Promise<WaitPrResult>;
  /**
   * Wait until every reviewer has a final verdict on head `sha`, then count untriaged review
   * threads and open alerts: one `ctx.poll` under `id`. A head move ends with `head-moved`. The
   * check that sees the last verdict only commits it to the note; the next check makes those
   * reads and ends the wait, so a tolerated read error never observes a reviewer again (one extra
   * `every` after the last verdict).
   */
  waitReview(id: string, options: GithubWaitReviewOptions): Promise<WaitReviewResult>;
}

/**
 * Codex's GitHub reviewer (`chatgpt-codex-connector[bot]`). Its rules, in order: a review on `sha`
 * submitted after `since` is `findings`; a +1 reaction after `since` is `clean`; a usage-limit
 * notice after `since` is `error`; when the latest summary comment was updated after `since` and
 * has rows for `sha`, all of them count: any failed, errored or cancelled row is `error`, any row
 * not yet `Completed` is `running`, and rows that are all `Completed` are `clean` only when the
 * previous check saw them too; an eyes reaction is `running`; otherwise `pending`. "After `since`"
 * allows 5 seconds of clock skew.
 */
export function codexReviewer(): ReviewerBot {
  return { name: 'codex', login: CODEX_LOGIN, identity: { codex: 1 }, observe: codexObserve };
}

/**
 * GitHub code scanning (CodeQL) as a reviewer. It waits for the `checkName` check on the head to
 * complete (by default the `CodeQL` code-scanning results check GitHub publishes after the
 * analysis is uploaded, not the Actions job that runs the analysis; another scanning tool needs
 * its own `checkName`), then keeps reading the open alerts on `refs/pull/N/merge` for `settleMs`, because
 * alerts land shortly after the check, and reports `findings` (alert numbers) or `clean`.
 * Code scanning that is not enabled is `clean`. GitHub's `no analysis found` follows the check and
 * settle rules and is `clean` only when it persists after the settle window, or when the head has
 * no such check and all its checks have been complete for `settleMs`.
 */
export function codeqlReviewer(options: CodeqlReviewerOptions = {}): ReviewerBot {
  const settleMs = options.settleMs ?? 60_000;
  const checkName = options.checkName ?? 'CodeQL';
  if (!Number.isSafeInteger(settleMs) || settleMs < 0)
    throw new Error('codeqlReviewer settleMs must be a nonnegative integer.');
  if (typeof checkName !== 'string' || checkName.length === 0)
    throw new Error('codeqlReviewer checkName must be a nonempty string.');
  return {
    name: 'codeql',
    login: CODEQL_LOGIN,
    reads: ['alerts'],
    identity: { codeql: 1, settleMs, checkName },
    observe: (activity, context) => codeqlObserve(activity, context, { settleMs, checkName }),
  };
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
      `GitHub reads and writes accept only timeoutMs, maxOutputBytes and retry as policy; got ${unknown.join(', ')}.`,
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
 * Typed GitHub reads, waits and reconciled writes for `repo`. Each read is one
 * `ctx.exec.json(id, argv, { schema, meta })` labelled `{ integration: 'github', op }`. A
 * completed read replays forever under its ID: observe new state with a fresh occurrence ID, such
 * as one keyed by round or head SHA, or with a wait. Each wait is one `ctx.poll` under its ID, and
 * each write one `ctx.step` under its ID. An invalid `repo` throws here.
 */
export function github(
  ctx: Pick<WorkflowContext, 'exec' | 'poll' | 'step'>,
  options: GithubOptions,
): GithubClient {
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
        schema: helperRefinements(spec.schema),
        meta: { integration: 'github', op: spec.op },
        ...(spec.okExitCodes === undefined ? {} : { okExitCodes: spec.okExitCodes }),
        ...(spec.maxOutputBytes === undefined ? {} : { maxOutputBytes: spec.maxOutputBytes }),
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
  const writes = githubWrites(ctx, repo, {
    policy: (policy) => policyOptions(policy as GithubWritePolicy | undefined),
    rethrow: (error, id) => {
      if (error instanceof ExecError && error.kind === 'schema') {
        const connection = incompleteConnection(error);
        if (connection !== undefined)
          throw new IncompleteCollectionError(connection, id, { cause: error });
      }
      throw error;
    },
  });
  return {
    repo: {
      info: async (id, policy) => read(id, repoInfoRead(repo), policy),
    },
    pr: {
      view: async (id, args, policy) => read(id, prViewRead(repo, args.number), policy),
      list: async (id, args = {}, policy) => read(id, prListRead(repo, args), policy),
      reviewThreads: async (id, args, policy) =>
        read(id, reviewThreadsRead(repo, args.number), policy),
      ...writes.pr,
    },
    issue: { view: issueView, ...writes.issue },
    codeScanning: {
      alerts: async (id, args, policy) => read(id, codeScanningRead(repo, args), policy),
    },
    epic: {
      snapshot: async (id, args, policy) => read(id, epicSnapshotRead(repo, args.number), policy),
    },
    comment: writes.comment,
    thread: writes.thread,
    alert: writes.alert,
    checks: writes.checks,
    ...githubWaits(ctx, repo),
  };
}

// ---------------------------------------------------------------------------------------------
// Waits (ADR 0045)

/** A wait's identity value; bump the version whenever the wait's observable meaning changes. */
const WAIT_VERSION = 1;
const DEFAULT_TOLERATE = 5;
const CHECKS_EVERY: PollInterval = { initialMs: 30_000, maxMs: 120_000 };
const REVIEW_EVERY: PollInterval = 30_000;
const REVIEW_OBSERVE_TIMEOUT_MS = 120_000;
const DEFAULT_GRACE_MS = 300_000;

/** `repo` as it enters a wait's identity: `HOST/OWNER/REPO` or `OWNER/REPO`. */
const repoKey = (repo: GithubRepo): string =>
  repo.host === null ? repo.nameWithOwner : `${repo.host}/${repo.nameWithOwner}`;

function nonNegative(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a nonnegative integer.`);
  return value;
}

/** Validate what every wait shares, before the wait opens. */
function waitBase(
  name: string,
  options: GithubWaitBound & GithubWaitPolicy & { readonly pr: unknown; readonly sha: unknown },
): {
  readonly pr: number;
  readonly sha: string;
  readonly bound: { readonly timeoutMs: number } | { readonly deadline: number };
  readonly policy: {
    readonly observeTimeoutMs?: number;
    readonly onError: { readonly tolerate: number; readonly classify: typeof classifyWaitError };
  };
} {
  if ((options as unknown) === null || typeof options !== 'object')
    throw new Error(`${name} options must be an object.`);
  const pr = options.pr;
  if (typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr <= 0)
    throw new Error(`${name} pr must be a positive integer.`);
  const sha = commitSha(options.sha, `${name} sha`);
  if (sha.length !== 40) throw new Error(`${name} sha must be the full 40-character head SHA.`);
  const { timeoutMs, deadline } = options as { timeoutMs?: unknown; deadline?: unknown };
  if ((timeoutMs === undefined) === (deadline === undefined))
    throw new Error(`${name} needs exactly one of timeoutMs and deadline.`);
  const bound =
    timeoutMs === undefined
      ? { deadline: nonNegative(deadline, 0, `${name} deadline`) }
      : { timeoutMs: nonNegative(timeoutMs, 0, `${name} timeoutMs`) };
  const tolerate = options.tolerate ?? DEFAULT_TOLERATE;
  if (!Number.isSafeInteger(tolerate) || tolerate <= 0)
    throw new Error(`${name} tolerate must be a positive integer.`);
  return {
    pr,
    sha,
    bound,
    policy: {
      ...(options.observeTimeoutMs === undefined
        ? {}
        : { observeTimeoutMs: options.observeTimeoutMs }),
      onError: { tolerate, classify: classifyWaitError },
    },
  };
}

/** The connection a schema failure names, as in `read`, rethrown as IncompleteCollectionError. */
async function observeRead<R, T>(
  context: PollContext,
  id: string,
  spec: GithubReadSpec<R, T>,
  maxOutputBytes: number | undefined,
): Promise<T> {
  let raw: R;
  try {
    raw = await context.exec.json(spec.argv, {
      schema: helperRefinements(spec.schema),
      ...(spec.okExitCodes === undefined ? {} : { okExitCodes: spec.okExitCodes }),
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
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

/** GitHub's ISO 8601 timestamps as epoch milliseconds; 0 when one does not parse. */
function epochMs(iso: string): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : 0;
}

/** A reviewer's identity: its own, or the SHA-256 of its observe source. */
function reviewerIdentity(bot: ReviewerBot): JsonValue {
  if (bot.identity !== undefined) return bot.identity;
  // Read as a plain value: only its source text is hashed, it is never called here.
  const observe: unknown = Reflect.get(bot, 'observe');
  return {
    observe: createHash('sha256').update(Function.prototype.toString.call(observe)).digest('hex'),
  };
}

function githubWaits(
  ctx: Pick<WorkflowContext, 'poll'>,
  repo: GithubRepo,
): Pick<GithubClient, 'waitChecks' | 'waitPr' | 'waitReview'> {
  /**
   * Pin the observed head: within the stale grace, a head that `sha` descends from (GitHub's
   * compare says `ahead`) is a stale view; any other head is moved. A 404 compare means GitHub
   * does not relate the two, so the head moved.
   */
  async function pinHead(
    context: PollContext,
    id: string,
    observed: string,
    options: {
      readonly sha: string;
      readonly now: number;
      readonly startedAt: number;
      readonly staleGraceMs: number;
      readonly stale: readonly string[];
      readonly maxOutputBytes: number | undefined;
    },
  ): Promise<{ readonly head: 'same' | 'stale' | 'moved'; readonly stale: readonly string[] }> {
    const decision = headDecision(observed, options.sha, options);
    if (decision !== 'compare') return { head: decision, stale: options.stale };
    let status: string | null;
    try {
      status = (
        await observeRead(
          context,
          id,
          compareRead(repo, observed, options.sha),
          options.maxOutputBytes,
        )
      ).status;
    } catch (error) {
      // Only GitHub's 404 body: it knows no relation between the two commits. Anything else,
      // such as bad credentials, keeps its own classification.
      if (!(error instanceof ExecError) || !isNotFound(error.parsed)) throw error;
      status = null;
    }
    const head = staleFromCompare(status);
    return {
      head,
      stale: head === 'stale' ? rememberStale(options.stale, observed) : options.stale,
    };
  }

  return {
    async waitChecks(id, options) {
      const { pr, sha, bound, policy } = waitBase('waitChecks', options);
      const graceMs = nonNegative(options.graceMs, DEFAULT_GRACE_MS, 'waitChecks graceMs');
      const staleGraceMs = nonNegative(options.staleGraceMs, 0, 'waitChecks staleGraceMs');
      const maxOutputBytes = options.maxOutputBytes;
      const source: PollOptions<WaitChecksTerminal> & InternalPollIdentity = {
        input: { repo: repoKey(repo), pr, sha, graceMs, staleGraceMs },
        schema: waitChecksValueSchema,
        every: options.every ?? CHECKS_EVERY,
        ...bound,
        ...policy,
        [pollIdentityKey]: { helper: 'github.waitChecks', version: WAIT_VERSION },
        observe: async (context) => {
          // Wall clock, not the run clock: observers have none (ADR 0045).
          const now = Date.now();
          const previous = parseNote(checksNoteSchema, context.previous.note);
          const startedAt = previous?.startedAt ?? now;
          const view = await observeRead(context, id, prHeadRead(repo, pr), maxOutputBytes);
          const { head, stale } = await pinHead(context, id, view.headRefOid, {
            sha,
            now,
            startedAt,
            staleGraceMs,
            stale: previous?.stale ?? [],
            maxOutputBytes,
          });
          const waiting = { headRefOid: view.headRefOid, failed: [], pending: [] };
          if (head === 'moved') return { done: true, value: { status: 'head-moved', ...waiting } };
          if (head === 'stale')
            return { done: false, note: { startedAt, stale: [...stale], ...waiting } };
          const decision = decideChecks(view, { sha, now, startedAt, graceMs });
          if (decision.done) return decision;
          const { progress } = decision;
          return {
            done: false,
            note: {
              startedAt,
              stale: [...stale],
              headRefOid: progress.headRefOid,
              failed: bounded(progress.failed),
              pending: bounded(progress.pending),
            },
          };
        },
      } as PollOptions<WaitChecksTerminal> & InternalPollIdentity;
      const outcome = await ctx.poll(id, source);
      return outcome.by === 'poll' ? outcome.value : checksTimeout(outcome.note);
    },

    async waitPr(id, options) {
      const { pr, sha, bound, policy } = waitBase('waitPr', options);
      const until = options.until as unknown;
      if (until !== 'merged' && until !== 'closed')
        throw new Error('waitPr until must be merged or closed.');
      const spec = prStateRead(repo, pr);
      const source: CommandPollOptions<WaitPrTerminal> & InternalPollIdentity = {
        input: { repo: repoKey(repo), pr, sha, until },
        schema: waitPrValueSchema,
        every: options.every ?? CHECKS_EVERY,
        ...bound,
        ...policy,
        [pollIdentityKey]: { helper: 'github.waitPr', version: WAIT_VERSION },
        command: spec.argv,
        output: spec.schema,
        done: (raw) => {
          const decision = decidePr(spec.map(raw as Parameters<typeof spec.map>[0]), {
            sha,
            until,
          });
          return decision.done ? decision : { done: false, note: decision.note };
        },
      };
      const outcome = await ctx.poll(id, source);
      return outcome.by === 'poll' ? outcome.value : prTimeout(outcome.note);
    },

    async waitReview(id, options) {
      const { pr, sha, bound, policy } = waitBase('waitReview', options);
      const since = nonNegative(options.since, -1, 'waitReview since');
      if (since < 0) throw new Error('waitReview since must be Unix epoch milliseconds.');
      const reviewers = validateReviewers(options.reviewers);
      const names = reviewers.map(({ bot }) => bot.name);
      const staleGraceMs = nonNegative(options.staleGraceMs, 0, 'waitReview staleGraceMs');
      const maxOutputBytes = options.maxOutputBytes;
      const read = <R, T>(context: PollContext, spec: GithubReadSpec<R, T>): Promise<T> =>
        observeRead(context, id, spec, maxOutputBytes);
      const source: PollOptions<WaitReviewTerminal> & InternalPollIdentity = {
        input: {
          repo: repoKey(repo),
          pr,
          sha,
          since,
          staleGraceMs,
          reviewers: reviewers.map(({ bot, reads }) => ({
            name: bot.name,
            login: bot.login,
            reads: [...reads],
            identity: reviewerIdentity(bot),
          })),
        },
        schema: waitReviewValueSchema,
        every: options.every ?? REVIEW_EVERY,
        ...bound,
        observeTimeoutMs: REVIEW_OBSERVE_TIMEOUT_MS,
        ...policy,
        [pollIdentityKey]: { helper: 'github.waitReview', version: WAIT_VERSION },
        observe: async (context) => {
          const now = Date.now();
          const previous = parseNote(reviewNoteSchema, context.previous.note);
          const startedAt = previous?.startedAt ?? now;
          const bots: Record<string, BotNote> = { ...previous?.bots };
          const view = await read(context, prHeadRead(repo, pr));
          const { head, stale } = await pinHead(context, id, view.headRefOid, {
            sha,
            now,
            startedAt,
            staleGraceMs,
            stale: previous?.stale ?? [],
            maxOutputBytes,
          });
          const early = (status: 'head-moved' | 'closed') =>
            ({
              done: true,
              value: {
                status,
                headRefOid: view.headRefOid,
                by: verdicts(names, previous),
                untriagedThreads: [],
                openAlerts: [],
              },
            }) as const;
          if (head === 'moved') return early('head-moved');
          const note = () => ({
            done: false as const,
            note: { startedAt, stale: [...stale], headRefOid: view.headRefOid, bots },
          });
          if (head === 'stale') return note();
          if (view.state !== 'OPEN') return early('closed');
          const active = reviewers.filter(({ bot }) => bots[bot.name]?.final !== true);
          if (!active.length) {
            // Every verdict was committed by an earlier check, so a tolerated error in these reads
            // retries them without observing any reviewer again.
            const [threads, info, settled] = await Promise.all([
              read(context, reviewThreadsRead(repo, pr)),
              read(context, repoInfoRead(repo)),
              read(context, alertsRead(pr)),
            ]);
            const by = verdicts(names, { startedAt, stale: [...stale], headRefOid: sha, bots });
            return {
              done: true,
              value: {
                status: aggregateReview(by.map((verdict) => verdict.status)),
                headRefOid: view.headRefOid,
                by,
                untriagedThreads: untriagedThreads(threads, info.viewer),
                openAlerts: openAlertNumbers(settled),
              },
            };
          }
          const wanted = new Set(active.flatMap(({ reads }) => reads));
          const [comments, reviews, reactions, alerts] = await Promise.all([
            wanted.has('comments') ? read(context, issueCommentsRestRead(repo, pr)) : [],
            wanted.has('reviews') ? read(context, reviewsRestRead(repo, pr)) : [],
            wanted.has('reactions') ? read(context, reactionsRestRead(repo, pr)) : [],
            wanted.has('alerts') ? read(context, alertsRead(pr)) : null,
          ]);
          for (const { bot, reads } of active) {
            const login = bot.login;
            const activity: ReviewActivity = {
              pr: {
                number: view.number,
                state: view.state,
                headRefOid: view.headRefOid,
                checks: view.rollupOid === sha ? view.checks : null,
              },
              comments: reads.includes('comments')
                ? comments
                    .filter((comment) => comment.author === login)
                    .map((comment) => ({
                      ...comment,
                      createdAt: epochMs(comment.createdAt),
                      updatedAt: epochMs(comment.updatedAt),
                    }))
                : [],
              reviews: reads.includes('reviews')
                ? reviews
                    .filter((review) => review.author === login)
                    .map((review) => ({
                      ...review,
                      submittedAt: review.submittedAt === null ? null : epochMs(review.submittedAt),
                    }))
                : [],
              reactions: reads.includes('reactions')
                ? reactions
                    .filter((reaction) => reaction.author === login)
                    .map((reaction) => ({ ...reaction, createdAt: epochMs(reaction.createdAt) }))
                : [],
              alerts: reads.includes('alerts') ? alerts : null,
            };
            const observation = reviewerObservation(
              bot.name,
              await bot.observe(activity, {
                sha,
                since,
                now,
                previous: { note: bots[bot.name]?.note ?? null, checks: context.previous.checks },
              }),
            );
            bots[bot.name] = {
              status: observation.status,
              final: isFinalStatus(observation.status),
              note: observation.note ?? null,
              detail: observation.detail ?? null,
            };
          }
          // Commit this check's verdicts before any further read: the wait ends on the next check.
          return note();
        },
      };
      const outcome = await ctx.poll(id, source);
      return outcome.by === 'poll' ? outcome.value : reviewTimeout(names, outcome.note);
    },
  };

  function alertsRead(pr: number): GithubReadSpec<unknown, GithubCodeScanning> {
    return codeScanningRead(repo, { ref: `refs/pull/${String(pr)}/merge` }) as GithubReadSpec<
      unknown,
      GithubCodeScanning
    >;
  }
}
