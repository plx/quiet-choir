import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defineWorkflow,
  ExecError,
  NodeProcessRunner,
  readRun,
  runWorkflow,
  z,
  type ExecResult,
  type ProcessRunner,
  type WorkflowClock,
  type WorkflowContext,
} from '../src/index.js';
import { createFakeBinary, type FakeBinary } from '../src/harness-kit.js';
import {
  codeqlReviewer,
  codexReviewer,
  github,
  IncompleteCollectionError,
  type GithubClient,
  type RawCheckContext,
  type RawRestIssueComment,
  type RawRestReview,
  type ReviewActivity,
  type ReviewerBot,
  type ReviewerContext,
} from '../src/integrations/github.js';
import {
  aggregateReview,
  classifyWaitError,
  codeqlObserve,
  codexObserve,
  decideChecks,
  decidePr,
  headDecision,
  parseSummaryRows,
  untriagedThreads,
} from '../src/integrations/github-wait-model.js';
import type {
  GithubChecks,
  GithubPullRequestHead,
  GithubReviewThread,
} from '../src/integrations/github-model.js';
import { summarizeChecks } from '../src/integrations/github-model.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import { formatRunSummary } from '../src/cli/inspection-view.js';
import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { TickWorkflowExecutor } from '../src/workflow/loader/tick.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
/** Recorded `gh` stdout from read-only probes of this repository, trimmed and scrubbed. */
const fixture = (name: string): string =>
  readFileSync(join(repository, 'test', 'fixtures', 'github', name), 'utf8');
const json = (name: string): unknown => JSON.parse(fixture(name));
/** The first item of a recorded list; fixtures are never empty. */
function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('empty fixture');
  return item;
}
const logger = new ThresholdLogger('silent', () => undefined);

// The recorded pull request (#338 of this repository, scrubbed): Codex reviewed 6ac5df5 and
// 2a93aa6 with findings, then c5c2233 clean (a "Completed" summary row and a +1 reaction).
const SHA = 'c5c2233fa0c0b9e89b688f2c40ca9364275efd87';
const ANCESTOR = '6ac5df5b9f0e918bf0548306ff2c562013a50f3a';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SINCE = Date.parse('2026-10-03T05:30:00Z');
const REPO = 'octo-org/quiet-choir';

let cwd: string;
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'choir-github-waits-')));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});
const setup = (runId = 'waits') => ({ cwd, stateDir: join(cwd, 'state'), runId, input: null });
const definition = (run: (ctx: WorkflowContext) => Promise<unknown>) =>
  defineWorkflow({ name: 'github-waits', version: '1', input: z.null(), output: z.unknown(), run });

// ---------------------------------------------------------------------------------------------
// Recorded responses and builders

const checkRun = (
  name: string,
  conclusion: string | null = 'SUCCESS',
  runId = 37078499704,
): RawCheckContext => ({
  __typename: 'CheckRun',
  name,
  status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
  conclusion,
  detailsUrl: `https://github.com/octo-org/quiet-choir/actions/runs/${String(runId)}/job/1`,
  checkSuite: { workflowRun: { databaseId: runId } },
});
const green = [checkRun('Quality and package'), checkRun('CodeQL')];

/** The recorded `pr.view` response with another head, rollup commit, state and checks. */
function prView(
  options: {
    readonly head?: string;
    readonly rollup?: string;
    readonly state?: string;
    readonly checks?: readonly RawCheckContext[];
  } = {},
): unknown {
  const raw = json('pr-view.json') as {
    data: {
      repository: {
        pullRequest: {
          headRefOid: string;
          state: string;
          commits: { nodes: { commit: { oid: string; statusCheckRollup: unknown } }[] };
        };
      };
    };
  };
  const pr = raw.data.repository.pullRequest;
  const head = options.head ?? SHA;
  pr.headRefOid = head;
  pr.state = options.state ?? 'OPEN';
  const checks = options.checks ?? green;
  pr.commits.nodes = [
    {
      commit: {
        oid: options.rollup ?? head,
        statusCheckRollup: checks.length
          ? { state: 'PENDING', contexts: { pageInfo: { hasNextPage: false }, nodes: checks } }
          : null,
      },
    },
  ];
  return raw;
}
const prState = (state: string, head = SHA, merge: string | null = null) => ({
  data: {
    repository: {
      pullRequest: { state, headRefOid: head, mergeCommit: merge === null ? null : { oid: merge } },
    },
  },
});
const comments = (): RawRestIssueComment[] =>
  json('rest-issue-comments.json') as RawRestIssueComment[];
const codexReview = (commit: string, submittedAt: string): RawRestReview => ({
  ...first(json('rest-reviews.json') as RawRestReview[]),
  id: 5400000001,
  commit_id: commit,
  submitted_at: submittedAt,
});
/** The recorded summary comment with its row's status replaced. */
function summary(status: string, updatedAt = '2026-10-03T06:20:23Z'): RawRestIssueComment {
  const recorded = first(comments());
  return {
    ...recorded,
    body: (recorded.body ?? '').replace('✅ **Completed**', status),
    updated_at: updatedAt,
  };
}
const threads = (unresolved: readonly [string, string][] = []) => {
  const pages = json('review-threads.json') as {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: { id: string; isResolved: boolean; comments: { nodes: unknown[] } }[];
          };
        };
      };
    };
  }[];
  const nodes = pages.flatMap((page) => page.data.repository.pullRequest.reviewThreads.nodes);
  for (const [id, lastAuthor] of unresolved) {
    const thread = nodes.find((node) => node.id === id);
    if (!thread) throw new Error(`no thread ${id}`);
    thread.isResolved = false;
    thread.comments.nodes.push({
      databaseId: 1,
      author: { login: lastAuthor, __typename: 'User' },
      body: 'reply',
      url: 'https://github.com/octo-org/quiet-choir/pull/338#discussion_r1',
      createdAt: '2026-10-03T06:30:00Z',
    });
  }
  return pages;
};
const openAlerts = (...numbers: number[]) =>
  (json('code-scanning-alerts.json') as { number: number; state: string }[])
    .slice(0, numbers.length)
    .map((alert, index) => ({ ...alert, number: numbers[index], state: 'open' }));
const finalReads = {
  'pr.reviewThreads': [{ json: threads() }],
  'repo.info': [{ stdout: fixture('repo-info.json') }],
  'codeScanning.alerts': [{ json: [] }],
};

// ---------------------------------------------------------------------------------------------
// Fake gh: an in-process ProcessRunner and a real executable answering the same scenarios

interface Reply {
  readonly json?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}
/** Replies per read; call n gets reply n, and the last reply repeats. */
type Scenario = Readonly<Record<string, readonly Reply[]>>;

/** The read an argv performs. The fake executable below spells the same rules in JavaScript. */
function readOf(argv: readonly string[]): string {
  const query = argv.find((arg) => arg.startsWith('query=')) ?? '';
  const path = argv.find((arg) => arg.startsWith('repos/')) ?? '';
  if (query.includes('viewer {')) return 'repo.info';
  if (query.includes('reviewThreads(')) return 'pr.reviewThreads';
  if (query.includes('mergeCommit')) return 'pr.state';
  if (query.includes('pullRequest(number')) return 'pr.view';
  if (path.includes('/compare/')) return 'repo.compare';
  if (path.includes('/code-scanning/alerts')) return 'codeScanning.alerts';
  if (/\/issues\/\d+\/comments/u.test(path)) return 'issue.comments';
  if (/\/pulls\/\d+\/reviews/u.test(path)) return 'pr.reviews';
  if (/\/issues\/\d+\/reactions/u.test(path)) return 'issue.reactions';
  return 'unknown';
}

