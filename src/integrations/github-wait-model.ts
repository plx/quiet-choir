/**
 * Pure rules of the `quiet-choir/github` waits ([ADR 0045](../../docs/decisions/0045-head-pinned-github-waits.md)):
 * head pinning and stale views, the CI rollup, pull request states, the Codex and CodeQL reviewer
 * rules, reviewer aggregation, transient-error classification, and the schemas of each wait's note
 * and terminal value. No I/O, clock or process access; an ESLint block enforces it. The observers
 * in `github.ts` read GitHub, pass the wall-clock time in as `now`, and call these functions.
 */
import { ExecError, z, type JsonValue } from '../index.js';
import type {
  GithubChecks,
  GithubCodeScanning,
  GithubPullRequestHead,
  GithubPullRequestState,
  GithubReviewThread,
} from './github-model.js';

// ---------------------------------------------------------------------------------------------
// Reviewer adapters

/** A reviewer's state: still waiting, working, or a terminal verdict (`clean`, `findings`, `error`). */
export type ReviewerStatus = 'pending' | 'running' | 'clean' | 'findings' | 'error';

/** A read a reviewer needs on every check; the wait reads the union of its unfinished reviewers. */
export type ReviewerRead = 'comments' | 'reviews' | 'reactions' | 'alerts';

/** An issue (conversation) comment by the reviewer's login. Times are Unix epoch milliseconds. */
export interface ReviewComment {
  /** Comment ID. */
  readonly id: number;
  /** Author login. */
  readonly author: string;
  /** Markdown body. */
  readonly body: string;
  /** Web URL. */
  readonly url: string;
  /** Creation time; 0 when GitHub's timestamp did not parse. */
  readonly createdAt: number;
  /** Time of the last edit; 0 when GitHub's timestamp did not parse. */
  readonly updatedAt: number;
}

/** A pull request review by the reviewer's login. */
export interface ReviewSubmission {
  /** Review ID. */
  readonly id: number;
  /** Author login. */
  readonly author: string;
  /** `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`, `DISMISSED` or `PENDING`. */
  readonly state: string;
  /** The reviewed commit SHA. */
  readonly commit: string | null;
  /** Submission time in Unix epoch milliseconds, or null for a pending review. */
  readonly submittedAt: number | null;
}

/** A reaction on the pull request by the reviewer's login. */
export interface ReviewReaction {
  /** Author login. */
  readonly author: string;
  /** Reaction, such as `+1` or `eyes`. */
  readonly content: string;
  /** Creation time in Unix epoch milliseconds; 0 when it did not parse. */
  readonly createdAt: number;
}

/**
 * What one reviewer sees on one check. `comments`, `reviews` and `reactions` hold only the
 * reviewer's own `login`, and are empty unless it declared that read; `alerts` is null unless it
 * declared `alerts`.
 */
export interface ReviewActivity {
  /** The pull request, as read at this check. Its head always equals the wait's `sha`. */
  readonly pr: {
    /** Pull request number. */
    readonly number: number;
    /** `OPEN` (a reviewer is only observed while the pull request is open). */
    readonly state: string;
    /** Head commit SHA, equal to the wait's `sha`. */
    readonly headRefOid: string;
    /** Checks of the head, or null while GitHub's check rollup still belongs to another commit. */
    readonly checks: GithubChecks | null;
  };
  /** The reviewer's issue comments, oldest first. */
  readonly comments: readonly ReviewComment[];
  /** The reviewer's reviews, oldest first. */
  readonly reviews: readonly ReviewSubmission[];
  /** The reviewer's reactions on the pull request. */
  readonly reactions: readonly ReviewReaction[];
  /** Open code-scanning alerts on `refs/pull/N/merge`, or null when not declared. */
  readonly alerts: GithubCodeScanning | null;
}

