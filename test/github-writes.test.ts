import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defineWorkflow,
  NodeProcessRunner,
  readRun,
  runWorkflow,
  z,
  type ProcessRunner,
  type WorkflowContext,
} from '../src/index.js';
import { createFakeBinary, type FakeBinary } from '../src/harness-kit.js';
import {
  alertDismissReason,
  github,
  type GithubClient,
  type GithubWritePolicy,
} from '../src/integrations/github.js';
import {
  githubMarker,
  hasMarker,
  isTestPath,
  truncateDismissComment,
  withMarker,
} from '../src/integrations/github-write-model.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import { formatRunSummary } from '../src/cli/inspection-view.js';
import { ThresholdLogger } from '../src/application/execution.js';
import { WorkflowExecutor } from '../src/workflow/loader/executor.js';
import { analyzeTypecheckEntrypoint } from '../src/workflow/typecheck/plan.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = 'octo-org/quiet-choir';
const VIEWER = 'octo-bot';

// ---------------------------------------------------------------------------------------------
// The fake gh: a real executable on PATH whose state is a JSON file (test/bin/fake-gh-writes.mjs).

interface RestComment {
  readonly id: number;
  readonly user: { readonly login: string };
  readonly body: string;
  readonly html_url: string;
}
interface ThreadComment {
  readonly id: string;
  readonly url: string;
  readonly body: string;
  readonly author: { readonly login: string; readonly __typename: string } | null;
}
interface FakeIssue {
  readonly number: number;
  readonly node_id: string;
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
  readonly state: 'open' | 'closed';
  readonly state_reason: string | null;
  readonly creator: string;
  readonly parent: number | null;
  readonly pull_request?: boolean;
}
interface FakeAlert {
  readonly number: number;
  readonly state: string;
  readonly dismissed_reason?: string | null;
  readonly dismissed_comment?: string | null;
  readonly path: string | null;
}
interface FakeCall {
  readonly argv: readonly string[];
  readonly stdin: string | null;
}
interface FakeState {
  readonly comments: Record<string, RestComment[]>;
  readonly threads: Record<string, { isResolved: boolean; comments: ThreadComment[] }>;
  readonly issues: Record<string, FakeIssue>;
  readonly alerts: Record<string, FakeAlert>;
  readonly crashAfterCommit: string | null;
  readonly calls: FakeCall[];
}

let gh: FakeBinary;
beforeAll(async () => {
  gh = await createFakeBinary(
    'gh',
    readFileSync(join(repository, 'test', 'bin', 'fake-gh-writes.mjs'), 'utf8'),
  );
});
afterAll(async () => {
  await gh.dispose();
});

let cwd: string;
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'choir-github-writes-')));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});

/** Seed the fake's state; return a runner that puts the fake on PATH and a state reader. */
async function fake(seed: Partial<FakeState> = {}): Promise<{
  runner: ProcessRunner;
  state: () => Promise<FakeState>;
}> {
  const path = join(cwd, 'gh-state.json');
  await writeFile(
    path,
    JSON.stringify({
      comments: {},
      threads: {},
      issues: {},
      alerts: {},
      crashAfterCommit: null,
      calls: [],
      ...seed,
    }),
  );
  const native = new NodeProcessRunner();
  return {
    runner: {
      run: (request, invocation) =>
        native.run(
          { ...request, env: { ...request.env, ...gh.env, FAKE_GH_STATE: path } },
          invocation,
        ),
    },
    state: async () => JSON.parse(await readFile(path, 'utf8')) as FakeState,
  };
}

/** A write's route: the mutation name, or `METHOD path` without the repository prefix. */
function route(call: FakeCall): string | null {
  if (call.stdin === null) return null;
  if (call.argv.includes('graphql')) {
    const { query } = JSON.parse(call.stdin) as { query: string };
    return `graphql ${/\{\s*(\w+)\s*\(/u.exec(query)?.[1] ?? '?'}`;
  }
  const method = call.argv[call.argv.indexOf('-X') + 1] ?? '?';
  const path = call.argv.find((arg) => arg.startsWith('repos/')) ?? '';
  return `${method} ${path.replace(`repos/${REPO}/`, '')}`;
}
const writes = (state: FakeState): string[] =>
  state.calls.map(route).filter((entry): entry is string => entry !== null);

