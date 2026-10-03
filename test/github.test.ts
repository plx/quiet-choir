import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineWorkflow,
  ExecError,
  NodeProcessRunner,
  readRun,
  runWorkflow,
  z,
  type ExecResult,
  type ProcessRunner,
  type ProcessRunRequest,
  type WorkflowContext,
} from '../src/index.js';
import { createFakeBinary } from '../src/harness-kit.js';
import {
  github,
  IncompleteCollectionError,
  parseGithubRepo,
  summarizeChecks,
  type GithubClient,
  type RawCheckContext,
  type RawReviewThread,
} from '../src/integrations/github.js';
import {
  ISSUE_VIEW_COMMENTS_QUERY,
  mapReviewThread,
  prListQuery,
  REVIEW_THREADS_QUERY,
} from '../src/integrations/github-model.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import { formatRunSummary } from '../src/cli/inspection-view.js';
import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
/** Recorded `gh` stdout from read-only probes of this repository, trimmed and scrubbed. */
const fixture = (name: string): string =>
  readFileSync(join(repository, 'test', 'fixtures', 'github', name), 'utf8');
const json = (name: string): unknown => JSON.parse(fixture(name));

let cwd: string;
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'choir-github-')));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const setup = (runId = 'github') => ({ cwd, stateDir: join(cwd, 'state'), runId, input: null });
const definition = (run: (ctx: WorkflowContext) => Promise<unknown>) =>
  defineWorkflow({ name: 'github', version: '1', input: z.null(), output: z.unknown(), run });

/** The read an argv performs, recognized from its query or REST path. */
function readOf(argv: readonly string[]): string {
  const query = argv.find((arg) => arg.startsWith('query='));
  if (query === undefined)
    return argv.some((arg) => arg.includes('/code-scanning/alerts?'))
      ? 'codeScanning.alerts'
      : 'unknown';
  if (query.includes('viewer {')) return 'repo.info';
  if (query.includes('reviewThreads(')) return 'pr.reviewThreads';
  if (query.includes('pullRequests(')) return 'pr.list';
  if (query.includes('comments(first: 100, after')) return 'issue.comments';
  if (query.includes('issue(number')) return 'issue.view';
  if (query.includes('pullRequest(number')) return 'pr.view';
  return 'unknown';
}

interface Reply {
  readonly code?: number;
  readonly stdout: string;
  readonly truncated?: boolean;
}
/** Plain issue view, derived from the recorded comments page without its comments. */
function issueWithoutComments(): string {
  const [page] = json('issue-view-comments.json') as [
    { data: { repository: { issue: Record<string, unknown> } } },
  ];
  const issue = { ...page.data.repository.issue };
  delete issue['comments'];
  return JSON.stringify({ data: { repository: { issue } } });
}
const recorded: Readonly<Record<string, () => Reply>> = {
  'repo.info': () => ({ stdout: fixture('repo-info.json') }),
  'pr.view': () => ({ stdout: fixture('pr-view.json') }),
  'pr.list': () => ({ stdout: fixture('pr-list.json') }),
  'pr.reviewThreads': () => ({ stdout: fixture('review-threads.json') }),
  'issue.view': () => ({ stdout: issueWithoutComments() }),
  'issue.comments': () => ({ stdout: fixture('issue-view-comments.json') }),
  'codeScanning.alerts': () => ({ stdout: fixture('code-scanning-alerts.json') }),
};

/** A ProcessRunner that answers each read from recorded JSON, or from `override`. */
function fakeGh(
  override: (read: string, argv: readonly string[]) => Reply | undefined = () => undefined,
) {
  const seen: { readonly argv: readonly string[]; readonly request: ProcessRunRequest }[] = [];
  const runner: ProcessRunner = {
    run: (request) => {
      const argv = request.command as readonly string[];
      seen.push({ argv, request });
      const read = readOf(argv);
      const reply = override(read, argv) ?? recorded[read]?.();
      if (!reply) throw new Error(`Unexpected command ${JSON.stringify(argv)}`);
      const code = reply.code ?? 0;
      return Promise.resolve({
        code,
        signal: null,
        stdout: reply.stdout,
        stderr: code === 0 ? '' : 'gh: HTTP error',
        truncated: reply.truncated ?? false,
        durationMs: 1,
      } satisfies ExecResult);
    },
  };
  return { seen, runner };
}