/** Facts a reviewer decides with, besides the activity. */
export interface ReviewerContext {
  /** The head SHA the wait is pinned to. */
  readonly sha: string;
  /** The wait's `since`, Unix epoch milliseconds: activity older than this is stale. */
  readonly since: number;
  /** Wall-clock time of this check, Unix epoch milliseconds, read by the wait's observer. */
  readonly now: number;
  /** The reviewer's own progress from earlier checks. */
  readonly previous: {
    /** The note this reviewer returned on its last observation, or null. */
    readonly note: JsonValue | null;
    /** Checks of the wait before this one. */
    readonly checks: number;
  };
}

/** One observation of a reviewer. */
export interface ReviewerObservation {
  /** `clean`, `findings` and `error` are final: the reviewer is not observed again. */
  readonly status: ReviewerStatus;
  /** JSON kept for this reviewer's next observation, such as a debounce flag; replaced each time. */
  readonly note?: JsonValue | undefined;
  /** JSON reported in the result's `by` entry, such as review IDs or alert numbers. */
  readonly detail?: JsonValue | undefined;
}

/**
 * A pluggable review detector for `waitReview`. `observe` must be a pure decision over the
 * activity and context: no I/O, clock or context operations. Keep cross-check state in the
 * returned `note`; a terminal status is sticky.
 */
export interface ReviewerBot {
  /** Unique, nonempty name, used in the result's `by` and in the wait note. */
  readonly name: string;
  /** GitHub login whose comments, reviews and reactions the reviewer sees. */
  readonly login: string;
  /** Reads to make on each check; defaults to `['comments', 'reviews', 'reactions']`. */
  readonly reads?: readonly ReviewerRead[];
  /**
   * JSON identity of the reviewer's rules, part of the wait's identity. Without it, the SHA-256 of
   * `observe`'s source text is used, so reformatting `observe` changes the wait's identity. Change
   * it whenever the rules change meaning.
   */
  readonly identity?: JsonValue;
  /** Decide this reviewer's status from one check's activity. */
  observe(
    activity: ReviewActivity,
    context: ReviewerContext,
  ): ReviewerObservation | Promise<ReviewerObservation>;
}

/** Reads a reviewer makes when it declares none. @internal */
export const DEFAULT_REVIEWER_READS: readonly ReviewerRead[] = ['comments', 'reviews', 'reactions'];
const READS: readonly ReviewerRead[] = ['comments', 'reviews', 'reactions', 'alerts'];
const STATUSES: readonly ReviewerStatus[] = ['pending', 'running', 'clean', 'findings', 'error'];
const FINAL: readonly ReviewerStatus[] = ['clean', 'findings', 'error'];

/** Whether a reviewer status is a terminal verdict. @internal */
export function isFinalStatus(status: ReviewerStatus): boolean {
  return FINAL.includes(status);
}

/** Validate reviewers before a wait opens; returns each one's reads. @internal */
export function validateReviewers(
  reviewers: unknown,
): { readonly bot: ReviewerBot; readonly reads: readonly ReviewerRead[] }[] {
  if (!Array.isArray(reviewers) || reviewers.length === 0)
    throw new Error('waitReview needs at least one reviewer.');
  const names = new Set<string>();
  return (reviewers as unknown[]).map((value, index) => {
    if (value === null || typeof value !== 'object')
      throw new Error(`waitReview reviewer ${String(index)} must be an object.`);
    const bot = value as ReviewerBot;
    if (typeof bot.name !== 'string' || bot.name.length === 0)
      throw new Error(`waitReview reviewer ${String(index)} needs a nonempty name.`);
    if (names.has(bot.name))
      throw new Error(`waitReview reviewer names must be unique; ${bot.name} repeats.`);
    names.add(bot.name);
    if (typeof bot.login !== 'string' || bot.login.length === 0)
      throw new Error(`waitReview reviewer ${bot.name} needs a nonempty login.`);
    if (typeof bot.observe !== 'function')
      throw new Error(`waitReview reviewer ${bot.name} needs an observe function.`);
    const reads = bot.reads ?? DEFAULT_REVIEWER_READS;
    if (
      !Array.isArray(reads) ||
      (reads as unknown[]).some((read) => !READS.includes(read as ReviewerRead))
    )
      throw new Error(`waitReview reviewer ${bot.name} reads must be among ${READS.join(', ')}.`);
    return { bot, reads: READS.filter((read) => reads.includes(read)) };
  });
}

