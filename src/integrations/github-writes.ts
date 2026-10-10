/**
 * Reconciled GitHub writes of `quiet-choir/github`
 * ([ADR 0046](../../docs/decisions/0046-reconciled-github-writes.md)) and its pull request and
 * check writes ([ADR 0047](../../docs/decisions/0047-pull-request-writes-and-head-pinned-merge.md)).
 * Each op is exactly one `ctx.step` under the caller's ID, identified by a versioned constant such
 * as `github.comment/1` instead of callback text. Its callback reads first and writes only what an
 * earlier attempt did not: a write that creates something carries the step's marker and is found
 * by it, a state change is conditional on a preceding read, and a merge is pinned to a head SHA.
 * Every gh call goes through `StepContext.exec`, with request bodies on stdin, so a `--dry-run`
 * lists the reads and writes and spawns nothing.
 */
import { setTimeout as delay } from 'node:timers/promises';
// The helper-refinements key is a cross-instance contract, not runtime state: a rehearsal skips the marked schemas.
import { helperRefinements } from '../workflow/runtime/helper-refinements.js';
import type { ExecOptions, JsonValue, StepContext, WorkflowContext, z } from '../index.js';
import {
  choice,
  fullSha,
  positiveInteger,
  repoInfoRead,
  text,
  type GithubRepo,
} from './github-model.js';
import { issueCommentsRestRead } from './github-model.js';
import {
  addSubIssueResponseSchema,
  ADD_SUB_ISSUE_MUTATION,
  alertDismissReason,
  alertDismissResultSchema,
  alertPatchResponseSchema,
  alertReadArgv,
  alertResponseSchema,
  alertSettled,
  checkBodyLength,
  commentPostResponseSchema,
  commentResultSchema,
  createDecision,
  editChanges,
  findMarked,
  graphqlWrite,
  issueCreateResultSchema,
  issueListArgv,
  issueListPageSchema,
  ISSUE_PAGE_SIZE,
  issuePatchResponseSchema,
  issuePostResponseSchema,
  issueStateArgv,
  issueStateResponseSchema,
  issueStateResultSchema,
  mergeArgv,
  mergeFailure,
  mergePrecheck,
  mergeResponseSchema,
  parentDecision,
  parentIdReadArgv,
  parentIdResponseSchema,
  parentReadArgv,
  parentReadResponseSchema,
  prCreateResultSchema,
  prEditResultSchema,
  prMergeResultSchema,
  pullListArgv,
  pullListResponseSchema,
  pullListState,
  pullPatchResponseSchema,
  pullPostResponseSchema,
  pullReadArgv,
  pullResponseSchema,
  pullState,
  replyResponseSchema,
  REPLY_MUTATION,
  rerunArgv,
  rerunConfirmed,
  rerunFailedResultSchema,
  rerunSelection,
  runRefOf,
  runsListArgv,
  runsListResponseSchema,
  resolveResponseSchema,
  RESOLVE_MUTATION,
  restWrite,
  shouldResolve,
  stateMatches,
  threadReadArgv,
  threadReadResponseSchema,
  threadReplyResultSchema,
  truncateDismissComment,
  uniqueRuns,
  withMarker,
  type GithubAlertDismissOptions,
  type GithubAlertDismissReason,
  type GithubAlertDismissResult,
  type GithubCommentOptions,
  type GithubCommentResult,
  type GithubIssueCloseOptions,
  type GithubIssueCloseReason,
  type GithubIssueCreateOptions,
  type GithubIssueCreateResult,
  type GithubIssueReopenOptions,
  type GithubIssueStateResult,
  type GithubPrCreateOptions,
  type GithubPrCreateResult,
  type GithubPrEditOptions,
  type GithubPrEditResult,
  type GithubPrMergeMethod,
  type GithubPrMergeOptions,
  type GithubPrMergeResult,
  type GithubRerunFailedOptions,
  type GithubRerunFailedResult,
  type GithubThreadReplyOptions,
  type GithubThreadReplyResult,
  type GithubWriteRequest,
  type PullResponse,
} from './github-write-model.js';