const issue = (number: number, overrides: Partial<FakeIssue> = {}): Record<string, FakeIssue> => ({
  [String(number)]: {
    number,
    node_id: `I_${String(number)}`,
    title: `Issue ${String(number)}`,
    body: 'Seeded.',
    state: 'open',
    state_reason: null,
    creator: 'someone',
    parent: null,
    ...overrides,
  },
});
const human = { login: 'human-author', __typename: 'User' };
const bot = { login: 'chatgpt-codex-connector[bot]', __typename: 'Bot' };
const thread = (author: ThreadComment['author'], isResolved = false) => ({
  isResolved,
  comments: [{ id: 'PRRC_first', url: 'https://github.com/x#first', body: 'Fix this.', author }],
});

const setup = (runId: string) => ({ cwd, stateDir: join(cwd, 'state'), runId, input: null });
const definition = (run: (ctx: WorkflowContext) => Promise<unknown>) =>
  defineWorkflow({
    name: 'github-writes',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run,
  });
const client = (ctx: WorkflowContext, repo = REPO): GithubClient => github(ctx, { repo });

/** Strip every HTML comment, as GitHub's renderer hides them. */
const rendered = (body: string): string => body.replace(/<!--[\s\S]*?-->/gu, '');

// ---------------------------------------------------------------------------------------------
// Crash windows (acceptance a1)

interface CrashCase {
  /** The step's `meta.op`. */
  readonly label: string;
  readonly seed: () => Partial<FakeState>;
  readonly crash: string;
  readonly op: (gh: GithubClient, policy: GithubWritePolicy) => Promise<unknown>;
  /** Exactly one remote object, found by the step's marker. */
  readonly check: (state: FakeState, marker: string) => void;
  readonly writes: readonly string[];
}

const marked = <T extends { readonly body: string }>(items: readonly T[], marker: string): T[] =>
  items.filter((item) => item.body.includes(marker));

const crashCases: Readonly<Record<string, CrashCase>> = {
  comment: {
    label: 'comment',
    seed: () => ({ issues: issue(7) }),
    crash: 'POST issues/7/comments',
    op: (gh, policy) => gh.comment('write', { number: 7, body: 'Landed.' }, policy),
    check: (state, marker) => {
      expect(state.comments['7']).toHaveLength(1);
      expect(marked(state.comments['7'] ?? [], marker)).toHaveLength(1);
    },
    writes: ['POST issues/7/comments'],
  },
  'thread.reply': {
    label: 'thread.reply',
    seed: () => ({ threads: { PRRT_bot: thread(bot) } }),
    crash: 'graphql addPullRequestReviewThreadReply',
    op: (gh, policy) => gh.thread.reply('write', { threadId: 'PRRT_bot', body: 'Fixed.' }, policy),
    check: (state, marker) => {
      expect(state.threads['PRRT_bot']?.comments).toHaveLength(2);
      expect(marked(state.threads['PRRT_bot']?.comments ?? [], marker)).toHaveLength(1);
      expect(state.threads['PRRT_bot']?.isResolved).toBe(true);
    },
    writes: ['graphql addPullRequestReviewThreadReply', 'graphql resolveReviewThread'],
  },
  'issue.create': {
    label: 'issue.create',
    seed: () => ({}),
    crash: 'POST issues',
    op: (gh, policy) => gh.issue.create('write', { title: 'Follow-up', body: 'Do it.' }, policy),
    check: (state, marker) => {
      expect(Object.values(state.issues)).toHaveLength(1);
      expect(marked(Object.values(state.issues), marker)).toHaveLength(1);
    },
    writes: ['POST issues'],
  },
  'issue.create with parent, crashed after the create': {
    label: 'issue.create',
    seed: () => ({ issues: issue(5) }),
    crash: 'POST issues',
    op: (gh, policy) =>
      gh.issue.create('write', { title: 'Child', body: 'Do it.', parent: 5 }, policy),
    check: (state, marker) => {
      expect(Object.values(state.issues)).toHaveLength(2);
      const [child] = marked(Object.values(state.issues), marker);
      expect(child?.parent).toBe(5);
    },
    writes: ['POST issues', 'graphql addSubIssue'],
  },
  'issue.create with parent, crashed after the link': {
    label: 'issue.create',
    seed: () => ({ issues: issue(5) }),
    crash: 'graphql addSubIssue',
    op: (gh, policy) =>
      gh.issue.create('write', { title: 'Child', body: 'Do it.', parent: 5 }, policy),
    check: (state, marker) => {
      expect(Object.values(state.issues)).toHaveLength(2);
      expect(marked(Object.values(state.issues), marker)[0]?.parent).toBe(5);
    },
    writes: ['POST issues', 'graphql addSubIssue'],
  },
  'issue.close comment': {
    label: 'issue.close',
    seed: () => ({ issues: issue(7) }),
    crash: 'POST issues/7/comments',
    op: (gh, policy) => gh.issue.close('write', { number: 7, comment: 'Done in #9.' }, policy),
    check: (state, marker) => {
      expect(marked(state.comments['7'] ?? [], marker)).toHaveLength(1);
      expect(state.comments['7']).toHaveLength(1);
      expect(state.issues['7']).toMatchObject({ state: 'closed', state_reason: 'completed' });
    },
    writes: ['POST issues/7/comments', 'PATCH issues/7'],
  },
  'issue.reopen comment': {
    label: 'issue.reopen',
    seed: () => ({ issues: issue(7, { state: 'closed', state_reason: 'completed' }) }),
    crash: 'POST issues/7/comments',
    op: (gh, policy) => gh.issue.reopen('write', { number: 7, comment: 'Not done.' }, policy),
    check: (state, marker) => {
      expect(state.comments['7']).toHaveLength(1);
      expect(marked(state.comments['7'] ?? [], marker)).toHaveLength(1);
      expect(state.issues['7']?.state).toBe('open');
    },
    writes: ['POST issues/7/comments', 'PATCH issues/7'],
  },
};