/** Check the shape of a reviewer's observation; a wrong one is a reviewer bug. @internal */
export function reviewerObservation(name: string, value: unknown): ReviewerObservation {
  if (value === null || typeof value !== 'object')
    throw new Error(`Reviewer ${name} returned no observation.`);
  const status = (value as { readonly status?: unknown }).status;
  if (!STATUSES.includes(status as ReviewerStatus))
    throw new Error(
      `Reviewer ${name} returned status ${String(status)}; use ${STATUSES.join(', ')}.`,
    );
  return value as ReviewerObservation;
}

// ---------------------------------------------------------------------------------------------
// Codex

/** Login of the Codex GitHub connector. */
export const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
/** Clock skew allowed between GitHub's timestamps and `since`. @internal */
export const CODEX_SKEW_MS = 5_000;
const SUMMARY_MARKER = 'codex-pull-request-review-summary';

/** One row of Codex's review summary table. */
export interface CodexSummaryRow {
  /** Review kind, such as `Code Review`. */
  readonly review: string;
  /** Status text, such as `Completed`, without its timestamp. */
  readonly status: string;
  /** Abbreviated reviewed commit. */
  readonly commit: string;
  /** What triggered the review, such as `Manual request`. */
  readonly trigger: string;
}

/**
 * Parse the rows of a Codex summary comment's table, such as
 * `| 📝 **Code Review** | ✅ **Completed** <relative-time …>…</relative-time> | \`15d5a1a\` | PR opened |`.
 * Each cell keeps only its text before the first `<`, where Codex puts the status word, without
 * emphasis, quote markers or a leading emoji; no markup is parsed.
 * @internal
 */
export function parseSummaryRows(body: string): CodexSummaryRow[] {
  const rows: CodexSummaryRow[] = [];
  const clean = (text: string): string =>
    (text.split('<', 1)[0] ?? '')
      .replace(/[*>]/gu, '')
      .replace(/^[^A-Za-z]+/u, '')
      .trim();
  for (const line of body.split('\n')) {
    const match = /^\|([^|]*)\|([^|]*)\|\s*`([0-9a-f]{7,40})`\s*\|([^|]*)\|/u.exec(line);
    if (!match) continue;
    const [, review = '', status = '', commit = '', trigger = ''] = match;
    rows.push({ review: clean(review), status: clean(status), commit, trigger: clean(trigger) });
  }
  return rows;
}

const seenCompleteNote = z.object({ seenComplete: z.boolean() });

/**
 * Codex's rules, in order. A fresh review on `sha` is `findings`; a fresh +1 reaction is `clean`;
 * a fresh usage-limit notice is `error`; then the latest summary comment, when fresh and holding
 * rows for `sha`, judged over all of them (such as a Code Review and a Security Review row): any
 * failed, errored or cancelled row is `error`, any row not yet `Completed` is `running`, and rows
 * that are all `Completed` are `clean` only on the second consecutive check (Codex posts findings
 * right after updating the summary); an eyes reaction is `running`; otherwise `pending`. Fresh
 * means at or after `since` less 5 s.
 * @internal
 */