/** The policy a write's step and commands use, validated by `github.ts`. @internal */
export interface GithubWriteSettings {
  /** Per-command deadline. */
  readonly timeoutMs?: number;
  /** Per-command stdout cap. */
  readonly maxOutputBytes?: number;
  /** The step's retry policy. */
  readonly retry?: ExecOptions['retry'];
}

/** What `github.ts` lends the writes: policy validation and its incomplete-collection rethrow. @internal */
export interface GithubWriteHelpers {
  /** Validate the third argument. */
  readonly policy: (policy: unknown) => GithubWriteSettings;
  /** Rethrow an exec schema failure that names a truncated connection as `IncompleteCollectionError`. */
  readonly rethrow: (error: unknown, id: string) => never;
  /** The wait between confirmation reads; tests inject one that does not wait. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The write ops of the client, before `github.ts` adds the reads to `issue`. @internal */
export interface GithubWriteOps {
  /** See `GithubClient.comment`. */
  readonly comment: (
    id: string,
    args: GithubCommentOptions,
    policy?: GithubWriteSettings,
  ) => Promise<GithubCommentResult>;
  /** See `GithubClient.thread`. */
  readonly thread: {
    readonly reply: (
      id: string,
      args: GithubThreadReplyOptions,
      policy?: GithubWriteSettings,
    ) => Promise<GithubThreadReplyResult>;
  };
  /** See `GithubClient.issue`. */
  readonly issue: {
    readonly create: (
      id: string,
      args: GithubIssueCreateOptions,
      policy?: GithubWriteSettings,
    ) => Promise<GithubIssueCreateResult>;
    readonly close: (
      id: string,
      args: GithubIssueCloseOptions,
      policy?: GithubWriteSettings,
    ) => Promise<GithubIssueStateResult>;
    readonly reopen: (
      id: string,
      args: GithubIssueReopenOptions,
      policy?: GithubWriteSettings,
    ) => Promise<GithubIssueStateResult>;
  };
  /** See `GithubClient.alert`. */
  readonly alert: {
    readonly dismiss: (
      id: string,
      args: GithubAlertDismissOptions,
      policy?: GithubWriteSettings,
    ) => Promise<GithubAlertDismissResult>;
  };
  /** See `GithubPullRequestWrites`. */
  readonly pr: {
    readonly create: (
      id: string,
      args: GithubPrCreateOptions,
      policy?: GithubWriteSettings,
    ) => Promise<GithubPrCreateResult>;
    readonly edit: (
      id: string,
      args: GithubPrEditOptions,
      policy?: GithubWriteSettings,
    ) => Promise<GithubPrEditResult>;
    readonly merge: (
      id: string,
      args: GithubPrMergeOptions,
      policy?: GithubWriteSettings,
    ) => Promise<GithubPrMergeResult>;
  };
  /** See `GithubChecksWrites`. */
  readonly checks: {
    readonly rerunFailed: (
      id: string,
      args: GithubRerunFailedOptions,
      policy?: GithubWriteSettings,
    ) => Promise<GithubRerunFailedResult>;
  };
}

/** Bounds of a confirmation: merge-down's land loop, 20 reads 3 seconds apart. @internal */
export interface ConfirmBounds {
  /** Reads, the first at once. */
  readonly attempts: number;
  /** Milliseconds between reads. */
  readonly delayMs: number;
  /** The wait between reads. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Aborts the wait. */
  readonly signal: AbortSignal;
}

/** The default bounds' counts. @internal */
export const CONFIRM_ATTEMPTS = 20;
/** @internal */
export const CONFIRM_DELAY_MS = 3_000;

/** Wait `ms`, rejecting with the signal's reason when it aborts. @internal */
export async function signalSleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  }
}