// Each case spawns the fake gh 3 to 9 times; 0.1-0.3 s alone, so the default timeout fits.
describe('crash windows', () => {
  it.each(Object.keys(crashCases))(
    '%s: a retry after a committed write finds it instead of writing again',
    async (name) => {
      const testCase = crashCases[name];
      if (!testCase) throw new Error(name);
      const { runner, state } = await fake({
        ...testCase.seed(),
        crashAfterCommit: testCase.crash,
      });
      const run = await runWorkflow(
        definition((ctx) => testCase.op(client(ctx), { retry: { maxAttempts: 2, delayMs: 1 } })),
        { ...setup('retry'), processRunner: runner },
      );
      expect(run.status).toBe('completed');
      expect(run.steps['write']?.attempts).toBe(2);
      const after = await state();
      expect(after.crashAfterCommit).toBeNull();
      testCase.check(after, githubMarker('retry/write'));
      expect(writes(after)).toEqual(testCase.writes);
    },
  );

  it.each(Object.keys(crashCases))(
    '%s: a resume after a failed step finds the committed write',
    async (name) => {
      const testCase = crashCases[name];
      if (!testCase) throw new Error(name);
      const { runner, state } = await fake({
        ...testCase.seed(),
        crashAfterCommit: testCase.crash,
      });
      const workflow = definition((ctx) => testCase.op(client(ctx), {}));
      await expect(
        runWorkflow(workflow, { ...setup('resume'), processRunner: runner }),
      ).rejects.toThrow();
      const failed = (await readRun({ stateDir: join(cwd, 'state'), runId: 'resume' })).steps[
        'write'
      ];
      expect(failed).toMatchObject({ status: 'failed', output: null });
      // The failed step shows its integration label in inspect.
      expect(formatRunSummary((await inspectRun(setup('resume'))).summary)).toContain(
        `failed write  github.${testCase.label}`,
      );
      const run = await runWorkflow(workflow, {
        ...setup('resume'),
        processRunner: runner,
        resume: true,
      });
      expect(run.status).toBe('completed');
      const after = await state();
      testCase.check(after, githubMarker('resume/write'));
      expect(writes(after)).toEqual(testCase.writes);
    },
  );

  it('acts at most once on a close whose state change committed before the crash', async () => {
    const { runner, state } = await fake({
      issues: issue(7),
      crashAfterCommit: 'PATCH issues/7',
    });
    const run = await runWorkflow(
      definition((ctx) =>
        client(ctx).issue.close(
          'write',
          { number: 7, comment: 'Done.', reason: 'not_planned' },
          { retry: { maxAttempts: 2, delayMs: 1 } },
        ),
      ),
      { ...setup('patched'), processRunner: runner },
    );
    // The retry sees a closed issue: acted is false although the step closed it.
    expect(run.output).toEqual({
      number: 7,
      state: 'CLOSED',
      stateReason: 'NOT_PLANNED',
      acted: false,
      comment: null,
    });
    const after = await state();
    expect(writes(after)).toEqual(['POST issues/7/comments', 'PATCH issues/7']);
    expect(after.comments['7']).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Markers (a2, a3)

describe('markers', () => {
  it('are HTML comments of exactly the run and scoped step IDs, hidden when rendered, with no environment value', async () => {
    const token = 'ghp_SENTINELtoken0123456789abcdef';
    const sentinel = 'sentinel-value-7f3a9c';
    vi.stubEnv('GH_TOKEN', token);
    vi.stubEnv('QC_TEST_SENTINEL', sentinel);
    const { runner, state } = await fake({
      issues: issue(7),
      threads: { PRRT_human: thread(human) },
    });
    const bodies = {
      comment: 'Landed in **#9**.\n\n- item',
      reply: 'Thanks, fixed.',
      issue: 'Body of the follow-up.',
    };
    await runWorkflow(
      definition((ctx) =>
        ctx.scope('round-1', async () => {
          const gh = client(ctx);
          await gh.comment('note', { number: 7, body: bodies.comment });
          await gh.thread.reply('reply', { threadId: 'PRRT_human', body: bodies.reply });
          await gh.issue.create('file', { title: 'Follow-up', body: bodies.issue });
          return null;
        }),
      ),
      { ...setup('markers'), processRunner: runner },
    );
    const after = await state();
    const posted = {
      comment: after.comments['7']?.[0]?.body ?? '',
      reply: after.threads['PRRT_human']?.comments[1]?.body ?? '',
      issue: Object.values(after.issues).find((entry) => entry.creator === VIEWER)?.body ?? '',
    };
    const ids = { comment: 'note', reply: 'reply', issue: 'file' } as const;
    for (const key of ['comment', 'reply', 'issue'] as const) {
      const marker = `<!-- quiet-choir:markers/round-1/${ids[key]} -->`;
      expect(githubMarker(`markers/round-1/${ids[key]}`)).toBe(marker);
      // The marker follows the body after a blank line; rendering hides it, leaving that line.
      expect(posted[key]).toBe(`${bodies[key]}\n\n${marker}`);
      expect(rendered(posted[key])).toBe(`${bodies[key]}\n\n`);
      expect(rendered(posted[key]).trimEnd()).toBe(bodies[key]);
      expect(marker.startsWith('<!--') && marker.endsWith('-->')).toBe(true);
    }
    expect(after.calls.length).toBeGreaterThan(0);
    for (const call of after.calls)
      for (const secret of [token, sentinel]) {
        expect(call.argv.join(' ')).not.toContain(secret);
        expect(call.stdin ?? '').not.toContain(secret);
      }
  });

  it('match only the exact full marker and refuse a key that could end the comment', () => {
    expect(hasMarker(`x\n\n${githubMarker('run/a2')}`, 'run/a')).toBe(false);
    expect(hasMarker(`x\n\n${githubMarker('run/a')}`, 'run/a')).toBe(true);
    expect(hasMarker(null, 'run/a')).toBe(false);
    expect(() => githubMarker('run/a -->')).toThrow(/Invalid idempotency key/u);
    expect(() => githubMarker('')).toThrow(/Invalid idempotency key/u);
    expect(() => withMarker('x'.repeat(65_536), 'run/a')).toThrow(/at most 65536/u);
    // Code points, not UTF-16 units: an emoji body near the limit still fits.
    const marker = githubMarker('run/a');
    expect(withMarker('😀'.repeat(65_536 - marker.length - 2), 'run/a')).toHaveLength(
      2 * (65_536 - marker.length - 2) + marker.length + 2,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Conditional ops (a4) and the reply and parent rules (a8)

describe('conditional ops', () => {
  it('return success data without a write when the precondition does not hold', async () => {
    const { runner, state } = await fake({
      issues: {
        ...issue(7, { state: 'closed', state_reason: 'completed' }),
        ...issue(8),
      },
      alerts: {
        '3': { number: 3, state: 'dismissed', dismissed_reason: "won't fix", path: 'src/a.ts' },
        '4': { number: 4, state: 'fixed', path: 'src/b.ts' },
      },
    });
    const run = await runWorkflow(
      definition(async (ctx) => {
        const gh = client(ctx);
        return {
          close: await gh.issue.close('close', { number: 7, comment: 'Closing.' }),
          reopen: await gh.issue.reopen('reopen', { number: 8, comment: 'Reopening.' }),
          dismissed: await gh.alert.dismiss('dismissed', { number: 3, comment: 'Test only.' }),
          fixed: await gh.alert.dismiss('fixed', { number: 4, comment: 'Test only.' }),
        };
      }),
      { ...setup('conditional'), processRunner: runner },
    );
    expect(run.output).toEqual({
      close: { number: 7, state: 'CLOSED', stateReason: 'COMPLETED', acted: false, comment: null },
      reopen: { number: 8, state: 'OPEN', stateReason: null, acted: false, comment: null },
      dismissed: { number: 3, state: 'dismissed', reason: "won't fix", dismissed: false },
      fixed: { number: 4, state: 'fixed', reason: null, dismissed: false },
    });
    const after = await state();
    // Only the four reads: no comment, PATCH or dismissal.
    expect(after.calls).toHaveLength(4);
    expect(writes(after)).toEqual([]);
    expect(after.comments).toEqual({});
  });

  it('dismisses an open alert with the path rule, an explicit reason and a truncated comment', async () => {
    const { runner, state } = await fake({
      alerts: {
        '3': { number: 3, state: 'open', path: 'test/helpers/fake.ts' },
        '4': { number: 4, state: 'open', path: 'src/index.ts' },
        '5': { number: 5, state: 'open', path: 'test/a.test.ts' },
      },
    });
    const long = `${'é'.repeat(279)}😀tail`;
    const run = await runWorkflow(
      definition(async (ctx) => {
        const gh = client(ctx);
        return [
          await gh.alert.dismiss('a3', { number: 3, comment: long }),
          await gh.alert.dismiss('a4', { number: 4, comment: 'Not reachable.' }),
          await gh.alert.dismiss('a5', { number: 5, comment: 'Later.', reason: "won't fix" }),
        ];
      }),
      { ...setup('dismiss'), processRunner: runner },
    );
    expect(run.output).toEqual([
      { number: 3, state: 'dismissed', reason: 'used in tests', dismissed: true },
      { number: 4, state: 'dismissed', reason: 'false positive', dismissed: true },
      { number: 5, state: 'dismissed', reason: "won't fix", dismissed: true },
    ]);
    const after = await state();
    expect(after.alerts['3']?.dismissed_comment).toBe(`${'é'.repeat(279)}😀`);
    expect(writes(after)).toEqual([
      'PATCH code-scanning/alerts/3',
      'PATCH code-scanning/alerts/4',
      'PATCH code-scanning/alerts/5',
    ]);
  });

  it('resolves bot threads and leaves human threads open by default; resolve overrides both ways', async () => {
    const { runner, state } = await fake({
      threads: {
        PRRT_bot: thread(bot),
        PRRT_human: thread(human),
        PRRT_human_resolve: thread(human),
        PRRT_bot_keep: thread(bot),
        PRRT_resolved: thread(bot, true),
      },
    });
    const run = await runWorkflow(
      definition(async (ctx) => {
        const gh = client(ctx);
        const reply = (id: string, resolve?: boolean) =>
          gh.thread.reply(id, {
            threadId: `PRRT_${id}`,
            body: 'Done.',
            ...(resolve === undefined ? {} : { resolve }),
          });
        return [
          (await reply('bot')).resolved,
          (await reply('human')).resolved,
          (await reply('human_resolve', true)).resolved,
          (await reply('bot_keep', false)).resolved,
          (await reply('resolved', true)).resolved,
        ];
      }),
      { ...setup('resolve'), processRunner: runner },
    );
    expect(run.output).toEqual([true, false, true, false, true]);
    const after = await state();
    expect(
      Object.fromEntries(Object.entries(after.threads).map(([id, t]) => [id, t.isResolved])),
    ).toEqual({
      PRRT_bot: true,
      PRRT_human: false,
      PRRT_human_resolve: true,
      PRRT_bot_keep: false,
      PRRT_resolved: true,
    });
    // An already-resolved thread gets its reply but no resolve mutation.
    expect(writes(after).filter((entry) => entry === 'graphql resolveReviewThread')).toHaveLength(
      2,
    );
    expect(
      writes(after).filter((entry) => entry === 'graphql addPullRequestReviewThreadReply'),
    ).toHaveLength(5);
  });

  it('verifies a sub-issue link by lookup: same parent writes nothing, a different parent throws', async () => {
    const key = (id: string) => githubMarker(`parents/${id}`);
    const { runner, state } = await fake({
      issues: {
        ...issue(5),
        ...issue(6),
        ...issue(9),
        ...issue(10, { creator: VIEWER, body: `Same.\n\n${key('same')}`, parent: 5 }),
        ...issue(11, { creator: VIEWER, body: `Other.\n\n${key('other')}`, parent: 6 }),
        ...issue(12, { creator: VIEWER, body: `PR.\n\n${key('other')}`, pull_request: true }),
      },
    });
    let thrown: unknown;
    await expect(
      runWorkflow(
        definition(async (ctx) => {
          const gh = client(ctx);
          const same = await gh.issue.create('same', { title: 'Same', body: 'Same.', parent: 5 });
          expect(same).toMatchObject({ number: 10, created: false, parent: 5 });
          try {
            await gh.issue.create('other', { title: 'Other', body: 'Other.', parent: 9 });
          } catch (error) {
            thrown = error;
            throw error;
          }
        }),
        { ...setup('parents'), processRunner: runner },
      ),
    ).rejects.toThrow();
    expect(String(thrown)).toMatch(/already has parent octo-org\/quiet-choir#6, not #9/u);
    const after = await state();
    expect(writes(after)).toEqual([]);
    expect(after.issues['11']?.parent).toBe(6);
  });

  it('throws on the opposite ifState literal and on invalid arguments before the step opens', async () => {
    const { runner, state } = await fake();
    const attempts: Record<string, (gh: GithubClient) => Promise<unknown>> = {
      'close ifState closed': (gh) =>
        gh.issue.close('w', { number: 7, ifState: 'closed' as unknown as 'open' }),
      'reopen ifState open': (gh) =>
        gh.issue.reopen('w', { number: 7, ifState: 'open' as unknown as 'closed' }),
      'close reason': (gh) =>
        gh.issue.close('w', { number: 7, reason: 'duplicate' as unknown as 'completed' }),
      'comment number': (gh) => gh.comment('w', { number: 0, body: 'x' }),
      'comment body': (gh) => gh.comment('w', { number: 1, body: '' }),
      'comment NUL': (gh) => gh.comment('w', { number: 1, body: 'a\0b' }),
      'comment length': (gh) => gh.comment('w', { number: 1, body: 'x'.repeat(65_537) }),
      'reply threadId': (gh) => gh.thread.reply('w', { threadId: '', body: 'x' }),
      'reply resolve': (gh) =>
        gh.thread.reply('w', { threadId: 'T', body: 'x', resolve: 'yes' as unknown as boolean }),
      'create labels': (gh) =>
        gh.issue.create('w', { title: 't', body: 'b', labels: [''] as readonly string[] }),
      'create parent': (gh) => gh.issue.create('w', { title: 't', body: 'b', parent: 1.5 }),
      'dismiss reason': (gh) =>
        gh.alert.dismiss('w', {
          number: 1,
          comment: 'c',
          reason: 'nope' as unknown as "won't fix",
        }),
      'dismiss comment': (gh) => gh.alert.dismiss('w', { number: 1, comment: '' }),
      policy: (gh) =>
        gh.comment('w', { number: 1, body: 'x' }, { every: 1 } as unknown as GithubWritePolicy),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      const runId = name.replace(/[^a-z]/gu, '-');
      await expect(
        runWorkflow(
          definition((ctx) => attempt(client(ctx))),
          { ...setup(runId), processRunner: runner },
        ),
        name,
      ).rejects.toThrow();
      expect(
        (await readRun({ stateDir: join(cwd, 'state'), runId })).steps,
        `${name} opened no step`,
      ).toEqual({});
    }
    expect((await state()).calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Pure rules

describe('alertDismissReason', () => {
  const extensions = ['js', 'ts', 'cjs', 'mjs', 'cts', 'mts'];
  const table: readonly (readonly [string | null, 'used in tests' | 'false positive'])[] = [
    ['test/helpers/fake.ts', 'used in tests'],
    ['tests/a.js', 'used in tests'],
    ['src/__tests__/a.ts', 'used in tests'],
    ['packages/x/test/a.go', 'used in tests'],
    ...extensions.flatMap((extension) => [
      [`src/a.test.${extension}`, 'used in tests'] as const,
      [`src/a.spec.${extension}`, 'used in tests'] as const,
    ]),
    ['src/a.test.tsx', 'false positive'],
    ['src/testing/a.ts', 'false positive'],
    ['src/contest/a.ts', 'false positive'],
    ['src/latest.ts', 'false positive'],
    ['src/index.ts', 'false positive'],
    [null, 'false positive'],
  ];
  it.each(table)('maps %s to %s', (path, reason) => {
    expect(alertDismissReason(path, undefined)).toBe(reason);
    expect(isTestPath(path ?? '')).toBe(reason === 'used in tests');
  });

  it('lets an explicit reason win', () => {
    expect(alertDismissReason('test/a.ts', "won't fix")).toBe("won't fix");
    expect(alertDismissReason('src/a.ts', 'used in tests')).toBe('used in tests');
    expect(alertDismissReason(null, 'false positive')).toBe('false positive');
  });

  it('truncates a dismissal comment to 280 code points', () => {
    expect(truncateDismissComment('short')).toBe('short');
    expect(truncateDismissComment('x'.repeat(281))).toBe('x'.repeat(280));
    const emoji = '😀'.repeat(300);
    expect(Array.from(truncateDismissComment(emoji))).toHaveLength(280);
    expect(truncateDismissComment(emoji)).toBe('😀'.repeat(280));
  });
});

// ---------------------------------------------------------------------------------------------
// Requests, labels and rehearsal

describe('requests and labels', () => {
  it('sends request bodies on stdin, never in argv, with --hostname after api for an Enterprise repo', async () => {
    const { runner, state } = await fake({
      issues: issue(7),
      alerts: { '3': { number: 3, state: 'open', path: 'src/a.ts' } },
    });
    const run = await runWorkflow(
      definition(async (ctx) => {
        const gh = client(ctx, `enterprise.test/${REPO}`);
        await gh.comment('note', { number: 7, body: 'Body text 7c1e.' });
        await gh.issue.close('close', { number: 7 });
        await gh.alert.dismiss('dismiss', { number: 3, comment: 'Comment text 9b2d.' });
        return null;
      }),
      { ...setup('requests'), processRunner: runner },
    );
    const after = await state();
    expect(writes(after)).toEqual([
      'POST issues/7/comments',
      'PATCH issues/7',
      'PATCH code-scanning/alerts/3',
    ]);
    for (const call of after.calls) {
      expect(call.argv.slice(0, 4)).toEqual(['gh', 'api', '--hostname', 'enterprise.test']);
      expect(call.argv.indexOf('--hostname')).toBe(call.argv.lastIndexOf('--hostname'));
      expect(call.argv.join(' ')).not.toMatch(/7c1e|9b2d/u);
      if (call.stdin !== null) expect(call.argv.slice(-2)).toEqual(['--input', '-']);
    }
    const bodies = after.calls.flatMap((call) => (call.stdin === null ? [] : [call.stdin]));
    expect(JSON.parse(bodies[0] ?? '')).toEqual({
      body: `Body text 7c1e.\n\n${githubMarker('requests/note')}`,
    });
    expect(JSON.parse(bodies[1] ?? '')).toEqual({ state: 'closed', state_reason: 'completed' });
    expect(JSON.parse(bodies[2] ?? '')).toEqual({
      state: 'dismissed',
      dismissed_reason: 'false positive',
      dismissed_comment: 'Comment text 9b2d.',
    });

    // Labels: { integration: 'github', op } on each step; inspect shows a failed one by it.
    expect(
      Object.fromEntries(Object.entries(run.steps).map(([id, step]) => [id, step.meta])),
    ).toEqual({
      note: { integration: 'github', op: 'comment' },
      close: { integration: 'github', op: 'issue.close' },
      dismiss: { integration: 'github', op: 'alert.dismiss' },
    });
  });
});

// One executor run type-checks and imports a workflow module. measured: 1.4 s alone (dominated by
// the loader's type check and tsImport compile), like the read dry-run in test/github.test.ts.
describe('dry-run', { timeout: 30_000 }, () => {
  it('lists every write in rehearsal commands under its step and spawns nothing', async () => {
    await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
    await symlink(join(repository, 'node_modules'), join(cwd, 'node_modules'));
    const file = join(cwd, 'writes.workflow.ts');
    await writeFile(
      file,
      `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
import { github } from ${JSON.stringify(join(repository, 'src/integrations/github.js'))};
export default defineWorkflow({
  name: 'github-writes', version: '1', input: z.object({ repo: z.string() }), output: z.unknown(),
  async run(ctx, input) {
    const gh = github(ctx, { repo: input.repo });
    return {
      comment: await gh.comment('comment', { number: 7, body: 'Landed.' }),
      reply: await gh.thread.reply('reply', { threadId: 'PRRT_x', body: 'Fixed.', resolve: true }),
      create: await gh.issue.create('create', { title: 'Follow-up', body: 'Do it.', parent: 5 }),
      close: await gh.issue.close('close', { number: 7, comment: 'Done.' }),
      reopen: await gh.issue.reopen('reopen', { number: 7 }),
      dismiss: await gh.alert.dismiss('dismiss', { number: 3, comment: 'Test only.' }),
    };
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
      input: { repo: REPO },
      resume: false,
      harness: { kind: 'cli', config: {} },
      dryRun: true,
    });
    if (result.kind !== 'workflow.run.result' || !result.rehearsal)
      throw new Error(JSON.stringify(result));
    expect(spawned).toEqual([]);
    expect(result.run.status).toBe('completed');
    const commands = result.rehearsal.commands;
    for (const command of commands)
      expect(command).toMatchObject({
        parentStepId: command.stepId,
        outputSource: 'synthesized',
      });
    const written = commands.flatMap((command) => {
      const argv = command.command as readonly string[];
      if (!argv.includes('--input')) return [];
      const path = argv.find((arg) => arg.startsWith('repos/'));
      return [
        `${command.stepId} ${path === undefined ? 'graphql' : (argv[argv.indexOf('-X') + 1] ?? '')} ${path ?? ''}`.trim(),
      ];
    });
    expect(written).toEqual([
      `comment POST repos/${REPO}/issues/7/comments`,
      'reply graphql',
      'reply graphql',
      `create POST repos/${REPO}/issues`,
      'create graphql',
      `close POST repos/${REPO}/issues/7/comments`,
      `close PATCH repos/${REPO}/issues/7`,
      `dismiss PATCH repos/${REPO}/code-scanning/alerts/3`,
    ]);
    // A synthesized issue is open, so the rehearsed reopen takes its skip path: only its read.
    expect(commands.filter((command) => command.stepId === 'reopen')).toHaveLength(1);
    expect(result.run.output).toMatchObject({
      comment: { created: true },
      reply: { created: true, resolved: true },
      create: { created: true, parent: 5 },
      close: { acted: true, state: 'CLOSED' },
      reopen: { acted: false },
      dismiss: { dismissed: true, reason: 'false positive' },
    });
  });
});