function inProcess(scenario: Scenario): { runner: ProcessRunner; log: string[] } {
  const log: string[] = [];
  const counts = new Map<string, number>();
  const runner: ProcessRunner = {
    run: (request) => {
      const read = readOf(request.command as readonly string[]);
      log.push(read);
      const replies = scenario[read];
      if (!replies?.length)
        return Promise.reject(
          new Error(`Unexpected read ${read}: ${JSON.stringify(request.command)}`),
        );
      const n = counts.get(read) ?? 0;
      counts.set(read, n + 1);
      const reply = replies[Math.min(n, replies.length - 1)] ?? {};
      return Promise.resolve({
        code: reply.code ?? 0,
        signal: null,
        stdout: reply.stdout ?? JSON.stringify(reply.json),
        stderr: reply.stderr ?? '',
        truncated: false,
        durationMs: 1,
      } satisfies ExecResult);
    },
  };
  return { runner, log };
}

// A constant script: the scenario and its counters come from GH_FAKE_DIR, never from spliced code.
const FAKE_GH = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.GH_FAKE_DIR;
const argv = process.argv.slice(2);
const query = argv.find((arg) => arg.startsWith('query=')) ?? '';
const path = argv.find((arg) => arg.startsWith('repos/')) ?? '';
const read = query.includes('viewer {') ? 'repo.info'
  : query.includes('reviewThreads(') ? 'pr.reviewThreads'
  : query.includes('mergeCommit') ? 'pr.state'
  : query.includes('pullRequest(number') ? 'pr.view'
  : path.includes('/compare/') ? 'repo.compare'
  : path.includes('/code-scanning/alerts') ? 'codeScanning.alerts'
  : /\\/issues\\/\\d+\\/comments/.test(path) ? 'issue.comments'
  : /\\/pulls\\/\\d+\\/reviews/.test(path) ? 'pr.reviews'
  : /\\/issues\\/\\d+\\/reactions/.test(path) ? 'issue.reactions'
  : 'unknown';