/**
 * Read until `done` holds, at most `attempts` reads with `delayMs` between them, the first at
 * once. Returns whether it held and the last value read; a read that throws rejects. @internal
 */
export async function confirm<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  bounds: ConfirmBounds,
): Promise<{ readonly done: boolean; readonly last: T | undefined }> {
  let last: T | undefined;
  for (let index = 0; index < bounds.attempts; index++) {
    if (index > 0) await bounds.sleep(bounds.delayMs, bounds.signal);
    last = await read();
    if (done(last)) return { done: true, last };
  }
  return { done: false, last };
}

/**
 * Version constants of the write steps. They are part of the replay contract: bump one only for a
 * deliberate change of the op's recorded behaviour or result, never for a refactor, since a bump
 * makes completed steps of that op refuse on resume. test/builtin-identity.test.ts pins them.
 */
const VERSIONS = {
  comment: 'github.comment/1',
  'thread.reply': 'github.thread.reply/1',
  'issue.create': 'github.issue.create/1',
  'issue.close': 'github.issue.close/1',
  'issue.reopen': 'github.issue.reopen/1',
  'alert.dismiss': 'github.alert.dismiss/1',
  'pr.create': 'github.pr.create/1',
  'pr.edit': 'github.pr.edit/1',
  'pr.merge': 'github.pr.merge/1',
  'checks.rerunFailed': 'github.checks.rerunFailed/2',
} as const;

type WriteOp = keyof typeof VERSIONS;

const closeReasons: readonly GithubIssueCloseReason[] = ['completed', 'not_planned'];
const dismissReasons: readonly GithubAlertDismissReason[] = [
  'false positive',
  'used in tests',
  "won't fix",
];
const mergeMethods: readonly GithubPrMergeMethod[] = ['squash', 'merge', 'rebase'];

/** A branch name: nonempty text without NUL; a cross-fork `OWNER:BRANCH` head throws. */
function branch(value: unknown, label: string): string {
  const name = text(value, label);
  if (name.includes(':'))
    throw new Error(`${label} must be a branch in the same repository, without an OWNER: prefix.`);
  return name;
}

function options(value: unknown, op: WriteOp): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object')
    throw new Error(`github ${op} arguments must be an object.`);
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Validate the `attempts` option of `checks.rerunFailed`: a plain object whose keys are canonical
 * decimal run IDs and whose values are positive integers. The record is the recorded step input,
 * keyed in ascending numeric order (run IDs past 2^32 are not array indices, so insertion order is
 * kept); the map is what selection reads.
 */
function runAttempts(
  value: unknown,
  op: WriteOp,
): { readonly record: Record<string, number>; readonly map: Map<number, number> } {
  const label = `github ${op} attempts`;
  const record: Record<string, number> = {};
  const map = new Map<number, number>();
  if (value === undefined) return { record, map };
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object of run ID to attempt.`);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${label} must be an object of run ID to attempt.`);
  const entries = Object.entries(value as Record<string, unknown>).map(([key, attempt]) => {
    if (!/^[1-9][0-9]*$/.test(key) || !Number.isSafeInteger(Number(key)))
      throw new Error(`${label} key ${JSON.stringify(key)} must be a positive integer run ID.`);
    return [Number(key), positiveInteger(attempt, `${label}[${key}]`)] as const;
  });
  for (const [id, attempt] of entries.sort(([left], [right]) => left - right)) {
    record[String(id)] = attempt;
    map.set(id, attempt);
  }
  return { record, map };
}

function optionalText(value: unknown, label: string): string | null {
  return value === undefined ? null : text(value, label);
}

function labelList(value: unknown, op: WriteOp): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error(`github ${op} labels must be an array of strings.`);
  return (value as unknown[]).map((label) => text(label, `github ${op} label`));
}

/** `repo` as it enters a write's identity: `HOST/OWNER/REPO` or `OWNER/REPO`. */
const repoKey = (repo: GithubRepo): string =>
  repo.host === null ? repo.nameWithOwner : `${repo.host}/${repo.nameWithOwner}`;