export function codexObserve(
  activity: ReviewActivity,
  context: ReviewerContext,
): ReviewerObservation {
  const { sha, since } = context;
  const fresh = (at: number | null): boolean => at !== null && at >= since - CODEX_SKEW_MS;
  const findings = activity.reviews.filter(
    (review) => review.commit === sha && fresh(review.submittedAt),
  );
  if (findings.length)
    return { status: 'findings', detail: { reviews: findings.map((review) => review.id) } };
  if (activity.reactions.some((reaction) => reaction.content === '+1' && fresh(reaction.createdAt)))
    return { status: 'clean', detail: { via: 'reaction' } };
  // Codex answers a request it cannot serve with a plain comment and nothing else.
  if (
    activity.comments.some(
      (comment) =>
        /usage limits?/iu.test(comment.body) &&
        !comment.body.includes('review-summary') &&
        fresh(comment.createdAt),
    )
  )
    return { status: 'error', detail: { reason: 'Codex usage limit reached' } };
  const summary = activity.comments
    .filter((comment) => comment.body.includes(SUMMARY_MARKER))
    .at(-1);
  const rows =
    summary === undefined
      ? []
      : parseSummaryRows(summary.body).filter((candidate) => sha.startsWith(candidate.commit));
  if (summary !== undefined && rows.length > 0 && fresh(summary.updatedAt)) {
    const detail = { rows: rows.map((row) => ({ ...row })) };
    if (rows.some((row) => /fail|error|cancel/iu.test(row.status)))
      return { status: 'error', detail };
    if (rows.every((row) => /complete/iu.test(row.status))) {
      const seen = seenCompleteNote.safeParse(context.previous.note);
      return seen.success && seen.data.seenComplete
        ? { status: 'clean', detail: { via: 'summary', ...detail } }
        : { status: 'running', note: { seenComplete: true }, detail };
    }
    return { status: 'running', detail };
  }
  if (activity.reactions.some((reaction) => reaction.content === 'eyes'))
    return { status: 'running', detail: { via: 'reaction' } };
  return { status: 'pending' };
}

// ---------------------------------------------------------------------------------------------
// CodeQL

/** Login of GitHub's code-scanning review comments. */
export const CODEQL_LOGIN = 'github-advanced-security[bot]';
/**
 * The `unavailable` reason (one of `CODE_SCANNING_UNAVAILABLE` in `github-model.ts`) that may only
 * mean the pull request's first analysis has not published yet. @internal
 */
export const CODE_SCANNING_NO_ANALYSIS = /no analysis found/iu;
const settleNote = z.object({ settleStart: z.number() });

/** Options of the CodeQL reviewer. */
export interface CodeqlReviewerOptions {
  /**
   * Milliseconds to keep reading alerts after the check completes, default 60000: alerts land
   * shortly after the check, so an alert inside this window is still counted. Also how long after
   * `since` a head without the check and without an analysis waits before it is `clean`.
   */
  readonly settleMs?: number;
  /** Name of the check that finishes the analysis, default `CodeQL`. */
  readonly checkName?: string;
}

/**
 * CodeQL's rules. Code scanning that is not enabled (or needs Advanced Security) is `clean` at
 * once (detail `unavailable`). Until a check named `checkName` is on the head it is `pending`,
 * and `running` while that check runs. Once it completes, with any conclusion, the first such
 * check records `settleStart` in the note; after `settleMs` it is `findings` with the open alert
 * numbers, or `clean`. GitHub's `no analysis found` may only mean the first analysis has not
 * published: it follows the same check and settle rules and is `clean` (detail `unavailable`)
 * only when still reported after the settle window, or when the head's checks hold no such check
 * `settleMs` after `since`.
 * @internal
 */
export function codeqlObserve(
  activity: ReviewActivity,
  context: ReviewerContext,
  options: { readonly settleMs: number; readonly checkName: string },
): ReviewerObservation {
  const alerts = activity.alerts;
  const unavailable = alerts?.status === 'unavailable' ? alerts.reason : null;
  const noAnalysis = unavailable !== null && CODE_SCANNING_NO_ANALYSIS.test(unavailable);
  if (unavailable !== null && !noAnalysis) return { status: 'clean', detail: { unavailable } };
  const checks = activity.pr.checks;
  const named = (checks?.items ?? []).filter((item) => item.name === options.checkName);
  if (named.length === 0) {
    // Only the head's own checks show that the check is absent; a lagging rollup shows nothing.
    if (noAnalysis && checks !== null && context.now - context.since >= options.settleMs)
      return { status: 'clean', detail: { unavailable } };
    return { status: 'pending' };
  }
  if (named.some((item) => item.outcome === 'pending')) return { status: 'running' };
  const previous = settleNote.safeParse(context.previous.note);
  const settleStart = previous.success ? previous.data.settleStart : context.now;
  if (context.now - settleStart < options.settleMs)
    return { status: 'running', note: { settleStart }, detail: { settling: true } };
  if (noAnalysis) return { status: 'clean', detail: { unavailable } };
  const open = (alerts?.alerts ?? []).filter((alert) => alert.state === 'open');
  return open.length
    ? { status: 'findings', detail: { alerts: open.map((alert) => alert.number) } }
    : { status: 'clean' };
}