const counter = join(dir, read + '.count');
const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
writeFileSync(counter, String(n + 1));
appendFileSync(join(dir, 'log'), read + '\\n');
const replies = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'))[read] ?? [];
const reply = replies[Math.min(n, replies.length - 1)];
if (reply === undefined) {
  process.stderr.write('fake gh: unexpected read ' + read + '\\n');
  process.exitCode = 2;
} else {
  if (reply.stderr) process.stderr.write(reply.stderr);
  process.stdout.write(reply.stdout ?? JSON.stringify(reply.json));
  process.exitCode = reply.code ?? 0;
}
`;

/** A real `gh` executable answering `scenario`, and a runner that puts it on PATH. */
async function fakeGh(scenario: Scenario): Promise<{
  gh: FakeBinary;
  dir: string;
  runner: ProcessRunner;
  log: () => Promise<string[]>;
}> {
  const gh = await createFakeBinary('gh', FAKE_GH);
  const dir = join(cwd, 'fake-gh');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'scenario.json'), JSON.stringify(scenario));
  const native = new NodeProcessRunner();
  const runner: ProcessRunner = {
    run: (request, invocation) =>
      native.run({ ...request, env: { ...request.env, ...gh.env, GH_FAKE_DIR: dir } }, invocation),
  };
  const log = async () =>
    (await readFile(join(dir, 'log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { gh, dir, runner, log };
}

const run = (
  wait: (gh: GithubClient, ctx: WorkflowContext) => Promise<unknown>,
  runner: ProcessRunner,
  runId = 'waits',
) =>
  runWorkflow(
    definition((ctx) => wait(github(ctx, { repo: REPO }), ctx)),
    { ...setup(runId), processRunner: runner },
  );

// ---------------------------------------------------------------------------------------------
// Pure rules

const context = (overrides: Partial<ReviewerContext> = {}): ReviewerContext => ({
  sha: SHA,
  since: SINCE,
  now: SINCE + 60_000,
  previous: { note: null, checks: 0 },
  ...overrides,
});
const activity = (overrides: Partial<ReviewActivity> = {}): ReviewActivity => ({
  pr: { number: 338, state: 'OPEN', headRefOid: SHA, checks: summarizeChecks(green) },
  comments: [],
  reviews: [],
  reactions: [],
  alerts: null,
  ...overrides,
});
const at = (iso: string) => Date.parse(iso);
const codexComment = (body: string, created: number, updated = created) => ({
  id: 1,
  author: 'chatgpt-codex-connector[bot]',
  body,
  url: 'https://github.com/octo-org/quiet-choir/pull/338#issuecomment-1',
  createdAt: created,
  updatedAt: updated,
});
const recordedSummary = (status = '✅ **Completed**', updated = at('2026-10-03T06:20:23Z')) =>
  codexComment(summary(status).body ?? '', at('2026-10-03T05:34:14Z'), updated);

describe('Codex rules', () => {
  it('parses the recorded summary rows', () => {
    expect(parseSummaryRows(comments()[0]?.body ?? '')).toEqual([
      { review: 'Code Review', status: 'Completed', commit: 'c5c2233', trigger: 'Manual request' },
    ]);
    expect(parseSummaryRows('no table')).toEqual([]);
  });

  it('applies the rules in order: findings, +1, usage limit, summary row, eyes, pending', () => {
    const review = (commit: string, submittedAt: number) => ({
      id: 7,
      author: 'chatgpt-codex-connector[bot]',
      state: 'COMMENTED',
      commit,
      submittedAt,
    });
    const reaction = (content: string, createdAt: number) => ({
      author: 'chatgpt-codex-connector[bot]',
      content,
      createdAt,
    });
    const fresh = SINCE + 1_000;
    // A findings review on sha beats a +1 and a Completed row.
    expect(
      codexObserve(
        activity({
          reviews: [review(SHA, fresh)],
          reactions: [reaction('+1', fresh)],
          comments: [recordedSummary()],
        }),
        context({ previous: { note: { seenComplete: true }, checks: 1 } }),
      ),
    ).toEqual({ status: 'findings', detail: { reviews: [7] } });
    // A review for another commit is not a finding on sha.
    expect(codexObserve(activity({ reviews: [review(ANCESTOR, fresh)] }), context())).toEqual({
      status: 'pending',
    });
    expect(codexObserve(activity({ reactions: [reaction('+1', fresh)] }), context())).toEqual({
      status: 'clean',
      detail: { via: 'reaction' },
    });
    // The 5 s skew boundary: exactly since - 5000 is fresh, one millisecond earlier is not.
    expect(
      codexObserve(activity({ reactions: [reaction('+1', SINCE - 5_000)] }), context()).status,
    ).toBe('clean');
    expect(
      codexObserve(activity({ reactions: [reaction('+1', SINCE - 5_001)] }), context()).status,
    ).toBe('pending');
    expect(
      codexObserve(activity({ reviews: [review(SHA, SINCE - 5_001)] }), context()).status,
    ).toBe('pending');
    const limit = codexComment('You have reached your Codex usage limits for code reviews.', fresh);
    expect(codexObserve(activity({ comments: [limit] }), context())).toEqual({
      status: 'error',
      detail: { reason: 'Codex usage limit reached' },
    });
    expect(
      codexObserve(activity({ comments: [{ ...limit, createdAt: SINCE - 60_000 }] }), context())
        .status,
    ).toBe('pending');
    for (const status of ['❌ **Failed**', '⚠️ **Error**', '🚫 **Cancelled**'])
      expect(
        codexObserve(activity({ comments: [recordedSummary(status)] }), context()).status,
      ).toBe('error');
    expect(codexObserve(activity({ reactions: [reaction('eyes', 0)] }), context())).toEqual({
      status: 'running',
      detail: { via: 'reaction' },
    });
  });

  it('calls a Completed row clean only on the second consecutive check', () => {
    const completed = activity({ comments: [recordedSummary()] });
    const first = codexObserve(completed, context());
    expect(first).toMatchObject({ status: 'running', note: { seenComplete: true } });
    expect(
      codexObserve(completed, context({ previous: { note: first.note ?? null, checks: 1 } })),
    ).toMatchObject({ status: 'clean', detail: { via: 'summary' } });
    // A row that is no longer Completed resets the debounce: no note is returned.
    const running = codexObserve(
      activity({ comments: [recordedSummary('⏳ **Running**')] }),
      context({ previous: { note: { seenComplete: true }, checks: 1 } }),
    );
    expect(running.status).toBe('running');
    expect(running.note).toBeUndefined();
    // A stale summary (updated before since) or a row for another commit decides nothing.
    expect(
      codexObserve(activity({ comments: [recordedSummary(undefined, SINCE - 60_000)] }), context())
        .status,
    ).toBe('pending');
    expect(
      codexObserve(activity({ comments: [recordedSummary()] }), context({ sha: OTHER })).status,
    ).toBe('pending');
  });
});

describe('CodeQL rules', () => {
  const options = { settleMs: 1_000, checkName: 'CodeQL' };
  const alerts = (...numbers: number[]) => ({
    status: 'ok' as const,
    alerts: numbers.map((number) => ({
      number,
      rule: 'js/x',
      severity: 'high',
      path: 'a.ts',
      line: 1,
      message: 'm',
      state: 'open',
      url: 'u',
    })),
  });
  const withChecks = (checks: GithubChecks | null, found = alerts()) =>
    activity({ pr: { number: 1, state: 'OPEN', headRefOid: SHA, checks }, alerts: found });

  it('waits for the check, then settles before deciding', () => {
    expect(
      codeqlObserve(withChecks(summarizeChecks([checkRun('Quality')])), context(), options),
    ).toEqual({ status: 'pending' });
    expect(codeqlObserve(withChecks(null), context(), options)).toEqual({ status: 'pending' });
    expect(
      codeqlObserve(withChecks(summarizeChecks([checkRun('CodeQL', null)])), context(), options),
    ).toEqual({ status: 'running' });
    // Any conclusion completes it: the check fails when it finds alerts.
    const done = summarizeChecks([checkRun('CodeQL', 'FAILURE')]);
    const now = SINCE + 10_000;
    const first = codeqlObserve(withChecks(done), context({ now }), options);
    expect(first).toEqual({
      status: 'running',
      note: { settleStart: now },
      detail: { settling: true },
    });
    const later = (ms: number, found = alerts()) =>
      codeqlObserve(
        withChecks(done, found),
        context({ now: now + ms, previous: { note: first.note ?? null, checks: 1 } }),
        options,
      );
    expect(later(999)).toMatchObject({ status: 'running', note: { settleStart: now } });
    expect(later(1_000)).toEqual({ status: 'clean' });
    expect(later(1_000, alerts(7, 9))).toEqual({ status: 'findings', detail: { alerts: [7, 9] } });
  });

  it('treats unavailable code scanning as clean', () => {
    expect(
      codeqlObserve(
        withChecks(null, {
          status: 'unavailable',
          reason: 'no analysis found',
          alerts: [],
        } as never),
        context(),
        options,
      ),
    ).toEqual({ status: 'clean', detail: { unavailable: 'no analysis found' } });
  });
});

const head = (
  overrides: Partial<GithubPullRequestHead> & { contexts?: readonly RawCheckContext[] } = {},
): GithubPullRequestHead => {
  const { contexts = green, ...rest } = overrides;
  return {
    number: 338,
    state: 'OPEN',
    headRefOid: SHA,
    rollupOid: overrides.headRefOid ?? SHA,
    checks: summarizeChecks(contexts),
    ...rest,
  };
};
const timing = { sha: SHA, now: 10_000, startedAt: 0, graceMs: 5_000 };

describe('checks rollup', () => {
  it('decides success, failure, pending, closed and no-checks', () => {
    expect(decideChecks(head(), timing)).toMatchObject({
      done: true,
      value: { status: 'success' },
    });
    const pendingAndFailed = head({
      contexts: [checkRun('Quality', 'FAILURE', 11), checkRun('Tests', null)],
    });
    // Failure only once nothing is pending.
    expect(decideChecks(pendingAndFailed, timing)).toEqual({
      done: false,
      progress: {
        headRefOid: SHA,
        failed: [
          {
            name: 'Quality',
            url: 'https://github.com/octo-org/quiet-choir/actions/runs/11/job/1',
            runId: 11,
          },
        ],
        pending: ['Tests'],
      },
    });
    expect(
      decideChecks(
        head({ contexts: [checkRun('Quality', 'FAILURE', 11), checkRun('Tests')] }),
        timing,
      ),
    ).toMatchObject({
      done: true,
      value: { status: 'failure', failed: [{ name: 'Quality', runId: 11 }], pending: [] },
    });
    // A status context has no workflow run ID.
    expect(
      decideChecks(
        head({
          contexts: [
            { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR', targetUrl: null },
          ],
        }),
        timing,
      ),
    ).toMatchObject({ value: { failed: [{ name: 'ci/legacy', url: null, runId: null }] } });
    expect(decideChecks(head({ contexts: [] }), { ...timing, now: 4_999 })).toMatchObject({
      done: false,
    });
    expect(decideChecks(head({ contexts: [] }), { ...timing, now: 5_000 })).toMatchObject({
      done: true,
      value: { status: 'no-checks' },
    });
    expect(
      decideChecks(head({ state: 'MERGED', contexts: [checkRun('Tests', null)] }), timing),
    ).toMatchObject({ done: true, value: { status: 'closed' } });
    // Finished checks of the pinned head still count on a merged pull request.
    expect(decideChecks(head({ state: 'MERGED' }), timing)).toMatchObject({
      value: { status: 'success' },
    });
  });

  it('never uses a rollup that belongs to another commit', () => {
    expect(decideChecks(head({ rollupOid: ANCESTOR }), timing)).toEqual({
      done: false,
      progress: { headRefOid: SHA, failed: [], pending: [] },
    });
    expect(decideChecks(head({ rollupOid: null }), timing)).toMatchObject({ done: false });
    expect(decideChecks(head({ rollupOid: ANCESTOR, state: 'CLOSED' }), timing)).toMatchObject({
      value: { status: 'closed' },
    });
  });
});

describe('pull request states', () => {
  const state = (s: string, h = SHA, merge: string | null = null) => ({
    state: s,
    headRefOid: h,
    mergeCommit: merge,
  });
  it.each(['merged', 'closed'] as const)('decides every state with until %s', (until) => {
    expect(decidePr(state('MERGED', SHA, 'm'.repeat(40)), { sha: SHA, until })).toEqual({
      done: true,
      value: { status: 'merged', headRefOid: SHA, mergeCommit: 'm'.repeat(40) },
    });
    expect(decidePr(state('MERGED', OTHER, 'm'.repeat(40)), { sha: SHA, until })).toEqual({
      done: true,
      value: { status: 'head-moved', headRefOid: OTHER, mergeCommit: null },
    });
    expect(decidePr(state('CLOSED'), { sha: SHA, until })).toMatchObject({
      done: true,
      value: { status: 'closed' },
    });
    expect(decidePr(state('OPEN'), { sha: SHA, until })).toEqual({
      done: false,
      note: { state: 'OPEN', headRefOid: SHA },
    });
    expect(decidePr(state('OPEN', OTHER), { sha: SHA, until })).toEqual(
      until === 'merged'
        ? { done: true, value: { status: 'head-moved', headRefOid: OTHER, mergeCommit: null } }
        : { done: false, note: { state: 'OPEN', headRefOid: OTHER } },
    );
  });
});

describe('aggregation, threads, heads and classification', () => {
  it('ranks findings over error over clean', () => {
    expect(aggregateReview(['clean', 'error', 'findings'])).toBe('findings');
    expect(aggregateReview(['clean', 'error'])).toBe('error');
    expect(aggregateReview(['clean', 'clean'])).toBe('clean');
  });

  it('counts unresolved threads whose last word is not the viewer', () => {
    const thread = (id: string, isResolved: boolean, lastAuthor: string | null) =>
      ({ id, isResolved, lastAuthor }) as GithubReviewThread;
    expect(
      untriagedThreads(
        [
          thread('a', false, 'chatgpt-codex-connector'),
          thread('b', false, 'viewer-login'),
          thread('c', true, 'someone'),
          thread('d', false, null),
        ],
        'viewer-login',
      ),
    ).toEqual(['a', 'd']);
  });

  it('pins heads, comparing only inside the stale grace', () => {
    const options = { now: 1_000, startedAt: 0, staleGraceMs: 5_000, stale: [] };
    expect(headDecision(SHA, SHA, options)).toBe('same');
    expect(headDecision(ANCESTOR, SHA, options)).toBe('compare');
    expect(headDecision(ANCESTOR, SHA, { ...options, stale: [ANCESTOR] })).toBe('stale');
    expect(headDecision(ANCESTOR, SHA, { ...options, now: 5_000 })).toBe('moved');
    expect(headDecision(ANCESTOR, SHA, { ...options, staleGraceMs: 0 })).toBe('moved');
    // A synthesized dry-run head cannot be compared.
    expect(headDecision('string', SHA, options)).toBe('moved');
  });

  it('classifies observation errors from typed facts', () => {
    const result = (code: number, stdout = '') => ({
      code,
      signal: null,
      stdout,
      stderr: '',
      truncated: false,
      durationMs: 1,
    });
    const syntax = (() => {
      try {
        JSON.parse('[{');
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    const cases: [unknown, 'transient' | 'fatal'][] = [
      [new ExecError('exited 1', 'process', result(1, '<html>502</html>')), 'transient'],
      [new ExecError('timed out', 'timeout', result(1)), 'transient'],
      [new ExecError('not JSON', 'schema', result(0, '[{'), { cause: syntax }), 'transient'],
      [
        new ExecError('error body', 'schema', result(1, '{"message":"Server Error"}'), {
          parsed: { message: 'Server Error' },
          cause: new z.ZodError([]),
        }),
        'transient',
      ],
      [
        new ExecError('mismatch', 'schema', result(0, '{"x":1}'), {
          parsed: { x: 1 },
          cause: new z.ZodError([]),
        }),
        'fatal',
      ],
      [new ExecError('too big', 'output-limit', result(0)), 'fatal'],
      [
        new ExecError('exited 1', 'process', result(1), {
          parsed: { message: 'Not Found', status: '404' },
        }),
        'fatal',
      ],
      [
        new ExecError('exited 1', 'process', result(1), {
          parsed: { message: 'Bad credentials', status: '401' },
        }),
        'fatal',
      ],
      [
        new ExecError('exited 1', 'process', result(1), {
          parsed: { data: null, errors: [{ type: 'NOT_FOUND', message: 'no pull request' }] },
        }),
        'fatal',
      ],
      [new IncompleteCollectionError('pullRequest.reviewThreads', 'review'), 'fatal'],
      [new Error('reviewer bug'), 'fatal'],
      [Object.assign(new Error('slow'), { code: 'QUIET_CHOIR_POLL_OBSERVE_TIMEOUT' }), 'transient'],
    ];
    for (const [error, expected] of cases) expect(classifyWaitError(error)).toBe(expected);
  });

  it('never reports success, clean or merged for another head', () => {
    const heads = [OTHER, ANCESTOR, SHA.slice(0, 7), 'string'];
    const contexts = [green, [checkRun('Tests', null)], [checkRun('Tests', 'FAILURE')], []];
    let cases = 0;
    for (const observed of heads)
      for (const rollupOid of [observed, SHA, null])
        for (const state of ['OPEN', 'MERGED', 'CLOSED'])
          for (const checks of contexts) {
            const view = head({ headRefOid: observed, rollupOid, state, contexts: checks });
            for (const now of [0, 10_000]) {
              const decision = decideChecks(view, { ...timing, now });
              if (decision.done) expect(decision.value.status).not.toBe('success');
            }
            for (const until of ['merged', 'closed'] as const) {
              const decision = decidePr(
                { state, headRefOid: observed, mergeCommit: 'm'.repeat(40) },
                { sha: SHA, until },
              );
              if (decision.done) expect(decision.value.status).not.toBe('merged');
            }
            cases++;
          }
    // Codex never calls another commit's review or summary row clean for sha.
    const fresh = SINCE + 1_000;
    for (const commit of [OTHER, ANCESTOR]) {
      const other = activity({
        comments: [
          codexComment(
            (summary('✅ **Completed**').body ?? '').replace('c5c2233', commit.slice(0, 7)),
            fresh,
          ),
        ],
        reviews: [{ id: 1, author: 'x', state: 'COMMENTED', commit, submittedAt: fresh }],
      });
      expect(
        codexObserve(other, context({ previous: { note: { seenComplete: true }, checks: 1 } }))
          .status,
      ).not.toBe('clean');
    }
    expect(cases).toBe(144);
  });
});

// ---------------------------------------------------------------------------------------------
// In-process scenarios

describe('waitPr', () => {
  const merge = 'ddc48ee7132b68166f05e40ee84c3b155d0e819d';
  const outcome = async (replies: Reply[], until: 'merged' | 'closed', runId: string) => {
    const { runner, log } = inProcess({ 'pr.state': replies });
    const result = await run(
      (gh) => gh.waitPr('merged', { pr: 350, sha: SHA, until, every: 5, timeoutMs: 60_000 }),
      runner,
      runId,
    );
    return { output: result.output, log };
  };

  it.each(['merged', 'closed'] as const)(
    'reports a pull request closed without merging at once with until %s',
    async (until) => {
      const { output, log } = await outcome(
        [{ json: prState('CLOSED') }],
        until,
        `closed-${until}`,
      );
      expect(output).toEqual({ status: 'closed', headRefOid: SHA, mergeCommit: null });
      expect(log).toEqual(['pr.state']);
    },
  );

  it('reports merged with its merge commit only for the pinned head', async () => {
    const recorded = json('pr-state.json') as ReturnType<typeof prState>;
    const head = recorded.data.repository.pullRequest.headRefOid;
    const { runner } = inProcess({
      'pr.state': [{ json: prState('OPEN', head) }, { json: recorded }],
    });
    const merged = await run(
      (gh) =>
        gh.waitPr('merged', { pr: 350, sha: head, until: 'merged', every: 5, timeoutMs: 60_000 }),
      runner,
    );
    expect(merged.output).toEqual({ status: 'merged', headRefOid: head, mergeCommit: merge });
    const other = await outcome([{ json: recorded }], 'merged', 'other-head');
    expect(other.output).toEqual({ status: 'head-moved', headRefOid: head, mergeCommit: null });
  });

  it('maps the deadline to timeout with the last head', async () => {
    const { runner } = inProcess({ 'pr.state': [{ json: prState('OPEN', OTHER) }] });
    const result = await run(
      (gh) =>
        gh.waitPr('merged', { pr: 350, sha: SHA, until: 'closed', every: 10, timeoutMs: 100 }),
      runner,
    );
    expect(result.output).toEqual({ status: 'timeout', headRefOid: OTHER, mergeCommit: null });
  });

  it('waits through a push with until closed, and ends at the push with until merged', async () => {
    const replies = [
      { json: prState('OPEN') },
      { json: prState('OPEN', OTHER) },
      { json: prState('CLOSED', OTHER) },
    ];
    const closed = await outcome(replies, 'closed', 'until-closed');
    expect(closed.output).toEqual({ status: 'closed', headRefOid: OTHER, mergeCommit: null });
    expect(closed.log).toHaveLength(3);
    const merged = await outcome(replies, 'merged', 'until-merged');
    expect(merged.output).toEqual({ status: 'head-moved', headRefOid: OTHER, mergeCommit: null });
    expect(merged.log).toHaveLength(2);
  });
});

describe('waitChecks', () => {
  it('reports no-checks only after graceMs', async () => {
    const { runner, log } = inProcess({ 'pr.view': [{ json: prView({ checks: [] }) }] });
    const started = Date.now();
    const result = await run(
      (gh) =>
        gh.waitChecks('ci', { pr: 338, sha: SHA, graceMs: 150, every: 10, timeoutMs: 60_000 }),
      runner,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(result.output).toEqual({
      status: 'no-checks',
      headRefOid: SHA,
      failed: [],
      pending: [],
    });
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it('maps the deadline to timeout with the last progress', async () => {
    const pending = prView({ checks: [checkRun('Quality'), checkRun('Tests', null)] });
    const { runner } = inProcess({ 'pr.view': [{ json: pending }] });
    const result = await run(
      (gh) => gh.waitChecks('ci', { pr: 338, sha: SHA, every: 10, timeoutMs: 100 }),
      runner,
    );
    expect(result.output).toEqual({
      status: 'timeout',
      headRefOid: SHA,
      failed: [],
      pending: ['Tests'],
    });
  });

  it('treats a head that sha does not descend from as moved, even inside the stale grace', async () => {
    for (const [runId, compare] of [
      ['behind', { json: { status: 'behind' } }],
      [
        'unknown',
        {
          code: 1,
          stdout: JSON.stringify({ message: 'Not Found', status: '404' }),
          stderr: 'gh: Not Found (HTTP 404)',
        },
      ],
    ] as const) {
      const { runner, log } = inProcess({
        'pr.view': [{ json: prView({ head: ANCESTOR }) }],
        'repo.compare': [compare],
      });
      const result = await run(
        (gh) =>
          gh.waitChecks('ci', {
            pr: 338,
            sha: SHA,
            staleGraceMs: 60_000,
            every: 5,
            timeoutMs: 60_000,
          }),
        runner,
        runId,
      );
      expect(result.output).toEqual({
        status: 'head-moved',
        headRefOid: ANCESTOR,
        failed: [],
        pending: [],
      });
      expect(log).toEqual(['pr.view', 'repo.compare']);
    }
  });

  it('fails on bad credentials from the compare instead of calling the head moved', async () => {
    const { runner } = inProcess({
      'pr.view': [{ json: prView({ head: ANCESTOR }) }],
      'repo.compare': [{ code: 1, stdout: fixture('bad-credentials.json') }],
    });
    await expect(
      run(
        (gh) =>
          gh.waitChecks('ci', {
            pr: 338,
            sha: SHA,
            staleGraceMs: 60_000,
            every: 5,
            timeoutMs: 60_000,
          }),
        runner,
      ),
    ).rejects.toThrow('Command exited with 1.');
  });

  it('fails after tolerate + 1 consecutive transient errors with the gh error', async () => {
    const bad = { code: 1, stdout: '', stderr: 'gh: HTTP 502: Bad Gateway' };
    const { runner, log } = inProcess({ 'pr.view': [bad, bad, bad, { json: prView() }] });
    await expect(
      run(
        (gh) =>
          gh.waitChecks('ci', { pr: 338, sha: SHA, every: 5, timeoutMs: 60_000, tolerate: 2 }),
        runner,
      ),
    ).rejects.toThrow('Command exited with 1.');
    expect(log).toEqual(['pr.view', 'pr.view', 'pr.view']);
    expect((await readRun(setup())).status).toBe('failed');
  });

  it('fails at once on an incomplete collection', async () => {
    const view = prView() as {
      data: {
        repository: {
          pullRequest: {
            commits: {
              nodes: {
                commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: boolean } } } };
              }[];
            };
          };
        };
      };
    };
    first(
      view.data.repository.pullRequest.commits.nodes,
    ).commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
    const { runner, log } = inProcess({ 'pr.view': [{ json: view }] });
    let thrown: unknown;
    await expect(
      run(async (gh) => {
        try {
          return await gh.waitChecks('ci', { pr: 338, sha: SHA, every: 5, timeoutMs: 60_000 });
        } catch (error) {
          thrown = error;
          throw error;
        }
      }, runner),
    ).rejects.toThrow();
    expect(thrown).toBeInstanceOf(IncompleteCollectionError);
    expect(thrown).toMatchObject({
      connection: 'pullRequest.commits.statusCheckRollup.contexts',
      stepId: 'ci',
    });
    expect(log).toEqual(['pr.view']);
  });
});

describe('arguments', () => {
  const { runner } = inProcess({});
  const cases: [string, (gh: GithubClient) => Promise<unknown>, string][] = [
    [
      'bad sha',
      (gh) => gh.waitChecks('ci', { pr: 1, sha: 'HEAD', timeoutMs: 1 }),
      'waitChecks sha must be a commit SHA',
    ],
    [
      'both bounds',
      (gh) =>
        gh.waitPr('pr', {
          pr: 1,
          sha: SHA,
          until: 'merged',
          timeoutMs: 1,
          deadline: 1,
        } as never),
      'waitPr needs exactly one of timeoutMs and deadline',
    ],
    [
      'no bound',
      (gh) => gh.waitPr('pr', { pr: 1, sha: SHA, until: 'merged' } as never),
      'waitPr needs exactly one of timeoutMs and deadline',
    ],
    [
      'bad pr',
      (gh) => gh.waitChecks('ci', { pr: 0, sha: SHA, timeoutMs: 1 }),
      'waitChecks pr must be a positive integer',
    ],
    [
      'bad until',
      (gh) => gh.waitPr('pr', { pr: 1, sha: SHA, until: 'open', timeoutMs: 1 } as never),
      'waitPr until must be merged or closed',
    ],
    [
      'duplicate reviewers',
      (gh) =>
        gh.waitReview('review', {
          pr: 1,
          sha: SHA,
          since: 0,
          reviewers: [codexReviewer(), codexReviewer()],
          timeoutMs: 1,
        }),
      'reviewer names must be unique; codex repeats',
    ],
    [
      'no reviewers',
      (gh) => gh.waitReview('review', { pr: 1, sha: SHA, since: 0, reviewers: [], timeoutMs: 1 }),
      'waitReview needs at least one reviewer',
    ],
    [
      'bad since',
      (gh) =>
        gh.waitReview('review', {
          pr: 1,
          sha: SHA,
          since: '2026-10-03' as never,
          reviewers: [codexReviewer()],
          timeoutMs: 1,
        }),
      'waitReview since must be a nonnegative integer',
    ],
    [
      'bad reads',
      (gh) =>
        gh.waitReview('review', {
          pr: 1,
          sha: SHA,
          since: 0,
          reviewers: [{ ...codexReviewer(), reads: ['threads' as never] }],
          timeoutMs: 1,
        }),
      'reads must be among comments, reviews, reactions, alerts',
    ],
  ];
  it.each(cases)('rejects %s before the wait opens', async (name, wait, message) => {
    let thrown: unknown;
    await expect(
      run(
        async (gh) => {
          try {
            return await wait(gh);
          } catch (error) {
            thrown = error;
            throw error;
          }
        },
        runner,
        name.replace(/\W/gu, '-'),
      ),
    ).rejects.toThrow();
    expect(String(thrown)).toContain(message);
    expect((await readRun(setup(name.replace(/\W/gu, '-')))).steps).toEqual({});
  });

  it('validates the CodeQL reviewer options', () => {
    expect(() => codeqlReviewer({ settleMs: -1 })).toThrow('settleMs');
    expect(() => codeqlReviewer({ checkName: '' })).toThrow('checkName');
    expect(codeqlReviewer()).toMatchObject({
      name: 'codeql',
      reads: ['alerts'],
      identity: { codeql: 1, settleMs: 60_000, checkName: 'CodeQL' },
    });
  });
});

describe('waitReview', () => {
  /** Codex pending, then Completed twice: clean on the third check. */
  const codexClean = (): Scenario => ({
    'pr.view': [{ json: prView() }],
    'issue.comments': [{ json: comments().slice(1, 3) }, { json: comments() }],
    'pr.reviews': [{ json: json('rest-reviews.json') }],
    'issue.reactions': [{ json: [] }],
    ...finalReads,
  });

  it('adds a third reviewer without touching core, and reports every reviewer in by', async () => {
    const lint: ReviewerBot = {
      name: 'lint',
      login: 'lint-bot[bot]',
      reads: ['comments'],
      identity: { lint: 1 },
      observe: (seen, { sha }) =>
        seen.comments.some((comment) => comment.body.includes(sha))
          ? { status: 'clean', detail: { comments: seen.comments.length } }
          : { status: 'pending' },
    };
    const lintComment = {
      ...first(comments().slice(1)),
      id: 99,
      user: { login: 'lint-bot[bot]' },
      body: `lint passed on ${SHA}`,
    };
    const human = { ...lintComment, user: { login: 'octo-dev' } };
    const scenario = codexClean();
    const { runner, log } = inProcess({
      ...scenario,
      'issue.comments': [
        { json: [human] },
        { json: [...comments(), human] },
        { json: [...comments(), human, lintComment] },
      ],
    });
    const result = await run(
      (gh) =>
        gh.waitReview('review', {
          pr: 338,
          sha: SHA,
          since: SINCE,
          reviewers: [codexReviewer(), lint],
          every: 5,
          timeoutMs: 60_000,
        }),
      runner,
    );
    expect(result.output).toEqual({
      status: 'clean',
      headRefOid: SHA,
      by: [
        {
          name: 'codex',
          status: 'clean',
          detail: {
            via: 'summary',
            row: {
              review: 'Code Review',
              status: 'Completed',
              commit: 'c5c2233',
              trigger: 'Manual request',
            },
          },
        },
        // Only the bot's own login counts: the human comment naming sha did not make it clean.
        { name: 'lint', status: 'clean', detail: { comments: 1 } },
      ],
      untriagedThreads: [],
      openAlerts: [],
    });
    expect(log.filter((read) => read === 'pr.view')).toHaveLength(3);
  });

  it('reports untriaged threads by viewer and open alerts once every reviewer is final', async () => {
    const { runner } = inProcess({
      'pr.view': [{ json: prView() }],
      'issue.comments': [{ json: [] }],
      'pr.reviews': [{ json: [] }],
      'issue.reactions': [{ json: json('rest-reactions.json') }],
      'pr.reviewThreads': [
        {
          json: threads([
            ['PRRT_kwDOTxycVs6ogkEM', 'human-author'],
            ['PRRT_kwDOTxycVs6og3EX', 'viewer-login'],
          ]),
        },
      ],
      'repo.info': [{ stdout: fixture('repo-info.json') }],
      'codeScanning.alerts': [{ json: openAlerts(12) }],
    });
    const result = await run(
      (gh) =>
        gh.waitReview('review', {
          pr: 338,
          sha: SHA,
          since: SINCE,
          reviewers: [codexReviewer()],
          every: 5,
          timeoutMs: 60_000,
        }),
      runner,
    );
    expect(result.output).toMatchObject({
      status: 'clean',
      by: [{ name: 'codex', status: 'clean', detail: { via: 'reaction' } }],
      untriagedThreads: ['PRRT_kwDOTxycVs6ogkEM'],
      openAlerts: [12],
    });
  });

  it('reports closed for a pull request closed before the reviewers finish', async () => {
    const { runner } = inProcess({ 'pr.view': [{ json: prView({ state: 'CLOSED' }) }] });
    const result = await run(
      (gh) =>
        gh.waitReview('review', {
          pr: 338,
          sha: SHA,
          since: SINCE,
          reviewers: [codexReviewer()],
          every: 5,
          timeoutMs: 60_000,
        }),
      runner,
    );
    expect(result.output).toEqual({
      status: 'closed',
      headRefOid: SHA,
      by: [{ name: 'codex', status: 'pending', detail: null }],
      untriagedThreads: [],
      openAlerts: [],
    });
  });

  it('maps the deadline to timeout with the last status of each reviewer', async () => {
    const { runner } = inProcess({
      'pr.view': [{ json: prView() }],
      'issue.comments': [{ json: [summary('⏳ **Running**')] }],
      'pr.reviews': [{ json: [] }],
      'issue.reactions': [{ json: [] }],
    });
    const result = await run(
      (gh) =>
        gh.waitReview('review', {
          pr: 338,
          sha: SHA,
          since: SINCE,
          reviewers: [codexReviewer()],
          every: 10,
          timeoutMs: 100,
        }),
      runner,
    );
    expect(result.output).toMatchObject({
      status: 'timeout',
      headRefOid: SHA,
      by: [{ name: 'codex', status: 'running' }],
      untriagedThreads: [],
      openAlerts: [],
    });
  });

  it('keeps reviewers waiting through a stale view inside the grace', async () => {
    const { runner, log } = inProcess({
      'pr.view': [{ json: prView({ head: ANCESTOR }) }, { json: prView() }],
      'repo.compare': [{ stdout: fixture('compare-ahead.json') }],
      'issue.comments': [{ json: [] }],
      'pr.reviews': [{ json: [] }],
      'issue.reactions': [{ json: json('rest-reactions.json') }],
      ...finalReads,
    });
    const result = await run(
      (gh) =>
        gh.waitReview('review', {
          pr: 338,
          sha: SHA,
          since: SINCE,
          reviewers: [codexReviewer()],
          staleGraceMs: 60_000,
          every: 5,
          timeoutMs: 60_000,
        }),
      runner,
    );
    expect(result.output).toMatchObject({ status: 'clean', headRefOid: SHA });
    expect(log.slice(0, 3)).toEqual(['pr.view', 'repo.compare', 'pr.view']);
  });

  it('fails the wait when a reviewer throws, without tolerating it', async () => {
    const broken: ReviewerBot = {
      name: 'broken',
      login: 'x',
      identity: { broken: 1 },
      observe: () => {
        throw new Error('reviewer bug');
      },
    };
    const { runner, log } = inProcess(codexClean());
    await expect(
      run(
        (gh) =>
          gh.waitReview('review', {
            pr: 338,
            sha: SHA,
            since: SINCE,
            reviewers: [broken],
            every: 5,
            timeoutMs: 60_000,
          }),
        runner,
      ),
    ).rejects.toThrow('reviewer bug');
    expect(log.filter((read) => read === 'pr.view')).toHaveLength(1);
  });
});

describe('one wait record per wait', () => {
  it.each(['checks', 'pr', 'review'] as const)(
    'records one %s wait step over three checks and no exec steps',
    async (kind) => {
      const pending = prView({ checks: [checkRun('Tests', null)] });
      const scenario: Scenario =
        kind === 'checks'
          ? { 'pr.view': [{ json: pending }, { json: pending }, { json: prView() }] }
          : kind === 'pr'
            ? {
                'pr.state': [
                  { json: prState('OPEN') },
                  { json: prState('OPEN') },
                  { json: prState('MERGED', SHA, 'm'.repeat(40)) },
                ],
              }
            : {
                'pr.view': [{ json: prView() }],
                'issue.comments': [{ json: [] }, { json: comments() }],
                'pr.reviews': [{ json: [] }],
                'issue.reactions': [{ json: [] }],
                ...finalReads,
              };
      const { runner } = inProcess(scenario);
      const result = await run((gh) => {
        const common = { pr: 338, sha: SHA, every: 5, timeoutMs: 60_000 };
        if (kind === 'checks') return gh.waitChecks('gate', common);
        if (kind === 'pr') return gh.waitPr('gate', { ...common, until: 'merged' });
        return gh.waitReview('gate', { ...common, since: SINCE, reviewers: [codexReviewer()] });
      }, runner);
      expect(result.output).toMatchObject({
        status: { checks: 'success', pr: 'merged', review: 'clean' }[kind],
      });
      const inspection = await inspectRun(setup());
      const steps = inspection.run.steps;
      expect(Object.keys(steps)).toEqual(['gate']);
      expect(steps['gate']).toMatchObject({ kind: 'wait', status: 'completed' });
      expect(steps['gate']?.wait?.checks).toBe(3);
      expect(Object.values(steps).filter((step) => step.kind === 'exec')).toEqual([]);
      // inspect counts one step and lists no command steps: the reads ran inside the wait.
      expect(inspection.summary.counts).toMatchObject({ total: 1, completed: 1 });
      expect(inspection.summary.steps).toEqual([]);
      const summary = formatRunSummary(inspection.summary, true);
      expect(summary).toContain('Steps: 1: 1 completed');
      expect(summary).not.toContain('Command ');
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Real gh process scenarios (createFakeBinary)

// measured: 0.6-1.6 s per test alone, up to 4 s in a full coverage run (each check spawns gh
// processes, and the CodeQL case waits out a 1 s settle).
describe('fake gh scenarios', { timeout: 20_000 }, () => {
  let fake: Awaited<ReturnType<typeof fakeGh>> | undefined;
  afterEach(async () => {
    await fake?.gh.dispose();
    fake = undefined;
  });

  it('reports findings when a review follows a Completed summary on the next check', async () => {
    fake = await fakeGh({
      'pr.view': [{ json: prView() }],
      'issue.comments': [{ json: comments() }],
      'pr.reviews': [
        { json: json('rest-reviews.json') },
        {
          json: [
            ...(json('rest-reviews.json') as RawRestReview[]),
            codexReview(SHA, '2026-10-03T06:21:00Z'),
          ],
        },
      ],
      'issue.reactions': [{ json: [] }],
      ...finalReads,
    });
    const result = await run(
      (gh) =>
        gh.waitReview('review', {
          pr: 338,
          sha: SHA,
          since: SINCE,
          reviewers: [codexReviewer()],
          every: 5,
          timeoutMs: 60_000,
        }),
      fake.runner,
    );
    expect(result.output).toEqual({
      status: 'findings',
      headRefOid: SHA,
      by: [{ name: 'codex', status: 'findings', detail: { reviews: [5400000001] } }],
      untriagedThreads: [],
      openAlerts: [],
    });
    expect((await fake.log()).filter((read) => read === 'pr.view')).toHaveLength(2);
  });

  it('reports head-moved when the head moves mid-wait', async () => {
    fake = await fakeGh({
      'pr.view': [
        { json: prView({ checks: [checkRun('Tests', null)] }) },
        { json: prView({ head: OTHER }) },
      ],
    });
    const result = await run(
      (gh) => gh.waitChecks('ci', { pr: 338, sha: SHA, every: 5, timeoutMs: 60_000 }),
      fake.runner,
    );
    expect(result.output).toEqual({
      status: 'head-moved',
      headRefOid: OTHER,
      failed: [],
      pending: [],
    });
    expect(await fake.log()).toEqual(['pr.view', 'pr.view']);
  });

  it('counts a CodeQL alert that lands within settleMs after the check completes', async () => {
    fake = await fakeGh({
      'pr.view': [
        { json: prView({ checks: [checkRun('Quality'), checkRun('CodeQL', 'FAILURE')] }) },
      ],
      // The check has completed at the first check, but the alert appears only on the next read.
      'codeScanning.alerts': [{ json: [] }, { json: openAlerts(7) }],
      'pr.reviewThreads': [{ json: threads() }],
      'repo.info': [{ stdout: fixture('repo-info.json') }],
    });
    const result = await run(
      (gh) =>
        gh.waitReview('review', {
          pr: 338,
          sha: SHA,
          since: SINCE,
          reviewers: [codeqlReviewer({ settleMs: 1_000 })],
          every: 5,
          timeoutMs: 60_000,
        }),
      fake.runner,
    );
    expect(result.output).toEqual({
      status: 'findings',
      headRefOid: SHA,
      by: [{ name: 'codeql', status: 'findings', detail: { alerts: [7] } }],
      untriagedThreads: [],
      openAlerts: [7],
    });
    const log = await fake.log();
    expect(log.filter((read) => read === 'codeScanning.alerts').length).toBeGreaterThanOrEqual(2);
    expect(log).not.toContain('issue.comments');
  });

  it('tolerates one 502 and continues', async () => {
    fake = await fakeGh({
      'pr.view': [
        {
          code: 1,
          stdout: '',
          stderr: 'gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)\n',
        },
        { json: prView() },
      ],
    });
    const result = await run(
      (gh) => gh.waitChecks('ci', { pr: 338, sha: SHA, every: 5, timeoutMs: 60_000 }),
      fake.runner,
    );
    expect(result.output).toEqual({ status: 'success', headRefOid: SHA, failed: [], pending: [] });
    expect(await fake.log()).toEqual(['pr.view', 'pr.view']);
    const wait = (await readRun(setup())).steps['ci']?.wait;
    expect(wait?.checks).toBe(2);
    expect(wait?.lastError).toBeUndefined();
  });

  it('keeps polling through a stale ancestor head and succeeds once the head is sha', async () => {
    fake = await fakeGh({
      'pr.view': [{ json: prView({ head: ANCESTOR }) }, { json: prView() }],
      'repo.compare': [{ stdout: fixture('compare-ahead.json') }],
    });
    const result = await run(
      (gh) =>
        gh.waitChecks('ci', {
          pr: 338,
          sha: SHA,
          staleGraceMs: 60_000,
          every: 5,
          timeoutMs: 60_000,
        }),
      fake.runner,
    );
    expect(result.output).toEqual({ status: 'success', headRefOid: SHA, failed: [], pending: [] });
    expect(await fake.log()).toEqual(['pr.view', 'repo.compare', 'pr.view']);
  });
});

// ---------------------------------------------------------------------------------------------
// The CLI paths: the documented gate example, and the Codex debounce across a suspend and a tick

/** A cancellable real-time sleep for test clocks. */
const realSleep: WorkflowClock['sleep'] = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Clock cancelled'));
      },
      { once: true },
    );
  });

async function workflowFile(name: string, source: string): Promise<string> {
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await symlink(join(repository, 'node_modules'), join(cwd, 'node_modules')).catch(() => undefined);
  const file = join(cwd, name);
  await writeFile(file, source);
  return file;
}

// measured: 2.5 s alone, 6 s in a full coverage run (dominated by the tsImport compile).
describe('workflow files', { timeout: 30_000 }, () => {
  it('runs the gate example from docs/github.md, under 30 lines', async () => {
    const docs = readFileSync(join(repository, 'docs', 'github.md'), 'utf8');
    const section = docs.slice(docs.indexOf('## Gate example'));
    const snippet = /```ts\n([\s\S]*?)```/u.exec(section)?.[1];
    if (snippet === undefined) throw new Error('docs/github.md has no gate example');
    expect(snippet.trimEnd().split('\n').length).toBeLessThan(30);
    const file = await workflowFile(
      'gate.workflow.ts',
      snippet
        .replace(
          "'quiet-choir/github'",
          JSON.stringify(join(repository, 'src/integrations/github.js')),
        )
        .replace("'quiet-choir'", JSON.stringify(join(repository, 'src/index.js'))),
    );
    const analysis = analyzeTypecheckEntrypoint(file, cwd);
    if (!analysis.ok) throw new Error(analysis.error.message);
    const { runner, log } = inProcess({
      'pr.view': [{ json: prView() }],
      'issue.comments': [{ json: comments() }],
      'pr.reviews': [{ json: json('rest-reviews.json') }],
      'issue.reactions': [{ json: json('rest-reactions.json') }],
      'pr.reviewThreads': [{ json: threads() }],
      'repo.info': [{ stdout: fixture('repo-info.json') }],
      'codeScanning.alerts': [{ code: 1, stdout: fixture('code-scanning-not-enabled.json') }],
    });
    // The run clock starts at the recorded review's time, so ctx.now('since') precedes its +1.
    const offset = Date.now() - SINCE;
    const clock: WorkflowClock = { now: () => Date.now() - offset, sleep: realSleep };
    const result = await new WorkflowExecutor({ logger, processRunner: runner, clock }).execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      runId: 'gate',
      stateDir: join(cwd, 'state'),
      cwd,
      input: { repo: REPO, pr: 338, sha: SHA },
      resume: false,
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ run: { status: 'completed', output: 'land' } });
    expect(log.filter((read) => read === 'pr.view')).toHaveLength(2);
    const steps = (await readRun({ stateDir: join(cwd, 'state'), runId: 'gate' })).steps;
    expect(Object.keys(steps).sort()).toEqual(['ci', 'review', 'since']);
  });

  it('keeps the Codex two-check debounce across a suspend and a workflow tick', async () => {
    const gh = await fakeGh({
      'pr.view': [{ json: prView() }],
      'issue.comments': [{ json: comments() }],
      'pr.reviews': [{ json: json('rest-reviews.json') }],
      'issue.reactions': [{ json: [] }],
      ...finalReads,
    });
    try {
      vi.stubEnv('PATH', gh.gh.env['PATH']);
      vi.stubEnv('GH_FAKE_DIR', gh.dir);
      const file = await workflowFile(
        'review.workflow.ts',
        `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