/** Every read once: the six reads plus issue.view in both forms. */
async function allReads(gh: GithubClient) {
  return {
    info: await gh.repo.info('repo'),
    pr: await gh.pr.view('pr', { number: 329 }),
    list: await gh.pr.list('list', { head: 'feature', base: 'main' }),
    threads: await gh.pr.reviewThreads('threads', { number: 329 }),
    issue: await gh.issue.view('issue', { number: 154 }),
    comments: await gh.issue.view('issue-comments', { number: 154, comments: true }),
    alerts: await gh.codeScanning.alerts('alerts', { ref: 'refs/pull/329/merge' }),
  };
}
const ops = {
  repo: 'repo.info',
  pr: 'pr.view',
  list: 'pr.list',
  threads: 'pr.reviewThreads',
  issue: 'issue.view',
  'issue-comments': 'issue.view',
  alerts: 'codeScanning.alerts',
};

/** Run `read` in a workflow, keeping the error it throws. */
async function failing(
  read: (gh: GithubClient) => Promise<unknown>,
  runner: ProcessRunner,
  runId = 'github',
): Promise<unknown> {
  let thrown: unknown;
  await expect(
    runWorkflow(
      definition(async (ctx) => {
        try {
          return await read(github(ctx, { repo: 'octo-org/quiet-choir' }));
        } catch (error) {
          thrown = error;
          throw error;
        }
      }),
      { ...setup(runId), processRunner: runner },
    ),
  ).rejects.toThrow();
  return thrown;
}

const threadPages = () =>
  json('review-threads.json') as {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: boolean }; nodes: RawReviewThread[] };
        };
      };
    };
  }[];