/** Build the write ops for `repo`. @internal */
export function githubWrites(
  ctx: Pick<WorkflowContext, 'step'>,
  repo: GithubRepo,
  helpers: GithubWriteHelpers,
): GithubWriteOps {
  const key = repoKey(repo);

  /** One version-identified step per op. */
  function step<T>(
    op: WriteOp,
    id: string,
    input: Readonly<Record<string, JsonValue>>,
    schema: z.ZodType<T>,
    settings: GithubWriteSettings,
    run: (gh: Gh) => Promise<T>,
  ): Promise<T> {
    return ctx.step(id, {
      // Identified by the op's version, not callback text (see VERSIONS); `identity` is an
      // internal field of the step definition, as decision.choose uses it.
      version: VERSIONS[op],
      identity: 'version',
      input: { repo: key, ...input },
      schema,
      meta: { integration: 'github', op },
      ...(settings.retry === undefined ? {} : { retry: settings.retry }),
      run: (context) => run(commands(context, id, settings)),
    });
  }

  /** The commands of one attempt, with the per-command policy. */
  interface Gh {
    /** The step's idempotency key, the marker's content. */
    readonly key: string;
    /** Run a read. */
    read<R>(argv: [string, ...string[]], schema: z.ZodType<R>): Promise<R>;
    /** Run a write with its body on stdin. */
    write<R>(request: GithubWriteRequest, schema: z.ZodType<R>): Promise<R>;
    /** Run a write without a body whose stdout is JSON, accepting `okExitCodes`. */
    json<R>(
      argv: [string, ...string[]],
      schema: z.ZodType<R>,
      okExitCodes: readonly number[],
    ): Promise<R>;
    /** Run a write without a body whose stdout is empty; a nonzero exit throws. */
    run(argv: [string, ...string[]]): Promise<void>;
    /** The bounds of a confirmation loop. */
    readonly bounds: ConfirmBounds;
  }

  function commands(context: StepContext, id: string, settings: GithubWriteSettings): Gh {
    const limits = {
      ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
      ...(settings.maxOutputBytes === undefined ? {} : { maxOutputBytes: settings.maxOutputBytes }),
    };
    return {
      key: context.idempotencyKey,
      async read(argv, schema) {
        try {
          return await context.exec.json(argv, { schema: helperRefinements(schema), ...limits });
        } catch (error) {
          return helpers.rethrow(error, id);
        }
      },
      write: (request, schema) =>
        context.exec.json(request.argv, {
          schema: helperRefinements(schema),
          input: request.input,
          ...limits,
        }),
      json: (argv, schema, okExitCodes) =>
        context.exec.json(argv, { schema: helperRefinements(schema), okExitCodes, ...limits }),
      async run(argv) {
        await context.exec(argv, limits);
      },
      bounds: {
        attempts: CONFIRM_ATTEMPTS,
        delayMs: CONFIRM_DELAY_MS,
        sleep: helpers.sleep ?? signalSleep,
        signal: context.signal,
      },
    };
  }

  /** Find the marked comment on an issue or pull request, or post it. */
  async function reconcileComment(
    gh: Gh,
    number: number,
    body: string,
  ): Promise<GithubCommentResult> {
    const marked = withMarker(body, gh.key);
    const spec = issueCommentsRestRead(repo, number);
    const existing = findMarked(spec.map(await gh.read(spec.argv, spec.schema)), gh.key);
    if (existing !== undefined) return { id: existing.id, url: existing.url, created: false };
    const posted = await gh.write(
      restWrite(repo, 'POST', `issues/${String(number)}/comments`, { body: marked }),
      commentPostResponseSchema,
    );
    return { id: posted.id, url: posted.html_url, created: true };
  }

  /** Close or reopen when the state matches. */
  function changeState(
    op: 'issue.close' | 'issue.reopen',
    id: string,
    args: unknown,
    policy: unknown,
  ): Promise<GithubIssueStateResult> {
    const close = op === 'issue.close';
    const given = options(args, op);
    const settings = helpers.policy(policy);
    const number = positiveInteger(given['number'], `github ${op} number`);
    const comment = optionalText(given['comment'], `github ${op} comment`);
    const expected = close ? 'open' : 'closed';
    const ifState = choice(given['ifState'] ?? expected, [expected], `github ${op} ifState`);
    const reason = close
      ? choice(given['reason'] ?? 'completed', closeReasons, `github ${op} reason`)
      : null;
    if (comment !== null) checkBodyLength(comment, `github ${op} comment`);
    return step(
      op,
      id,
      { number, comment, ifState, ...(close ? { reason } : {}) },
      issueStateResultSchema,
      settings,
      async (gh) => {
        const issue = (await gh.read(issueStateArgv(repo, number), issueStateResponseSchema)).data
          .repository.issue;
        if (!stateMatches(issue.state, ifState))
          return {
            number,
            state: issue.state,
            stateReason: issue.stateReason,
            acted: false,
            comment: null,
          };
        // The comment goes first: after a crash past the state change, a retry sees the state no
        // longer matching and skips, so a comment posted after it could be lost.
        const posted = comment === null ? null : await reconcileComment(gh, number, comment);
        await gh.write(
          restWrite(
            repo,
            'PATCH',
            `issues/${String(number)}`,
            close ? { state: 'closed', state_reason: reason } : { state: 'open' },
          ),
          issuePatchResponseSchema,
        );
        return {
          number,
          state: close ? 'CLOSED' : 'OPEN',
          stateReason: close ? (reason ?? 'completed').toUpperCase() : 'REOPENED',
          acted: true,
          comment: posted,
        };
      },
    );
  }

  return {
    comment: (id, args, policy) => {
      const given = options(args, 'comment');
      const settings = helpers.policy(policy);
      const number = positiveInteger(given['number'], 'github comment number');
      const body = text(given['body'], 'github comment body');
      checkBodyLength(body, 'github comment body');
      return step('comment', id, { number, body }, commentResultSchema, settings, (gh) =>
        reconcileComment(gh, number, body),
      );
    },

    thread: {
      reply: (id, args, policy) => {
        const given = options(args, 'thread.reply');
        const settings = helpers.policy(policy);
        const threadId = text(given['threadId'], 'github thread.reply threadId');
        const body = text(given['body'], 'github thread.reply body');
        const resolve = given['resolve'];
        if (resolve !== undefined && typeof resolve !== 'boolean')
          throw new Error('github thread.reply resolve must be a boolean.');
        checkBodyLength(body, 'github thread.reply body');
        return step(
          'thread.reply',
          id,
          { threadId, body, resolve: resolve ?? null },
          threadReplyResultSchema,
          settings,
          async (gh) => {
            const marked = withMarker(body, gh.key);
            const pages = await gh.read(threadReadArgv(repo, threadId), threadReadResponseSchema);
            const thread = pages[0]?.data.node ?? null;
            if (thread === null)
              throw new Error(`github thread.reply ${id}: no review thread ${threadId}.`);
            const comments = pages.flatMap((page) => page.data.node?.comments.nodes ?? []);
            const existing = findMarked(comments, gh.key);
            const reply =
              existing ??
              (
                await gh.write(
                  graphqlWrite(repo, REPLY_MUTATION, { threadId, body: marked }),
                  replyResponseSchema,
                )
              ).data.addPullRequestReviewThreadReply.comment;
            const wanted = shouldResolve(comments[0]?.author, resolve);
            const resolving = wanted && !thread.isResolved;
            if (resolving)
              await gh.write(
                graphqlWrite(repo, RESOLVE_MUTATION, { threadId }),
                resolveResponseSchema,
              );
            return {
              comment: { id: reply.id, url: reply.url },
              created: existing === undefined,
              resolved: thread.isResolved || resolving,
            };
          },
        );
      },
    },

    issue: {
      create: (id, args, policy) => {
        const given = options(args, 'issue.create');
        const settings = helpers.policy(policy);
        const title = text(given['title'], 'github issue.create title');
        const body = text(given['body'], 'github issue.create body');
        const labels = labelList(given['labels'], 'issue.create');
        const parent =
          given['parent'] === undefined
            ? null
            : positiveInteger(given['parent'], 'github issue.create parent');
        checkBodyLength(body, 'github issue.create body');
        return step(
          'issue.create',
          id,
          { title, body, labels, parent },
          issueCreateResultSchema,
          settings,
          async (gh) => {
            // Read the wanted parent first, so a parent that does not exist (or is a pull request)
            // fails before any write instead of leaving an unlinked issue behind.
            const wanted =
              parent === null
                ? null
                : (await gh.read(parentIdReadArgv(repo, parent), parentIdResponseSchema)).data
                    .repository.wanted;
            const marked = withMarker(body, gh.key);
            const info = repoInfoRead(repo);
            const viewer = info.map(await gh.read(info.argv, info.schema)).viewer;
            // The REST list, not search: search's index lags, and would miss exactly the issue a
            // crashed attempt has just created. Newest first, so that issue is on the first page.
            let found: { number: number; html_url: string; node_id: string } | undefined;
            for (let page = 1; found === undefined; page++) {
              const rows = await gh.read(issueListArgv(repo, viewer, page), issueListPageSchema);
              found = findMarked(
                rows.filter((row) => row.pull_request === undefined || row.pull_request === null),
                gh.key,
              );
              if (rows.length < ISSUE_PAGE_SIZE) break;
            }
            const issue =
              found ??
              (await gh.write(
                restWrite(repo, 'POST', 'issues', {
                  title,
                  body: marked,
                  ...(labels === null ? {} : { labels }),
                }),
                issuePostResponseSchema,
              ));
            if (wanted !== null) {
              if (found === undefined) {
                // A fresh issue has no parent. If something links it first, addSubIssue refuses
                // and the retry takes the found path below, which reads the parent.
                await gh.write(
                  graphqlWrite(repo, ADD_SUB_ISSUE_MUTATION, {
                    issueId: wanted.id,
                    subIssueId: issue.node_id,
                  }),
                  addSubIssueResponseSchema,
                );
              } else {
                const { child } = (
                  await gh.read(parentReadArgv(repo, issue.number), parentReadResponseSchema)
                ).data.repository;
                const current = child.parent;
                const decision = parentDecision(current, wanted);
                if (decision === 'different' && current !== null)
                  throw new Error(
                    `github issue.create ${id}: issue #${String(issue.number)} already has parent ${current.repository.nameWithOwner}#${String(current.number)}, not #${String(parent)}; it is never moved.`,
                  );
                if (decision === 'link')
                  await gh.write(
                    graphqlWrite(repo, ADD_SUB_ISSUE_MUTATION, {
                      issueId: wanted.id,
                      subIssueId: child.id,
                    }),
                    addSubIssueResponseSchema,
                  );
              }
            }
            return {
              number: issue.number,
              url: issue.html_url,
              nodeId: issue.node_id,
              created: found === undefined,
              parent,
            };
          },
        );
      },
      close: (id, args, policy) => changeState('issue.close', id, args, policy),
      reopen: (id, args, policy) => changeState('issue.reopen', id, args, policy),
    },

    alert: {
      dismiss: (id, args, policy) => {
        const given = options(args, 'alert.dismiss');
        const settings = helpers.policy(policy);
        const number = positiveInteger(given['number'], 'github alert.dismiss number');
        const comment = truncateDismissComment(
          text(given['comment'], 'github alert.dismiss comment'),
        );
        const reason =
          given['reason'] === undefined
            ? null
            : choice(given['reason'], dismissReasons, 'github alert.dismiss reason');
        return step(
          'alert.dismiss',
          id,
          { number, comment, reason },
          alertDismissResultSchema,
          settings,
          async (gh) => {
            const alert = await gh.read(alertReadArgv(repo, number), alertResponseSchema);
            if (alertSettled(alert.state))
              return {
                number,
                state: alert.state,
                reason: alert.dismissed_reason ?? null,
                dismissed: false,
              };
            const dismissedReason = alertDismissReason(
              alert.most_recent_instance?.location?.path ?? null,
              reason ?? undefined,
            );
            await gh.write(
              restWrite(repo, 'PATCH', `code-scanning/alerts/${String(number)}`, {
                state: 'dismissed',
                dismissed_reason: dismissedReason,
                dismissed_comment: comment,
              }),
              alertPatchResponseSchema,
            );
            return { number, state: 'dismissed', reason: dismissedReason, dismissed: true };
          },
        );
      },
    },

    pr: {
      create: (id, args, policy) => {
        const given = options(args, 'pr.create');
        const settings = helpers.policy(policy);
        const head = branch(given['head'], 'github pr.create head');
        const base = branch(given['base'], 'github pr.create base');
        const title = text(given['title'], 'github pr.create title');
        const body = text(given['body'], 'github pr.create body');
        const draft = given['draft'] ?? false;
        if (typeof draft !== 'boolean')
          throw new Error('github pr.create draft must be a boolean.');
        checkBodyLength(body, 'github pr.create body');
        return step(
          'pr.create',
          id,
          { head, base, title, body, draft },
          prCreateResultSchema,
          settings,
          async (gh) => {
            const marked = withMarker(body, gh.key);
            const rows = await gh.read(pullListArgv(repo, head), pullListResponseSchema);
            const decision = createDecision(rows, gh.key, base);
            if (decision.kind !== 'create') {
              const { row } = decision;
              return {
                number: row.number,
                url: row.html_url,
                nodeId: row.node_id,
                state: pullListState(row),
                created: false,
              };
            }
            // An open pull request for head and base that appeared since the list makes GitHub
            // answer 422; the attempt fails, and a retry finds it.
            const pull = await gh.write(
              restWrite(repo, 'POST', 'pulls', { title, head, base, body: marked, draft }),
              pullPostResponseSchema,
            );
            return {
              number: pull.number,
              url: pull.html_url,
              nodeId: pull.node_id,
              state: 'open',
              created: true,
            };
          },
        );
      },

      edit: (id, args, policy) => {
        const given = options(args, 'pr.edit');
        const settings = helpers.policy(policy);
        const number = positiveInteger(given['number'], 'github pr.edit number');
        const expectHead = fullSha(given['expectHead'], 'github pr.edit expectHead');
        const title = optionalText(given['title'], 'github pr.edit title');
        const body = optionalText(given['body'], 'github pr.edit body');
        const base =
          given['base'] === undefined ? null : branch(given['base'], 'github pr.edit base');
        if (title === null && body === null && base === null)
          throw new Error('github pr.edit needs at least one of title, body and base.');
        if (body !== null) checkBodyLength(body, 'github pr.edit body');
        return step(
          'pr.edit',
          id,
          { number, expectHead, title, body, base },
          prEditResultSchema,
          settings,
          async (gh) => {
            const pull = await gh.read(pullReadArgv(repo, number), pullResponseSchema);
            const head = pull.head.sha;
            if (pullState(pull) !== 'open')
              return { number, edited: false, reason: 'closed', head, changed: [] };
            if (head !== expectHead)
              return { number, edited: false, reason: 'head-moved', head, changed: [] };
            // Only the fields that differ: nothing differs after a committed PATCH, so a retry
            // sends none.
            const { changed, patch } = editChanges(pull, { title, body, base });
            if (changed.length > 0)
              await gh.write(
                restWrite(repo, 'PATCH', `pulls/${String(number)}`, patch),
                pullPatchResponseSchema,
              );
            return { number, edited: changed.length > 0, reason: null, head, changed };
          },
        );
      },

      merge: (id, args, policy) => {
        const given = options(args, 'pr.merge');
        const settings = helpers.policy(policy);
        const number = positiveInteger(given['number'], 'github pr.merge number');
        const sha = fullSha(given['sha'], 'github pr.merge sha');
        const method = choice(given['method'] ?? 'squash', mergeMethods, 'github pr.merge method');
        return step(
          'pr.merge',
          id,
          { number, sha, method },
          prMergeResultSchema,
          settings,
          async (gh) => {
            const read = () => gh.read(pullReadArgv(repo, number), pullResponseSchema);
            /** A decision that needs no PUT, from a read. */
            const settled = (
              pull: PullResponse,
              decision: 'merged' | 'merged-elsewhere' | 'closed' | 'head-moved' | 'not-mergeable',
              message: string | null,
            ): GithubPrMergeResult => {
              if (decision === 'merged')
                return {
                  merged: true,
                  number,
                  mergeCommit: pull.merge_commit_sha,
                  head: sha,
                  acted: false,
                };
              if (decision === 'merged-elsewhere')
                throw new Error(
                  `github pr.merge ${id}: pull request #${String(number)} is merged at head ${pull.head.sha}, not ${sha}.`,
                );
              return { merged: false, number, reason: decision, head: pull.head.sha, message };
            };
            const before = await read();
            const precheck = mergePrecheck(before, sha);
            if (precheck !== 'put') return settled(before, precheck, null);
            // gh exits 1 on an HTTP error and prints GitHub's error body.
            const response = await gh.json(
              mergeArgv(repo, number, method, sha),
              mergeResponseSchema,
              [0, 1],
            );
            if ('merged' in response) {
              // Merged now: wait until the pull request says so, as merge-down's land does, so a
              // following read never sees it open.
              const seen = await confirm(read, (pull) => pull.merged, gh.bounds);
              if (!seen.done)
                throw new Error(
                  `github pr.merge ${id}: GitHub merged #${String(number)} but it did not report merged after ${String(gh.bounds.attempts)} reads; a retry finds the merge.`,
                );
              return { merged: true, number, mergeCommit: response.sha, head: sha, acted: true };
            }
            const after = await read();
            const failure = mergeFailure(response, after, sha);
            if (failure === 'unknown')
              throw new Error(
                `github pr.merge ${id}: GitHub refused to merge #${String(number)}${response.status === undefined ? '' : ` (HTTP ${String(response.status)})`}: ${response.message}`,
              );
            return settled(after, failure, failure === 'merged' ? null : response.message);
          },
        );
      },
    },

    checks: {
      rerunFailed: (id, args, policy) => {
        const given = options(args, 'checks.rerunFailed');
        const settings = helpers.policy(policy);
        const sha = fullSha(given['sha'], 'github checks.rerunFailed sha');
        const attempt =
          given['attempt'] === undefined
            ? 1
            : positiveInteger(given['attempt'], 'github checks.rerunFailed attempt');
        const attempts = runAttempts(given['attempts'], 'checks.rerunFailed');
        return step(
          'checks.rerunFailed',
          id,
          { sha, attempt, attempts: attempts.record },
          rerunFailedResultSchema,
          settings,
          async (gh) => {
            const list = async () =>
              uniqueRuns(await gh.read(runsListArgv(repo, sha), runsListResponseSchema));
            const selection = rerunSelection(await list(), attempt, attempts.map);
            const rerun = selection.rerun.map(runRefOf);
            // GitHub answers 201 with no body, so a plain exec.
            for (const run of rerun) await gh.run(rerunArgv(repo, run.id));
            // Best effort: a following waitChecks should not read the failure just rerun.
            const confirmed =
              rerun.length === 0 ||
              (await confirm(list, (runs) => rerunConfirmed(runs, rerun), gh.bounds)).done;
            return { rerun, skipped: selection.skipped.map(runRefOf), confirmed };
          },
        );
      },
    },
  };
}