import { codexReviewer, github } from ${JSON.stringify(join(repository, 'src/integrations/github.js'))};
export default defineWorkflow({
  name: 'review', version: '1', input: z.object({ sha: z.string(), since: z.number() }), output: z.unknown(),
  run: (ctx, { sha, since }) =>
    github(ctx, { repo: ${JSON.stringify(REPO)} }).waitReview('review', {
      pr: 338, sha, since, reviewers: [codexReviewer()], every: 30_000, timeoutMs: 3_600_000,
    }),
});
`,
      );
      const analysis = analyzeTypecheckEntrypoint(file, cwd);
      if (!analysis.ok) throw new Error(analysis.error.message);
      const stateDir = join(cwd, 'state');
      const first = await new WorkflowExecutor({ logger }).execute({
        kind: 'workflow.execute',
        typecheck: analysis.plan,
        runId: 'run',
        stateDir,
        cwd,
        resume: false,
        input: { sha: SHA, since: SINCE },
      });
      if (!first.ok) throw new Error(JSON.stringify(first));
      expect(first).toMatchObject({ run: { status: 'suspended' } });
      expect((await readRun({ stateDir, runId: 'run' })).steps['review']?.wait).toMatchObject({
        checks: 1,
        note: {
          bots: { codex: { status: 'running', final: false, note: { seenComplete: true } } },
        },
      });
      const futureClock: WorkflowClock = { now: () => Date.now() + 120_000, sleep: realSleep };
      const ticked = await new TickWorkflowExecutor({ logger, clock: futureClock }).execute({
        kind: 'workflow.tick',
        runId: 'run',
        stateDir,
      });
      expect(ticked).toMatchObject({
        resumed: [{ runId: 'run', outcome: 'completed' }],
        exitCode: 0,
      });
      const done = await readRun({ stateDir, runId: 'run' });
      expect(done.output).toMatchObject({
        status: 'clean',
        by: [{ name: 'codex', status: 'clean', detail: { via: 'summary' } }],
      });
      expect(done.steps['review']?.wait?.checks).toBe(2);
      expect((await gh.log()).filter((read) => read === 'pr.view')).toHaveLength(2);
    } finally {
      await gh.gh.dispose();
    }
  });
});