// ---------------------------------------------------------------------------------------------
// Results

/** A failed check of `waitChecks`. */
export interface GithubCheckFailure {
  /** Check run name or status context. */
  readonly name: string;
  /** Details or target URL. */
  readonly url: string | null;
  /** Actions workflow run ID for `gh run`, or null. */
  readonly runId: number | null;
}

/**
 * Result of `waitChecks`. `success` and `failure` are reported only for the pinned head; `failure`
 * only once nothing is pending. `no-checks` only after `graceMs`. `closed` when the pull request
 * closed or merged before CI finished; `timeout` at the deadline, with the last progress.
 */
export interface WaitChecksResult {
  /** Outcome. */
  readonly status: 'success' | 'failure' | 'no-checks' | 'head-moved' | 'closed' | 'timeout';
  /** The head GitHub reported last, or null when no check completed. */
  readonly headRefOid: string | null;
  /** Failed checks of the pinned head. */
  readonly failed: readonly GithubCheckFailure[];
  /** Names of checks still pending. */
  readonly pending: readonly string[];
}

/**
 * Result of `waitPr`. `merged` only when the merged head is the pinned SHA; a merge of another
 * head is `head-moved`. `closed` for a pull request closed without merging.
 */
export interface WaitPrResult {
  /** Outcome. */
  readonly status: 'merged' | 'closed' | 'head-moved' | 'timeout';
  /** The head GitHub reported last, or null when no check completed. */
  readonly headRefOid: string | null;
  /** Merge commit SHA when merged, otherwise null. */
  readonly mergeCommit: string | null;
}

/** One reviewer's verdict in a `waitReview` result. */
export interface ReviewerVerdict {
  /** Reviewer name. */
  readonly name: string;
  /** Final status, or the last one seen when the wait ended early. */
  readonly status: ReviewerStatus;
  /** The reviewer's detail JSON, or null. */
  readonly detail: JsonValue;
}

/**
 * Result of `waitReview`. Once every reviewer is final: `findings` when any reviewer found
 * something, else `error` when any failed, else `clean`, with the unresolved review threads whose
 * last comment is not the viewer's and the open code-scanning alerts on `refs/pull/N/merge`.
 * `head-moved`, `closed` and `timeout` end early, with empty thread and alert lists.
 */
export interface WaitReviewResult {
  /** Outcome. */
  readonly status: 'clean' | 'findings' | 'error' | 'head-moved' | 'closed' | 'timeout';
  /** The head GitHub reported last, or null when no check completed. */
  readonly headRefOid: string | null;
  /** Every reviewer, in the order given. */
  readonly by: readonly ReviewerVerdict[];
  /** IDs of unresolved threads whose last comment is not by the authenticated viewer. */
  readonly untriagedThreads: readonly string[];
  /** Open code-scanning alert numbers on `refs/pull/N/merge`. */
  readonly openAlerts: readonly number[];
}

/** Terminal value of the checks poll (no `timeout`). @internal */
export type WaitChecksTerminal = WaitChecksResult & {
  readonly status: Exclude<WaitChecksResult['status'], 'timeout'>;
};
/** Terminal value of the pull request poll. @internal */
export type WaitPrTerminal = WaitPrResult & {
  readonly status: Exclude<WaitPrResult['status'], 'timeout'>;
};
/** Terminal value of the review poll. @internal */
export type WaitReviewTerminal = WaitReviewResult & {
  readonly status: Exclude<WaitReviewResult['status'], 'timeout'>;
};

const failureSchema = z.object({
  name: z.string(),
  url: z.string().nullable(),
  runId: z.int().nullable(),
});
const sha = z.string().nullable();
const reviewerStatus = z.enum(['pending', 'running', 'clean', 'findings', 'error']);