describe('paginated reads', () => {
  it('merges a two-page review thread slurp in page order from one paginated exec', async () => {
    const { seen, runner } = fakeGh();
    const run = await runWorkflow(
      definition((ctx) =>
        github(ctx, { repo: 'octo-org/quiet-choir' }).pr.reviewThreads('threads', { number: 329 }),
      ),
      { ...setup(), processRunner: runner },
    );
    const pages = threadPages();
    const ids = pages.flatMap((page) =>
      page.data.repository.pullRequest.reviewThreads.nodes.map((thread) => thread.id),
    );
    expect(pages.map((page) => page.data.repository.pullRequest.reviewThreads.pageInfo)).toEqual([
      expect.objectContaining({ hasNextPage: true }),
      expect.objectContaining({ hasNextPage: false }),
    ]);
    expect(ids).toHaveLength(4);
    const threads = run.output as { id: string }[];
    expect(threads.map((thread) => thread.id)).toEqual(ids);
    expect(threads[0]).toMatchObject({
      isResolved: true,
      path: 'src/workflow/typecheck/durability-lint.ts',
      line: 429,
      author: 'chatgpt-codex-connector',
      isBot: true,
      lastAuthor: 'human-author',
      priority: 'P2',
      title: '[P2] Resolve iteration methods before treating callbacks as loops',
    });
    expect(seen).toHaveLength(1);
    const argv = seen[0]?.argv ?? [];
    expect(argv.slice(0, 5)).toEqual(['gh', 'api', 'graphql', '--paginate', '--slurp']);
    expect(argv).toEqual(
      expect.arrayContaining([
        `query=${REVIEW_THREADS_QUERY}`,
        'owner=octo-org',
        'name=quiet-choir',
        'number=329',
      ]),
    );
    expect(argv[argv.indexOf('number=329') - 1]).toBe('-F');
    expect(REVIEW_THREADS_QUERY).toContain('$endCursor: String');
    expect(REVIEW_THREADS_QUERY).toContain('after: $endCursor');
    // No env overlay or stdin; the cwd is the workflow cwd.
    expect(seen[0]?.request).toMatchObject({ env: {}, input: '', inheritEnv: true, cwd });
  });

  it('throws IncompleteCollectionError for a truncated nested comment page and never completes the read', async () => {
    const pages = threadPages();
    const thread = pages[1]?.data.repository.pullRequest.reviewThreads.nodes[0];
    if (!thread) throw new Error('fixture has no second-page thread');
    (thread.comments.pageInfo as { hasNextPage: boolean }).hasNextPage = true;
    const truncated = fakeGh((read) =>
      read === 'pr.reviewThreads' ? { stdout: JSON.stringify(pages) } : undefined,
    );
    const error = await failing(
      (gh) => gh.pr.reviewThreads('threads', { number: 329 }),
      truncated.runner,
    );
    expect(error).toBeInstanceOf(IncompleteCollectionError);
    const incomplete = error as IncompleteCollectionError;
    expect(incomplete.connection).toBe(`pullRequest.reviewThreads[${thread.id}].comments`);
    expect(incomplete.stepId).toBe('threads');
    expect(incomplete.cause).toBeInstanceOf(ExecError);
    expect((incomplete.cause as ExecError).kind).toBe('schema');
    const record = await readRun(setup());
    expect(record.steps['threads']).toMatchObject({ status: 'failed', output: null });
    expect(record.rootCause).toMatchObject({ stepId: 'threads', errorKind: 'schema' });
    // Not checkpointed as completed: a resume runs the read again and sees the complete response.
    const complete = fakeGh();
    const resumed = await runWorkflow(
      definition((ctx) =>
        github(ctx, { repo: 'octo-org/quiet-choir' }).pr.reviewThreads('threads', { number: 329 }),
      ),
      { ...setup(), processRunner: complete.runner, resume: true },
    );
    expect(resumed.status).toBe('completed');
    expect(complete.seen).toHaveLength(1);
  });

  const pageInfo = (...path: (string | number)[]) => [...path, 'pageInfo'];
  it.each([
    [
      'pr.reviewThreads',
      'pullRequest.reviewThreads',
      (gh: GithubClient) => gh.pr.reviewThreads('read', { number: 329 }),
      pageInfo(-1, 'data', 'repository', 'pullRequest', 'reviewThreads'),
    ],
    [
      'pr.list',
      'repository.pullRequests',
      (gh: GithubClient) => gh.pr.list('read'),
      pageInfo(-1, 'data', 'repository', 'pullRequests'),
    ],
    [
      'issue.comments',
      'issue.comments',
      (gh: GithubClient) => gh.issue.view('read', { number: 154, comments: true }),
      pageInfo(-1, 'data', 'repository', 'issue', 'comments'),
    ],
    [
      'issue.comments',
      'issue.labels',
      (gh: GithubClient) => gh.issue.view('read', { number: 154, comments: true }),
      pageInfo(0, 'data', 'repository', 'issue', 'labels'),
    ],
    [
      'issue.view',
      'issue.labels',
      (gh: GithubClient) => gh.issue.view('read', { number: 154 }),
      pageInfo('data', 'repository', 'issue', 'labels'),
    ],
    [
      'pr.view',
      'pullRequest.closingIssuesReferences',
      (gh: GithubClient) => gh.pr.view('read', { number: 329 }),
      pageInfo('data', 'repository', 'pullRequest', 'closingIssuesReferences'),
    ],
    [
      'pr.view',
      'pullRequest.commits.statusCheckRollup.contexts',
      (gh: GithubClient) => gh.pr.view('read', { number: 329 }),
      pageInfo(
        ...['data', 'repository', 'pullRequest', 'commits', 'nodes', 0],
        ...['commit', 'statusCheckRollup', 'contexts'],
      ),
    ],
  ] as const)(
    '%s throws IncompleteCollectionError naming %s when it reports a next page',
    async (read, connection, call, path) => {
      const { runner } = fakeGh((current) => {
        if (current !== read) return undefined;
        const value: unknown = JSON.parse(recorded[read]?.().stdout ?? 'null');
        // A negative index counts from the end, so -1 is the last page.
        const target = path.reduce<unknown>((node, key) => {
          if (typeof key === 'number' && Array.isArray(node)) return node.at(key);
          return (node as Record<string, unknown>)[key];
        }, value);
        (target as { hasNextPage: boolean }).hasNextPage = true;
        return { stdout: JSON.stringify(value) };
      });
      const error = await failing(call, runner);
      expect(error).toBeInstanceOf(IncompleteCollectionError);
      expect((error as IncompleteCollectionError).connection).toBe(connection);
      expect((await readRun(setup())).steps['read']?.status).toBe('failed');
    },
  );

  it('rejects an empty slurp as a schema failure, not as a complete empty list', async () => {
    const { runner } = fakeGh(() => ({ stdout: '[]' }));
    const error = await failing((gh) => gh.pr.list('read'), runner);
    expect(error).toBeInstanceOf(ExecError);
    expect(error).not.toBeInstanceOf(IncompleteCollectionError);
    expect((error as ExecError).kind).toBe('schema');
  });

  it('declares $endCursor and requests the paginated pageInfo first, right after after: $endCursor', () => {
    const queries = [
      REVIEW_THREADS_QUERY,
      ISSUE_VIEW_COMMENTS_QUERY,
      ...(['open', 'closed', 'merged', 'all'] as const).map(prListQuery),
    ];
    for (const query of queries) {
      expect(query).toContain('$endCursor: String');
      const after = query.indexOf('after: $endCursor');
      expect(query.indexOf('after: $endCursor', after + 1)).toBe(-1);
      // gh follows the first pageInfo in document order: it must belong to the paginated
      // connection, ahead of its nodes and of every other connection's pageInfo.
      expect(after, query).toBeGreaterThan(-1);
      expect(query.indexOf('pageInfo'), query).toBeGreaterThan(after);
      expect(query.slice(after, query.indexOf('pageInfo'))).toBe('after: $endCursor) { ');
      expect(query.slice(query.indexOf('pageInfo'))).toMatch(
        /^pageInfo \{ hasNextPage endCursor \} nodes \{/u,
      );
    }
    expect(ISSUE_VIEW_COMMENTS_QUERY.indexOf('comments(')).toBeLessThan(
      ISSUE_VIEW_COMMENTS_QUERY.indexOf('labels('),
    );
    expect(prListQuery('all')).not.toContain('states:');
    expect(prListQuery('merged')).toContain('states: [MERGED]');
  });
});

describe('code scanning', () => {
  const alerts = (reply: Reply) =>
    fakeGh((read) => (read === 'codeScanning.alerts' ? reply : undefined));
  const read = (gh: GithubClient) => gh.codeScanning.alerts('alerts', { ref: 'refs/pull/7/merge' });

  it.each([
    ['code-scanning-not-enabled.json', /Code scanning is not enabled/u],
    ['code-scanning-no-analysis.json', /no analysis found/u],
  ])('turns exit 1 with %s into status unavailable', async (file, reason) => {
    const { seen, runner } = alerts({ code: 1, stdout: fixture(file) });
    const run = await runWorkflow(
      definition((ctx) => read(github(ctx, { repo: 'octo-org/quiet-choir' }))),
      { ...setup(), processRunner: runner },
    );
    expect(run.output).toEqual({
      status: 'unavailable',
      reason: expect.stringMatching(reason) as unknown,
      alerts: [],
    });
    expect(run.steps['alerts']?.status).toBe('completed');
    expect(seen[0]?.argv).toEqual([
      'gh',
      'api',
      '--paginate',
      'repos/octo-org/quiet-choir/code-scanning/alerts?ref=refs%2Fpull%2F7%2Fmerge&state=open&per_page=100',
    ]);
    expect(run.steps['alerts']?.exec?.okExitCodes).toEqual([0, 1]);
  });

  // gh 2.100 output without --slurp, recorded against a local server: an alert, as gh prints it.
  const alert = JSON.stringify((json('code-scanning-alerts.json') as unknown[])[0]);
  it.each([
    ['Not Found', { code: 1, stdout: fixture('code-scanning-not-found.json') }, 'schema'],
    ['Bad credentials', { code: 1, stdout: fixture('bad-credentials.json') }, 'schema'],
    ['empty stdout (network failure)', { code: 1, stdout: '' }, 'schema'],
    // A dropped connection after an empty first page: gh never closes the merged array.
    ['an unclosed empty array', { code: 1, stdout: '[' }, 'schema'],
    // A dropped connection after page 1: the alerts gh already printed, still unclosed.
    ['a network drop after page 1', { code: 1, stdout: `[${alert}` }, 'schema'],
    // A 5xx on page 2: gh appends the error body to the unclosed array.
    [
      'a 5xx page after alerts',
      { code: 1, stdout: `[${alert}{"message":"Server Error"}` },
      'schema',
    ],
    [
      'an unavailable page after alerts',
      { code: 1, stdout: `[${alert}{"message":"no analysis found"}` },
      'schema',
    ],
    ['an alert array inside an array', { code: 0, stdout: `[[${alert}]]` }, 'schema'],
    ['exit 2', { code: 2, stdout: fixture('code-scanning-not-enabled.json') }, 'process'],
  ] as const)('rejects %s without settling the read', async (_name, reply, kind) => {
    const error = await failing(read, alerts(reply).runner);
    expect(error).toBeInstanceOf(ExecError);
    expect((error as ExecError).kind).toBe(kind);
    expect((await readRun(setup())).steps['alerts']?.status).toBe('failed');
  });

  it('reads an empty merged array as no alerts', async () => {
    const { runner } = alerts({ stdout: '[]' });
    const run = await runWorkflow(
      definition((ctx) => read(github(ctx, { repo: 'octo-org/quiet-choir' }))),
      { ...setup(), processRunner: runner },
    );
    expect(run.output).toEqual({ status: 'ok', alerts: [] });
  });

  it('keeps the order of the array gh merged from two pages', async () => {
    const { runner } = alerts({ stdout: fixture('code-scanning-alerts.json') });
    const run = await runWorkflow(
      definition((ctx) => read(github(ctx, { repo: 'octo-org/quiet-choir' }))),
      { ...setup(), processRunner: runner },
    );
    const merged = json('code-scanning-alerts.json') as { number: number }[];
    expect(merged).toHaveLength(4);
    const result = run.output as { status: string; alerts: { number: number }[] };
    expect(result.status).toBe('ok');
    expect(result.alerts.map((alert) => alert.number)).toEqual(merged.map((alert) => alert.number));
    expect(result.alerts[0]).toEqual({
      number: 6,
      rule: 'js/bad-code-sanitization',
      severity: 'medium',
      path: 'test/process-lifecycle.test.ts',
      line: 219,
      message: 'Code construction depends on an improperly sanitized value.',
      state: 'fixed',
      url: 'https://github.com/octo-org/quiet-choir/security/code-scanning/6',
    });
  });

  it('captures exit 1 and its stdout body from a real gh process', async () => {
    const gh = await createFakeBinary(
      'gh',
      `process.stdout.write(${JSON.stringify(fixture('code-scanning-not-enabled.json'))});
process.stderr.write('gh: Code scanning is not enabled for this repository. (HTTP 403)\\n');
process.exitCode = 1;`,
    );
    try {
      const native = new NodeProcessRunner();
      const runner: ProcessRunner = {
        run: (request, invocation) =>
          native.run({ ...request, env: { ...request.env, ...gh.env } }, invocation),
      };
      const run = await runWorkflow(
        definition((ctx) => read(github(ctx, { repo: 'octo-org/quiet-choir' }))),
        { ...setup(), processRunner: runner },
      );
      expect(run.output).toMatchObject({ status: 'unavailable', alerts: [] });
    } finally {
      await gh.dispose();
    }
  });
});

describe('repository specs', () => {
  it('maps HOST/OWNER/REPO to --hostname right after api in every read', async () => {
    for (const [repo, host] of [
      ['enterprise.test/octo-org/quiet-choir', 'enterprise.test'],
      ['octo-org/quiet-choir', null],
    ] as const) {
      const { seen, runner } = fakeGh();
      await runWorkflow(
        definition((ctx) => allReads(github(ctx, { repo }))),
        { ...setup(host === null ? 'default' : 'enterprise'), processRunner: runner },
      );
      expect(seen).toHaveLength(7);
      for (const { argv } of seen) {
        expect(argv.slice(0, 2)).toEqual(['gh', 'api']);
        if (host === null) expect(argv).not.toContain('--hostname');
        else {
          expect(argv.slice(2, 4)).toEqual(['--hostname', host]);
          expect(argv.indexOf('--hostname')).toBe(argv.lastIndexOf('--hostname'));
        }
        expect(argv.join(' ')).not.toContain('enterprise.test/');
      }
    }
    expect(parseGithubRepo('enterprise.test/o/r')).toEqual({
      host: 'enterprise.test',
      owner: 'o',
      name: 'r',
      nameWithOwner: 'o/r',
    });
    expect(parseGithubRepo('octo-org/.github').host).toBeNull();
  });

  it.each([
    'a',
    'a/b/c/d',
    '-x/y',
    'o/r;rm',
    'o/-r',
    'o/..',
    '../r',
    'bad host/o/r',
    '-h/o/r',
    '',
    'o/',
  ])('rejects %j when the client is created', (repo) => {
    expect(() => github({} as Pick<WorkflowContext, 'exec'>, { repo })).toThrow(
      /Invalid GitHub repository/u,
    );
  });
});

describe('labels, policy and arguments', () => {
  it('labels every read step with { integration: github, op } and shows it in inspect', async () => {
    const { runner } = fakeGh();
    const run = await runWorkflow(
      definition((ctx) => allReads(github(ctx, { repo: 'octo-org/quiet-choir' }))),
      { ...setup(), processRunner: runner },
    );
    expect(
      Object.fromEntries(Object.entries(run.steps).map(([id, step]) => [id, step.meta])),
    ).toEqual(
      Object.fromEntries(
        Object.entries(ops).map(([id, op]) => [id, { integration: 'github', op }]),
      ),
    );
    const summary = formatRunSummary((await inspectRun(setup())).summary);
    expect(summary).toContain('completed pr  github.pr.view');
    expect(summary).toContain('completed alerts  github.codeScanning.alerts');
  });

  it('maps the recorded pull request, list, issue and repository responses', async () => {
    const { runner } = fakeGh();
    const run = await runWorkflow(
      definition((ctx) => allReads(github(ctx, { repo: 'octo-org/quiet-choir' }))),
      { ...setup(), processRunner: runner },
    );
    const output = run.output as unknown as Awaited<ReturnType<typeof allReads>>;
    expect(output.info).toEqual({
      host: null,
      owner: 'octo-org',
      name: 'quiet-choir',
      nameWithOwner: 'octo-org/quiet-choir',
      defaultBranch: 'main',
      isPrivate: false,
      viewer: 'viewer-login',
      viewerPermission: 'ADMIN',
    });
    expect(output.pr).toMatchObject({
      number: 329,
      state: 'MERGED',
      headRefOid: '9fd831de10de270b1f355f7f7e0c56e2c36ca864',
      baseRefName: 'main',
      closingIssues: [{ number: 154, repository: 'octo-org/quiet-choir' }],
      checks: { state: 'success', passed: 3, failed: [], pending: [] },
    });
    expect(output.pr.checks.items[0]).toEqual({
      name: 'Quality and package',
      kind: 'check-run',
      outcome: 'passed',
      state: 'SUCCESS',
      url: 'https://github.com/octo-org/quiet-choir/actions/runs/37078499704/job/111073630715',
      workflowRunId: 37078499704,
    });
    expect(output.list).toEqual([expect.objectContaining({ number: 329, state: 'MERGED' })]);
    expect(output.issue).toMatchObject({
      number: 154,
      author: 'human-author',
      labels: ['enhancement'],
    });
    expect(output.issue).not.toHaveProperty('comments');
    expect(output.comments.comments).toEqual([
      expect.objectContaining({ author: 'human-author', isBot: false, id: 5963269707 }),
    ]);
    // Head and base go to -f variables only when given; the list state is in the query text.
    const list = fakeGh();
    await runWorkflow(
      definition((ctx) => github(ctx, { repo: 'octo-org/quiet-choir' }).pr.list('list')),
      { ...setup('bare-list'), processRunner: list.runner },
    );
    expect(
      list.seen[0]?.argv.some((arg) => arg.startsWith('head=') || arg.startsWith('base=')),
    ).toBe(false);
  });

  it('passes only timeoutMs, maxOutputBytes and retry through as policy', async () => {
    const { seen, runner } = fakeGh();
    await runWorkflow(
      definition((ctx) =>
        github(ctx, { repo: 'octo-org/quiet-choir' }).repo.info('repo', {
          timeoutMs: 1234,
          maxOutputBytes: 4096,
          retry: { maxAttempts: 2, on: ['process'] },
        }),
      ),
      { ...setup(), processRunner: runner },
    );
    expect(seen[0]?.request).toMatchObject({ timeoutMs: 1234, maxOutputBytes: 4096 });
    const refused = fakeGh();
    const error = await failing(
      (gh) =>
        gh.repo.info('repo', { env: { GH_TOKEN: 'x' } } as unknown as Parameters<
          GithubClient['repo']['info']
        >[1]),
      refused.runner,
      'refused',
    );
    expect(String(error)).toContain('accept only timeoutMs, maxOutputBytes and retry');
    expect(refused.seen).toEqual([]);
  });

  it('rejects an oversized read instead of shrinking it', async () => {
    const { runner } = fakeGh(() => ({ stdout: '[', truncated: true }));
    const error = await failing((gh) => gh.pr.reviewThreads('threads', { number: 1 }), runner);
    expect(error).toBeInstanceOf(ExecError);
    expect((error as ExecError).kind).toBe('output-limit');
  });

  it.each([
    ['pr.view number 0', (gh: GithubClient) => gh.pr.view('x', { number: 0 })],
    [
      'pr.reviewThreads number 1.5',
      (gh: GithubClient) => gh.pr.reviewThreads('x', { number: 1.5 }),
    ],
    ['issue.view number -1', (gh: GithubClient) => gh.issue.view('x', { number: -1 })],
    [
      'pr.list state',
      (gh: GithubClient) => gh.pr.list('x', { state: 'draft' as unknown as 'open' }),
    ],
    ['pr.list head', (gh: GithubClient) => gh.pr.list('x', { head: '' })],
    ['codeScanning ref', (gh: GithubClient) => gh.codeScanning.alerts('x', { ref: '' })],
    [
      'codeScanning state',
      (gh: GithubClient) =>
        gh.codeScanning.alerts('x', { ref: 'main', state: 'all' as unknown as 'open' }),
    ],
  ])('rejects an invalid %s before running gh', async (_name, call) => {
    const { seen, runner } = fakeGh();
    await failing(call, runner);
    expect(seen).toEqual([]);
  });
});

describe('replay', () => {
  it('replays every completed read, including unavailable code scanning, without running gh', async () => {
    let fail = true;
    const workflow = definition(async (ctx) => {
      const output = await allReads(github(ctx, { repo: 'octo-org/quiet-choir' }));
      if (fail) throw new Error('Injected tail failure');
      return output;
    });
    const first = fakeGh((read) =>
      read === 'codeScanning.alerts'
        ? { code: 1, stdout: fixture('code-scanning-not-enabled.json') }
        : undefined,
    );
    await expect(
      runWorkflow(workflow, { ...setup(), processRunner: first.runner }),
    ).rejects.toThrow('Injected tail failure');
    expect(first.seen).toHaveLength(7);
    fail = false;
    const second = fakeGh();
    const resumed = await runWorkflow(workflow, {
      ...setup(),
      processRunner: second.runner,
      resume: true,
    });
    expect(second.seen).toEqual([]);
    expect((resumed.output as { alerts: unknown }).alerts).toMatchObject({ status: 'unavailable' });
  });
});

describe('pure mappers', () => {
  const run = (
    name: string,
    overrides: Partial<Extract<RawCheckContext, { __typename: 'CheckRun' }>>,
  ) =>
    ({
      __typename: 'CheckRun',
      name,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      detailsUrl: null,
      checkSuite: { workflowRun: { databaseId: 7 } },
      ...overrides,
    }) as const;
  const status = (context: string, state: string): RawCheckContext => ({
    __typename: 'StatusContext',
    context,
    state,
    targetUrl: null,
  });

  it.each([
    [[], { state: 'none', passed: 0, failed: [], pending: [] }],
    [
      [run('a', {}), status('s', 'SUCCESS')],
      { state: 'success', passed: 2, failed: [], pending: [] },
    ],
    [
      [run('a', { conclusion: 'NEUTRAL' }), run('b', { conclusion: 'SKIPPED' })],
      { state: 'success', passed: 2, failed: [], pending: [] },
    ],
    [
      [run('a', { conclusion: 'FAILURE' }), status('s', 'ERROR')],
      { state: 'failure', passed: 0, failed: ['a', 's'], pending: [] },
    ],
    [
      [run('a', { status: 'IN_PROGRESS', conclusion: null }), run('b', { conclusion: 'FAILURE' })],
      { state: 'pending', passed: 0, failed: ['b'], pending: ['a'] },
    ],
    [
      [status('p', 'PENDING'), status('e', 'EXPECTED'), run('c', { conclusion: 'CANCELLED' })],
      { state: 'pending', passed: 0, failed: ['c'], pending: ['p', 'e'] },
    ],
    [
      [run('a', { conclusion: 'TIMED_OUT' }), run('b', { conclusion: 'ACTION_REQUIRED' })],
      { state: 'failure', passed: 0, failed: ['a', 'b'], pending: [] },
    ],
  ] as const)('summarizes checks %#', (contexts, expected) => {
    expect(summarizeChecks(contexts as readonly RawCheckContext[])).toMatchObject(expected);
  });

  it('keeps check states as strings and the workflow run ID only for Actions checks', () => {
    const [actions, other, commit] = summarizeChecks([
      run('a', { status: 'WAITING', conclusion: null }),
      run('b', { checkSuite: { workflowRun: null } }),
      status('s', 'SOMETHING_NEW'),
    ]).items;
    expect(actions).toMatchObject({ outcome: 'pending', state: 'WAITING', workflowRunId: 7 });
    expect(other).toMatchObject({ outcome: 'passed', workflowRunId: null });
    expect(commit).toMatchObject({ kind: 'status', outcome: 'failed', state: 'SOMETHING_NEW' });
  });

  const comment = (author: { login: string; __typename: string } | null, body: string) => ({
    databaseId: 1,
    author,
    body,
    url: 'https://example.test/c',
    createdAt: '2026-10-01T00:00:00Z',
  });
  const thread = (
    comments: ReturnType<typeof comment>[],
    line: number | null = 3,
  ): RawReviewThread => ({
    id: 'T',
    isResolved: false,
    isOutdated: line === null,
    path: 'src/a.ts',
    line,
    originalLine: 9,
    comments: { pageInfo: { hasNextPage: false }, nodes: comments },
  });
  const bot = { login: 'github-advanced-security', __typename: 'Bot' };
  const human = { login: 'human-author', __typename: 'User' };

  it.each([
    [
      'a code-scanning bot thread',
      thread([
        comment(
          bot,
          '## Unused variable\n\n[Show more details](https://github.com/o/r/security/code-scanning/42)',
        ),
        comment(human, 'Fixed.'),
      ]),
      {
        author: 'github-advanced-security',
        isBot: true,
        lastAuthor: 'human-author',
        alert: 42,
        priority: null,
        title: '## Unused variable',
        line: 3,
      },
    ],
    [
      'a prioritized review thread on an outdated line',
      thread(
        [
          comment(
            bot,
            '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange)</sub></sub>  Guard the **cursor**\n\nDetails',
          ),
        ],
        null,
      ),
      {
        isBot: true,
        lastAuthor: 'github-advanced-security',
        alert: null,
        priority: 'P1',
        title: '[P1] Guard the cursor',
        line: 9,
      },
    ],
    [
      'a deleted author',
      thread([comment(null, 'old'), comment(human, 'reply')]),
      { author: 'ghost', isBot: false, lastAuthor: 'human-author', title: 'old' },
    ],
    [
      'a thread without comments',
      thread([]),
      {
        author: 'ghost',
        isBot: false,
        lastAuthor: null,
        alert: null,
        priority: null,
        title: '',
        url: null,
      },
    ],
  ])('maps %s', (_name, raw, expected) => {
    expect(mapReviewThread(raw)).toMatchObject(expected);
  });
});

// One executor run type-checks and imports a workflow module. measured: 1.4 s alone, 4.3 s in the
// full coverage run (dominated by the loader's type check and tsImport compile).
describe('dry-run', { timeout: 30_000 }, () => {
  it('lists every read in rehearsal commands with schema-valid synthesized values', async () => {
    await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
    await symlink(join(repository, 'node_modules'), join(cwd, 'node_modules'));
    const file = join(cwd, 'reads.workflow.ts');
    await writeFile(
      file,
      `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
import { github } from ${JSON.stringify(join(repository, 'src/integrations/github.js'))};
export default defineWorkflow({
  name: 'github-reads', version: '1', input: z.object({ repo: z.string() }), output: z.unknown(),
  async run(ctx, input) {
    const gh = github(ctx, { repo: input.repo });
    const info = await gh.repo.info('repo');
    const pr = await gh.pr.view('pr', { number: 1 });
    const list = await gh.pr.list('list', { base: pr.headRefName });
    const threads = await gh.pr.reviewThreads('threads', { number: pr.number });
    const issue = await gh.issue.view('issue', { number: pr.closingIssues[0]?.number ?? 1 });
    const comments = await gh.issue.view('comments', { number: issue.number, comments: true });
    const alerts = await gh.codeScanning.alerts('alerts', { ref: 'refs/pull/1/merge' });
    return { info, pr, list, threads, issue, comments, alerts };
  },
});
`,
    );
    const analysis = analyzeTypecheckEntrypoint(file, cwd);
    if (!analysis.ok) throw new Error('invalid workflow fixture');
    const spawned: unknown[] = [];
    const result = await new WorkflowExecutor({
      logger: new ThresholdLogger('silent', () => undefined),
      processRunner: {
        run: (request) => {
          spawned.push(request.command);
          return Promise.reject(new Error('A dry run reached the process runner.'));
        },
      },
    }).execute({
      kind: 'workflow.execute',
      typecheck: analysis.plan,
      runId: 'dry',
      stateDir: join(cwd, 'state'),
      cwd,
      input: { repo: 'enterprise.test/octo-org/quiet-choir' },
      resume: false,
      harness: { kind: 'cli', config: {} },
      dryRun: true,
    });
    if (result.kind !== 'workflow.run.result' || !result.rehearsal)
      throw new Error(JSON.stringify(result));
    expect(spawned).toEqual([]);
    expect(result.run.status).toBe('completed');
    expect(
      result.rehearsal.commands.map((command) => [command.stepId, command.outputSource]),
    ).toEqual(
      ['repo', 'pr', 'list', 'threads', 'issue', 'comments', 'alerts'].map((id) => [
        id,
        'synthesized',
      ]),
    );
    for (const command of result.rehearsal.commands)
      expect((command.command as readonly string[]).slice(0, 4)).toEqual([
        'gh',
        'api',
        '--hostname',
        'enterprise.test',
      ]);
    const output = result.run.output as {
      pr: { number: number; checks: { state: string } };
      threads: unknown[];
      alerts: { status: string; alerts: unknown[] };
    };
    // Synthesis passed the real schemas, completeness checks included, and the mappers.
    expect(output.pr.number).toBe(1);
    // A synthesized check run's status is never COMPLETED, so it counts as pending.
    expect(output.pr.checks.state).toBe('pending');
    expect(output.threads).toHaveLength(1);
    expect(output.alerts).toMatchObject({ status: 'ok', alerts: [expect.any(Object)] });
  });
});
