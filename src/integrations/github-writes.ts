/**
 * Reconciled GitHub writes of `quiet-choir/github`
 * ([ADR 0046](../../docs/decisions/0046-reconciled-github-writes.md)). Each op is exactly one
 * `ctx.step` under the caller's ID, identified by a versioned constant such as
 * `github.comment/1` instead of callback text. Its callback reads first and writes only what an
 * earlier attempt did not: a write that creates something carries the step's marker and is found
 * by it, and a state change is conditional on a preceding read. Every gh call goes through
 * `StepContext.exec.json`, with request bodies on stdin, so a `--dry-run` lists the reads and writes
 * and spawns nothing.
 */
import type { ExecOptions, JsonValue, StepContext, WorkflowContext, z } from '../index.js';
import { choice, positiveInteger, repoInfoRead, text, type GithubRepo } from './github-model.js';
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
  parentDecision,
  parentReadArgv,
  parentReadResponseSchema,
  replyResponseSchema,
  REPLY_MUTATION,
  resolveResponseSchema,
  RESOLVE_MUTATION,
  restWrite,
  shouldResolve,
  stateMatches,
  threadReadArgv,
  threadReadResponseSchema,
  threadReplyResultSchema,
  truncateDismissComment,
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
  type GithubThreadReplyOptions,
  type GithubThreadReplyResult,
  type GithubWriteRequest,
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
} as const;

type WriteOp = keyof typeof VERSIONS;

const closeReasons: readonly GithubIssueCloseReason[] = ['completed', 'not_planned'];
const dismissReasons: readonly GithubAlertDismissReason[] = [
  'false positive',
  'used in tests',
  "won't fix",
];

function options(value: unknown, op: WriteOp): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object')
    throw new Error(`github ${op} arguments must be an object.`);
  return value as Readonly<Record<string, unknown>>;
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
          return await context.exec.json(argv, { schema, ...limits });
        } catch (error) {
          return helpers.rethrow(error, id);
        }
      },
      write: (request, schema) =>
        context.exec.json(request.argv, { schema, input: request.input, ...limits }),
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
            if (parent !== null) {
              const { child, wanted } = (
                await gh.read(parentReadArgv(repo, issue.number, parent), parentReadResponseSchema)
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
  };
}