/** Poll schema of `waitChecks`. @internal */
export const waitChecksValueSchema: z.ZodType<WaitChecksTerminal> = z.object({
  status: z.enum(['success', 'failure', 'no-checks', 'head-moved', 'closed']),
  headRefOid: sha,
  failed: z.array(failureSchema),
  pending: z.array(z.string()),
});

/** Poll schema of `waitPr`. @internal */
export const waitPrValueSchema: z.ZodType<WaitPrTerminal> = z.object({
  status: z.enum(['merged', 'closed', 'head-moved']),
  headRefOid: sha,
  mergeCommit: sha,
});

/** Poll schema of `waitReview`. @internal */
export const waitReviewValueSchema: z.ZodType<WaitReviewTerminal> = z.object({
  status: z.enum(['clean', 'findings', 'error', 'head-moved', 'closed']),
  headRefOid: sha,
  by: z.array(z.object({ name: z.string(), status: reviewerStatus, detail: z.json() })),
  untriagedThreads: z.array(z.string()),
  openAlerts: z.array(z.int()),
});

// ---------------------------------------------------------------------------------------------
// Notes

// Bounded so a note stays far below the 16 KiB limit however many checks fail or stay pending.
const NOTE_LIST_LIMIT = 40;
const STALE_LIMIT = 5;

const staleSchema = z.array(z.string()).max(STALE_LIMIT);

/** Note of `waitChecks`. @internal */
export const checksNoteSchema = z.object({
  startedAt: z.number(),
  stale: staleSchema,
  headRefOid: sha,
  failed: z.array(failureSchema),
  pending: z.array(z.string()),
});
/** Note of `waitChecks`. @internal */
export type ChecksNote = z.infer<typeof checksNoteSchema>;

/** Note of `waitPr`. @internal */
export const prNoteSchema = z.object({ state: z.string(), headRefOid: z.string() });
/** Note of `waitPr`. @internal */
export type PrNote = z.infer<typeof prNoteSchema>;

const botNoteSchema = z.object({
  status: reviewerStatus,
  final: z.boolean(),
  note: z.json(),
  detail: z.json(),
});
/** One reviewer's progress inside the `waitReview` note. @internal */
export type BotNote = z.infer<typeof botNoteSchema>;

/** Note of `waitReview`. @internal */
export const reviewNoteSchema = z.object({
  startedAt: z.number(),
  stale: staleSchema,
  headRefOid: sha,
  bots: z.record(z.string(), botNoteSchema),
});
/** Note of `waitReview`. @internal */
export type ReviewNote = z.infer<typeof reviewNoteSchema>;

/** Parse a previous note, or null when there is none or it has another shape. @internal */
export function parseNote<T>(schema: z.ZodType<T>, note: JsonValue | null): T | null {
  if (note === null) return null;
  const parsed = schema.safeParse(note);
  return parsed.success ? parsed.data : null;
}

/** Keep a bounded list in a note. @internal */
export function bounded<T>(items: readonly T[]): T[] {
  return items.slice(0, NOTE_LIST_LIMIT);
}

// ---------------------------------------------------------------------------------------------
// Head pinning

/**
 * How an observed head relates to the pinned `sha`: `same`; `stale` (a known ancestor, inside
 * the stale grace); `compare` (inside the grace: ask GitHub whether `sha` descends from it); or
 * `moved`. Outside the grace any other head is `moved`.
 * @internal
 */
export function headDecision(
  observed: string,
  pinned: string,
  options: {
    readonly now: number;
    readonly startedAt: number;
    readonly staleGraceMs: number;
    readonly stale: readonly string[];
  },
): 'same' | 'stale' | 'compare' | 'moved' {
  if (observed === pinned) return 'same';
  // A head that is not a SHA (such as a synthesized dry-run value) cannot be compared.
  if (!/^[0-9a-f]{7,40}$/u.test(observed)) return 'moved';
  if (options.now - options.startedAt >= options.staleGraceMs) return 'moved';
  return options.stale.includes(observed) ? 'stale' : 'compare';
}

/** A compare status: `ahead` (the pinned SHA descends from the observed head) is a stale view. @internal */
export function staleFromCompare(status: string | null): 'stale' | 'moved' {
  return status === 'ahead' ? 'stale' : 'moved';
}

/** Remember a confirmed stale head, keeping the list bounded. @internal */
export function rememberStale(stale: readonly string[], observed: string): string[] {
  return [observed, ...stale.filter((item) => item !== observed)].slice(0, STALE_LIMIT);
}

// ---------------------------------------------------------------------------------------------
// Checks

/** What one check of `waitChecks` decided. @internal */
export type ChecksDecision =
  | { readonly done: true; readonly value: WaitChecksTerminal }
  | {
      readonly done: false;
      readonly progress: Pick<WaitChecksResult, 'headRefOid' | 'failed' | 'pending'>;
    };

function failures(checks: GithubChecks): GithubCheckFailure[] {
  return checks.items
    .filter((item) => item.outcome === 'failed')
    .map((item) => ({ name: item.name, url: item.url, runId: item.workflowRunId }));
}

/**
 * Roll up the checks of the pinned head as `ciSummary` does. Never terminal-successful unless both
 * the pull request head and the rollup's commit are `sha`: a rollup for another commit is a stale
 * view and keeps polling. `failure` only once nothing is pending; `closed` when the pull request
 * is no longer open and CI has not finished; `no-checks` only after `graceMs` from `startedAt`.
 * @internal
 */
export function decideChecks(
  view: GithubPullRequestHead,
  options: {
    readonly sha: string;
    readonly now: number;
    readonly startedAt: number;
    readonly graceMs: number;
  },
): ChecksDecision {
  const open = view.state === 'OPEN';
  const waiting = { headRefOid: view.headRefOid, failed: [], pending: [] };
  if (view.headRefOid !== options.sha) return { done: false, progress: waiting };
  if (view.rollupOid !== options.sha)
    return open
      ? { done: false, progress: waiting }
      : { done: true, value: { status: 'closed', ...waiting } };
  const checks = view.checks;
  const progress = {
    headRefOid: view.headRefOid,
    failed: failures(checks),
    pending: [...checks.pending],
  };
  if (checks.state === 'success') return { done: true, value: { status: 'success', ...progress } };
  if (checks.state === 'failure') return { done: true, value: { status: 'failure', ...progress } };
  if (!open) return { done: true, value: { status: 'closed', ...progress } };
  if (checks.state === 'none' && options.now - options.startedAt >= options.graceMs)
    return { done: true, value: { status: 'no-checks', ...progress } };
  return { done: false, progress };
}

// ---------------------------------------------------------------------------------------------
// Pull request state

/** What one check of `waitPr` decided. @internal */
export type PrDecision =
  | { readonly done: true; readonly value: WaitPrTerminal }
  | { readonly done: false; readonly note: PrNote };

/**
 * `MERGED` is `merged` only for the pinned head, else `head-moved`; `CLOSED` is `closed` at once.
 * While open, `until: 'merged'` ends with `head-moved` as soon as the head leaves `sha`, and
 * `until: 'closed'` keeps waiting through pushes.
 * @internal
 */
export function decidePr(
  state: GithubPullRequestState,
  options: { readonly sha: string; readonly until: 'merged' | 'closed' },
): PrDecision {
  const head = state.headRefOid;
  if (state.state === 'MERGED')
    return head === options.sha
      ? {
          done: true,
          value: { status: 'merged', headRefOid: head, mergeCommit: state.mergeCommit },
        }
      : { done: true, value: { status: 'head-moved', headRefOid: head, mergeCommit: null } };
  if (state.state === 'CLOSED')
    return { done: true, value: { status: 'closed', headRefOid: head, mergeCommit: null } };
  if (options.until === 'merged' && head !== options.sha)
    return { done: true, value: { status: 'head-moved', headRefOid: head, mergeCommit: null } };
  return { done: false, note: { state: state.state, headRefOid: head } };
}

// ---------------------------------------------------------------------------------------------
// Reviews

/** `findings` beats `error`, which beats `clean`. @internal */
export function aggregateReview(
  statuses: readonly ReviewerStatus[],
): 'clean' | 'findings' | 'error' {
  if (statuses.includes('findings')) return 'findings';
  if (statuses.includes('error')) return 'error';
  return 'clean';
}

/** Unresolved threads whose last comment is not the viewer's: nobody has answered them. @internal */
export function untriagedThreads(threads: readonly GithubReviewThread[], viewer: string): string[] {
  return threads
    .filter((thread) => !thread.isResolved && thread.lastAuthor !== viewer)
    .map((thread) => thread.id);
}

/** Open alert numbers, or none when code scanning is unavailable. @internal */
export function openAlertNumbers(alerts: GithubCodeScanning): number[] {
  return alerts.alerts.filter((alert) => alert.state === 'open').map((alert) => alert.number);
}

/** The reviewers' verdicts from a note, in declaration order. @internal */
export function verdicts(names: readonly string[], note: ReviewNote | null): ReviewerVerdict[] {
  return names.map((name) => {
    const bot = note?.bots[name];
    return { name, status: bot?.status ?? 'pending', detail: bot?.detail ?? null };
  });
}

// ---------------------------------------------------------------------------------------------
// Deadline results

/** `waitChecks`'s `timeout` result from its last note. @internal */
export function checksTimeout(note: JsonValue): WaitChecksResult {
  const last = parseNote(checksNoteSchema, note);
  return {
    status: 'timeout',
    headRefOid: last?.headRefOid ?? null,
    failed: last?.failed ?? [],
    pending: last?.pending ?? [],
  };
}

/** `waitPr`'s `timeout` result from its last note. @internal */
export function prTimeout(note: JsonValue): WaitPrResult {
  return {
    status: 'timeout',
    headRefOid: parseNote(prNoteSchema, note)?.headRefOid ?? null,
    mergeCommit: null,
  };
}

/** `waitReview`'s `timeout` result from its last note. @internal */
export function reviewTimeout(names: readonly string[], note: JsonValue): WaitReviewResult {
  const last = parseNote(reviewNoteSchema, note);
  return {
    status: 'timeout',
    headRefOid: last?.headRefOid ?? null,
    by: verdicts(names, last),
    untriagedThreads: [],
    openAlerts: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Error classification

/** A REST 404 error body, as gh prints it on stdout. @internal */
export function isNotFound(parsed: JsonValue | undefined): boolean {
  return (
    parsed !== undefined &&
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    parsed['status'] === '404'
  );
}

/** A GitHub error body that no retry can fix: REST 401/404, or a GraphQL `NOT_FOUND`. */
function permanentGithubError(parsed: JsonValue | undefined): boolean {
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  )
    return false;
  const status = parsed['status'];
  if (status === '401' || status === '404') return true;
  const errors = parsed['errors'];
  return (
    Array.isArray(errors) &&
    errors.some(
      (error) =>
        error !== null &&
        typeof error === 'object' &&
        !Array.isArray(error) &&
        error['type'] === 'NOT_FOUND',
    )
  );
}

/**
 * Classify a rejected observation from typed facts only, never message text (ADR 0007).
 * Transient: an `ExecError` of kind `process` or `timeout`; kind `schema` when stdout was not JSON
 * (a dropped connection or an unclosed paginated array) or gh exited nonzero (an HTTP error body,
 * as the code-scanning read accepts exit 1); and an `observeTimeoutMs` expiry. Fatal: a REST 401
 * or 404 body or a GraphQL `NOT_FOUND` error; kind `output-limit`; exit 0 with JSON that fails the
 * schema (a contract change); any other error, such as an `IncompleteCollectionError` or a
 * reviewer that throws.
 * @internal
 */
export function classifyWaitError(error: unknown): 'transient' | 'fatal' {
  if (error instanceof ExecError) {
    if (permanentGithubError(error.parsed)) return 'fatal';
    if (error.kind === 'process' || error.kind === 'timeout') return 'transient';
    if (error.kind === 'schema')
      return error.diagnostics.code !== 0 || error.cause instanceof SyntaxError
        ? 'transient'
        : 'fatal';
    return 'fatal';
  }
  const code: unknown =
    error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return code === 'QUIET_CHOIR_POLL_OBSERVE_TIMEOUT' ? 'transient' : 'fatal';
}
