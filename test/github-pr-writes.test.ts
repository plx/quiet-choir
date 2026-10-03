import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readRun, runWorkflow, stepId, type WorkflowContext } from '../src/index.js';
import {
  github,
  IncompleteCollectionError,
  parseGithubRepo,
  type GithubClient,
  type GithubWritePolicy,
} from '../src/integrations/github.js';
import {
  confirm,
  CONFIRM_ATTEMPTS,
  CONFIRM_DELAY_MS,
  githubWrites,
  signalSleep,
  type GithubWriteOps,
} from '../src/integrations/github-writes.js';
import {
  createDecision,
  editChanges,
  githubMarker,
  mergeArgv,
  mergeFailure,
  mergePrecheck,
  mergeResponseSchema,
  pullListArgv,
  pullListResponseSchema,
  pullListState,
  pullPatchResponseSchema,
  pullPostResponseSchema,
  pullResponseSchema,
  pullState,
  rerunConfirmed,
  rerunSelection,
  runsListResponseSchema,
  uniqueRuns,
  type WorkflowRunRow,
} from '../src/integrations/github-write-model.js';
import { inspectRun } from '../src/workflow/loader/inspection.js';
import { formatRunSummary } from '../src/cli/inspection-view.js';
import {
  definition,
  imports,
  REPO,
  repository,
  useGithubFake,
  type FakeCall,
  type RehearsedCommands,
} from './github-fake.js';

// ---------------------------------------------------------------------------------------------
// The fake gh (test/bin/fake-gh-writes.mjs) with pull requests and workflow runs.

interface FakePull {
  readonly number: number;
  readonly node_id: string;
  readonly head: string;
  readonly head_sha: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft?: boolean;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly merge_commit_sha: string | null;
  readonly mergeable?: boolean;
  readonly merge_method?: string;
}
interface FakeRun {
  readonly id: number;
  readonly name: string;
  readonly head_sha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly run_attempt: number;
}
interface FakeState {
  readonly pulls: Record<string, FakePull>;
  readonly runs: Record<string, FakeRun>;
  readonly crashAfterCommit: string | null;
  readonly calls: FakeCall[];
  readonly pushBeforeMerge?: string | null;
  readonly mergeError?: { readonly message: string; readonly status?: string } | null;
  readonly mergeLag?: number;
  readonly runsTotalCount?: number;
  readonly runsPages?: readonly (readonly number[])[];
  readonly branches?: Record<string, string>;
}

const harness = useGithubFake('choir-github-pr-writes-');
const { cwd, setup, rehearse, project } = harness;
const fake = (seed: Partial<FakeState> = {}) => harness.fake<FakeState>(seed);

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
/** The fake's merge commit for pull request 9. */
const MERGE_COMMIT_9 = `${'c'.repeat(39)}9`;

const pull = (number: number, overrides: Partial<FakePull> = {}): Record<string, FakePull> => ({
  [String(number)]: {
    number,
    node_id: `PR_${String(number)}`,
    head: 'feature',
    head_sha: HEAD,
    base: 'main',
    title: 'Feature',
    body: 'Seeded.',
    state: 'open',
    merged: false,
    merge_commit_sha: null,
    ...overrides,
  },
});
const run = (id: number, overrides: Partial<FakeRun> = {}): Record<string, FakeRun> => ({
  [String(id)]: {
    id,
    name: `Workflow ${String(id)}`,
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'failure',
    run_attempt: 1,
    ...overrides,
  },
});

/** A write's route: `METHOD path` without the repository prefix or query; null for a read. */
function route(call: FakeCall): string | null {
  const method = call.argv.includes('-X') ? (call.argv[call.argv.indexOf('-X') + 1] ?? '?') : 'GET';
  if (method === 'GET') return null;
  const path = call.argv.find((arg) => arg.startsWith('repos/')) ?? '';
  return `${method} ${path.replace(`repos/${REPO}/`, '')}`;
}
const writes = (state: FakeState): string[] =>
  state.calls.map(route).filter((entry): entry is string => entry !== null);
const putCalls = (calls: readonly FakeCall[]): FakeCall[] =>
  calls.filter((call) => call.argv.includes('PUT'));

const client = (ctx: WorkflowContext, repo = REPO): GithubClient => github(ctx, { repo });

/** The write ops with an injected confirmation sleep, as `github()` builds them. */
const fastWrites = (
  ctx: WorkflowContext,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
): GithubWriteOps =>
  githubWrites(ctx, parseGithubRepo(REPO), {
    policy: (policy) => policy ?? {},
    rethrow: (error) => {
      throw error;
    },
    sleep,
  });

/** Run one workflow; return its output, or the error it rejected with. */
async function outcome(
  runner: Awaited<ReturnType<typeof fake>>['runner'],
  runId: string,
  op: (ctx: WorkflowContext) => Promise<unknown>,
): Promise<{ readonly output?: unknown; readonly error?: unknown }> {
  try {
    return {
      output: (await runWorkflow(definition(op), { ...setup(runId), processRunner: runner }))
        .output,
    };
  } catch (error) {
    return { error };
  }
}

// ---------------------------------------------------------------------------------------------
// Crash windows (acceptance a2, a3, a6 and the edit retry of a5)

interface CrashCase {
  /** The step's `meta.op`. */
  readonly label: string;
  readonly seed: () => Partial<FakeState>;
  readonly crash: string;
  readonly op: (gh: GithubClient, policy: GithubWritePolicy) => Promise<unknown>;
  /** The remote state after the second attempt, and that attempt's result. */
  readonly check: (state: FakeState, marker: string, output: unknown) => void;
  readonly writes: readonly string[];
}

const crashCases: Readonly<Record<string, CrashCase>> = {
  'pr.create': {
    label: 'pr.create',
    seed: () => ({}),
    crash: 'POST pulls',
    op: (gh, policy) =>
      gh.pr.create(
        'write',
        { head: 'feature', base: 'main', title: 'Feature', body: 'Adds it.' },
        policy,
      ),
    check: (state, marker, output) => {
      const pulls = Object.values(state.pulls).filter(
        (entry) => entry.head === 'feature' && entry.base === 'main',
      );
      expect(pulls).toHaveLength(1);
      expect(pulls[0]?.body).toBe(`Adds it.\n\n${marker}`);
      expect(output).toEqual({
        number: 1,
        url: `https://github.com/${REPO}/pull/1`,
        nodeId: 'PR_1',
        state: 'open',
        created: false,
      });
    },
    writes: ['POST pulls'],
  },
  'pr.merge': {
    label: 'pr.merge',
    seed: () => ({ pulls: pull(9) }),
    crash: 'PUT pulls/9/merge',
    op: (gh, policy) => gh.pr.merge('write', { number: 9, sha: HEAD }, policy),
    check: (state, _marker, output) => {
      expect(state.pulls['9']).toMatchObject({ merged: true, merge_commit_sha: MERGE_COMMIT_9 });
      // The existing merge commit, found by the retry's read: no second PUT.
      expect(output).toEqual({
        merged: true,
        number: 9,
        mergeCommit: MERGE_COMMIT_9,
        head: HEAD,
        acted: false,
      });
    },
    writes: ['PUT pulls/9/merge'],
  },
  'pr.edit': {
    label: 'pr.edit',
    seed: () => ({ pulls: pull(9) }),
    crash: 'PATCH pulls/9',
    op: (gh, policy) =>
      gh.pr.edit('write', { number: 9, expectHead: HEAD, title: 'Retitled' }, policy),
    check: (state, _marker, output) => {
      expect(state.pulls['9']?.title).toBe('Retitled');
      // Nothing differs after the committed PATCH, so the retry sends none.
      expect(output).toEqual({ number: 9, edited: false, reason: null, head: HEAD, changed: [] });
    },
    writes: ['PATCH pulls/9'],
  },
  'checks.rerunFailed': {
    label: 'checks.rerunFailed',
    seed: () => ({
      runs: {
        ...run(101, { name: 'CI' }),
        ...run(102, { name: 'CodeQL', run_attempt: 2 }),
        ...run(103, { name: 'Review', conclusion: 'success' }),
      },
    }),
    crash: 'POST actions/runs/101/rerun-failed-jobs',
    op: (gh, policy) => gh.checks.rerunFailed('write', { sha: HEAD }, policy),
    check: (state, _marker, output) => {
      expect(state.runs['101']).toMatchObject({ run_attempt: 2, status: 'queued' });
      expect(state.runs['102']).toMatchObject({ run_attempt: 2, status: 'completed' });
      // The crashed attempt's rerun advanced run 101 past the baseline: skipped, never rerun again.
      expect(output).toEqual({
        rerun: [],
        skipped: [
          { id: 102, name: 'CodeQL', attempt: 2 },
          { id: 101, name: 'CI', attempt: 2 },
        ],
        confirmed: true,
      });
    },
    writes: ['POST actions/runs/101/rerun-failed-jobs'],
  },
};

// Each case spawns the fake gh 2 to 4 times; well within the default timeout.
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
      const result = await runWorkflow(
        definition((ctx) => testCase.op(client(ctx), { retry: { maxAttempts: 2, delayMs: 1 } })),
        { ...setup('retry'), processRunner: runner },
      );
      expect(result.status).toBe('completed');
      expect(result.steps['write']?.attempts).toBe(2);
      const after = await state();
      expect(after.crashAfterCommit).toBeNull();
      testCase.check(after, githubMarker('retry/write'), result.output);
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
      const failed = (await readRun({ stateDir: join(cwd(), 'state'), runId: 'resume' })).steps[
        'write'
      ];
      expect(failed).toMatchObject({ status: 'failed', output: null });
      expect(formatRunSummary((await inspectRun(setup('resume'))).summary)).toContain(
        `failed write  github.${testCase.label}`,
      );
      const resumed = await runWorkflow(workflow, {
        ...setup('resume'),
        processRunner: runner,
        resume: true,
      });
      expect(resumed.status).toBe('completed');
      const after = await state();
      testCase.check(after, githubMarker('resume/write'), resumed.output);
      expect(writes(after)).toEqual(testCase.writes);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// pr.merge (a1, a4, a8)

describe('pr.merge', () => {
  it('returns head-moved without a PUT when the head already moved', async () => {
    const { runner, state } = await fake({ pulls: pull(9, { head_sha: OTHER }) });
    const result = await outcome(runner, 'moved', (ctx) =>
      client(ctx).pr.merge('merge', { number: 9, sha: HEAD }),
    );
    expect(result.output).toEqual({
      merged: false,
      number: 9,
      reason: 'head-moved',
      head: OTHER,
      message: null,
    });
    const after = await state();
    expect(after.calls).toHaveLength(1);
    expect(after.calls.some((call) => call.argv.includes('PUT'))).toBe(false);
    expect(after.pulls['9']?.merged).toBe(false);
  });

  it('returns head-moved when GitHub answers 409 because the head moved after the read', async () => {
    const { runner, state } = await fake({ pulls: pull(9), pushBeforeMerge: OTHER });
    const result = await outcome(runner, 'raced', (ctx) =>
      client(ctx).pr.merge('merge', { number: 9, sha: HEAD }),
    );
    expect(result.output).toEqual({
      merged: false,
      number: 9,
      reason: 'head-moved',
      head: OTHER,
      message: 'Head branch was modified. Review and try the merge again.',
    });
    const after = await state();
    expect(putCalls(after.calls)).toHaveLength(1);
    expect(writes(after)).toEqual(['PUT pulls/9/merge']);
    expect(after.pulls['9']?.merged).toBe(false);
  });

  it('treats a pull request already merged at sha as success, with no PUT', async () => {
    const commit = 'd'.repeat(40);
    const { runner, state } = await fake({
      pulls: pull(9, { state: 'closed', merged: true, merge_commit_sha: commit }),
    });
    const result = await outcome(runner, 'merged', (ctx) =>
      client(ctx).pr.merge('merge', { number: 9, sha: HEAD }),
    );
    expect(result.output).toEqual({
      merged: true,
      number: 9,
      mergeCommit: commit,
      head: HEAD,
      acted: false,
    });
    expect(writes(await state())).toEqual([]);
  });

  it('refuses a pull request merged at another head, naming both, with no PUT', async () => {
    const { runner, state } = await fake({
      pulls: pull(9, {
        state: 'closed',
        merged: true,
        head_sha: OTHER,
        merge_commit_sha: 'd'.repeat(40),
      }),
    });
    const result = await outcome(runner, 'elsewhere', (ctx) =>
      client(ctx).pr.merge('merge', { number: 9, sha: HEAD }),
    );
    expect(String(result.error)).toContain(
      `pull request #9 is merged at head ${OTHER}, not ${HEAD}`,
    );
    expect(writes(await state())).toEqual([]);
  });

  it('returns closed for a pull request closed without merging, with no PUT', async () => {
    const { runner, state } = await fake({ pulls: pull(9, { state: 'closed' }) });
    const result = await outcome(runner, 'closed', (ctx) =>
      client(ctx).pr.merge('merge', { number: 9, sha: HEAD }),
    );
    expect(result.output).toEqual({
      merged: false,
      number: 9,
      reason: 'closed',
      head: HEAD,
      message: null,
    });
    expect(writes(await state())).toEqual([]);
  });

  it('returns not-mergeable with GitHub message on a 405', async () => {
    const { runner, state } = await fake({ pulls: pull(9, { mergeable: false }) });
    const result = await outcome(runner, 'blocked', (ctx) =>
      client(ctx).pr.merge('merge', { number: 9, sha: HEAD }),
    );
    expect(result.output).toEqual({
      merged: false,
      number: 9,
      reason: 'not-mergeable',
      head: HEAD,
      message: 'Pull Request is not mergeable',
    });
    expect(writes(await state())).toEqual(['PUT pulls/9/merge']);
  });

  it('throws GitHub message for a 403 and for an error body without status', async () => {
    for (const [runId, error, pattern] of [
      [
        'forbidden',
        { message: 'Resource not accessible by integration', status: '403' },
        /refused to merge #9 \(HTTP 403\): Resource not accessible by integration/u,
      ],
      [
        'unknown',
        { message: 'Something went wrong' },
        /refused to merge #9: Something went wrong/u,
      ],
    ] as const) {
      const { runner, state } = await fake({ pulls: pull(9), mergeError: error });
      const result = await outcome(runner, runId, (ctx) =>
        client(ctx).pr.merge('merge', { number: 9, sha: HEAD }),
      );
      expect(String(result.error), runId).toMatch(pattern);
      const after = await state();
      expect(putCalls(after.calls), runId).toHaveLength(1);
      expect(after.pulls['9']?.merged, runId).toBe(false);
    }
  });

  it('merges with the method given and confirms it with one read', async () => {
    const { runner, state } = await fake({ pulls: pull(9) });
    const result = await outcome(runner, 'rebase', (ctx) =>
      client(ctx).pr.merge('merge', { number: 9, sha: HEAD, method: 'rebase' }),
    );
    expect(result.output).toEqual({
      merged: true,
      number: 9,
      mergeCommit: MERGE_COMMIT_9,
      head: HEAD,
      acted: true,
    });
    const after = await state();
    expect(after.pulls['9']?.merge_method).toBe('rebase');
    // Read, PUT, one confirming read.
    expect(after.calls).toHaveLength(3);
  });

  it('keeps reading until GitHub reports the merge, and throws when it never does', async () => {
    const sleep = vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const { runner, state } = await fake({ pulls: pull(9), mergeLag: 2 });
    const lagged = await outcome(runner, 'lag', (ctx) =>
      fastWrites(ctx, sleep).pr.merge('merge', { number: 9, sha: HEAD }),
    );
    expect(lagged.output).toMatchObject({ merged: true, mergeCommit: MERGE_COMMIT_9, acted: true });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([CONFIRM_DELAY_MS, CONFIRM_DELAY_MS]);
    expect(putCalls((await state()).calls)).toHaveLength(1);

    sleep.mockClear();
    const never = await fake({ pulls: pull(9), mergeLag: CONFIRM_ATTEMPTS });
    const exhausted = await outcome(never.runner, 'never', (ctx) =>
      fastWrites(ctx, sleep).pr.merge('merge', { number: 9, sha: HEAD }),
    );
    expect(String(exhausted.error)).toMatch(/did not report merged after 20 reads/u);
    expect(sleep).toHaveBeenCalledTimes(CONFIRM_ATTEMPTS - 1);
  });

  it('never runs gh pr merge, auto-merge or a queue, and always pins sha in argv', async () => {
    const sleep = (): Promise<void> => Promise.resolve();
    const scenarios: readonly {
      readonly name: string;
      readonly seed: Partial<FakeState>;
      readonly method?: 'squash' | 'merge' | 'rebase';
      readonly lagged?: boolean;
    }[] = [
      { name: 'success', seed: { pulls: pull(9) } },
      { name: 'merge-method', seed: { pulls: pull(9) }, method: 'merge' },
      {
        name: 'merged',
        seed: {
          pulls: pull(9, { state: 'closed', merged: true, merge_commit_sha: 'd'.repeat(40) }),
        },
      },
      { name: 'moved', seed: { pulls: pull(9, { head_sha: OTHER }) } },
      { name: 'not-mergeable', seed: { pulls: pull(9, { mergeable: false }) } },
      { name: 'conflict', seed: { pulls: pull(9), pushBeforeMerge: OTHER } },
      { name: 'crash', seed: { pulls: pull(9), crashAfterCommit: 'PUT pulls/9/merge' } },
      { name: 'lag', seed: { pulls: pull(9), mergeLag: 1 }, lagged: true },
    ];
    const calls: FakeCall[] = [];
    for (const scenario of scenarios) {
      const { runner, state } = await fake(scenario.seed);
      const method = scenario.method ?? 'squash';
      const result = await outcome(runner, scenario.name, (ctx) => {
        const args = { number: 9, sha: HEAD, ...(scenario.method === undefined ? {} : { method }) };
        const policy = { retry: { maxAttempts: 2, delayMs: 1 } };
        return scenario.lagged === true
          ? fastWrites(ctx, sleep).pr.merge('merge', args, policy)
          : client(ctx).pr.merge('merge', args, policy);
      });
      expect(result.error, scenario.name).toBeUndefined();
      const logged = (await state()).calls;
      for (const call of putCalls(logged))
        expect(call.argv, scenario.name).toEqual([
          'gh',
          'api',
          '-X',
          'PUT',
          `repos/${REPO}/pulls/9/merge`,
          '-f',
          `merge_method=${method}`,
          '-f',
          `sha=${HEAD}`,
        ]);
      calls.push(...logged);
    }
    // Six scenarios reach the PUT, each exactly once.
    expect(putCalls(calls)).toHaveLength(6);
    for (const call of calls) {
      expect(call.argv.slice(0, 2)).toEqual(['gh', 'api']);
      expect(call.argv.some((arg, index) => arg === 'pr' && call.argv[index + 1] === 'merge')).toBe(
        false,
      );
      for (const arg of call.argv) expect(arg).not.toMatch(/--auto|auto-merge|queue/iu);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// pr.edit (a5)

describe('pr.edit', () => {
  it('refuses a moved head or a closed pull request without a PATCH', async () => {
    const { runner, state } = await fake({
      pulls: {
        ...pull(7, { head_sha: OTHER }),
        ...pull(8, { state: 'closed' }),
        ...pull(9, { state: 'closed', merged: true, merge_commit_sha: 'd'.repeat(40) }),
      },
    });
    const result = await outcome(runner, 'refused', async (ctx) => {
      const gh = client(ctx);
      return [
        await gh.pr.edit('moved', { number: 7, expectHead: HEAD, title: 'New' }),
        await gh.pr.edit('closed', { number: 8, expectHead: HEAD, body: 'New.' }),
        await gh.pr.edit('merged', { number: 9, expectHead: HEAD, base: 'release' }),
      ];
    });
    expect(result.output).toEqual([
      { number: 7, edited: false, reason: 'head-moved', head: OTHER, changed: [] },
      { number: 8, edited: false, reason: 'closed', head: HEAD, changed: [] },
      { number: 9, edited: false, reason: 'closed', head: HEAD, changed: [] },
    ]);
    const after = await state();
    expect(writes(after)).toEqual([]);
    expect(after.pulls['7']?.title).toBe('Feature');
  });

  it('patches only the fields that differ, on stdin, and nothing when none differs', async () => {
    const { runner, state } = await fake({ pulls: pull(9) });
    const result = await outcome(runner, 'patch', async (ctx) => {
      const gh = client(ctx);
      return [
        await gh.pr.edit('edit', {
          number: 9,
          expectHead: HEAD,
          title: 'Title 5e1f',
          body: 'Seeded.',
          base: 'release',
        }),
        await gh.pr.edit('same', { number: 9, expectHead: HEAD, title: 'Title 5e1f' }),
      ];
    });
    expect(result.output).toEqual([
      { number: 9, edited: true, reason: null, head: HEAD, changed: ['title', 'base'] },
      { number: 9, edited: false, reason: null, head: HEAD, changed: [] },
    ]);
    const after = await state();
    expect(writes(after)).toEqual(['PATCH pulls/9']);
    const patch = after.calls.find((call) => route(call) === 'PATCH pulls/9');
    expect(JSON.parse(patch?.stdin ?? '')).toEqual({ title: 'Title 5e1f', base: 'release' });
    expect(patch?.argv.slice(-2)).toEqual(['--input', '-']);
    expect(patch?.argv.join(' ')).not.toContain('5e1f');
    expect(after.pulls['9']).toMatchObject({
      title: 'Title 5e1f',
      base: 'release',
      body: 'Seeded.',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// pr.create (a3)

describe('pr.create', () => {
  it('returns an open pull request for the head and base, whoever opened it, with no POST', async () => {
    const { runner, state } = await fake({ pulls: pull(4, { body: 'Opened by a person.' }) });
    const result = await outcome(runner, 'open', (ctx) =>
      client(ctx).pr.create('create', { head: 'feature', base: 'main', title: 'T', body: 'B.' }),
    );
    expect(result.output).toEqual({
      number: 4,
      url: `https://github.com/${REPO}/pull/4`,
      nodeId: 'PR_4',
      state: 'open',
      created: false,
    });
    expect(writes(await state())).toEqual([]);
  });

  it('returns a closed or merged pull request carrying its marker, with no POST', async () => {
    for (const [runId, overrides, expected] of [
      ['closed', { state: 'closed' }, 'closed'],
      ['merged', { state: 'closed', merged: true, merge_commit_sha: 'd'.repeat(40) }, 'merged'],
    ] as const) {
      const { runner, state } = await fake({
        pulls: pull(4, { ...overrides, body: `Earlier.\n\n${githubMarker(`${runId}/create`)}` }),
      });
      const result = await outcome(runner, runId, (ctx) =>
        client(ctx).pr.create('create', { head: 'feature', base: 'main', title: 'T', body: 'B.' }),
      );
      expect(result.output, runId).toMatchObject({ number: 4, state: expected, created: false });
      expect(writes(await state()), runId).toEqual([]);
    }
  });

  it('returns the marked pull request retargeted to another base, with no POST', async () => {
    const { runner, state } = await fake({
      pulls: pull(4, { base: 'release', body: `Earlier.\n\n${githubMarker('moved/create')}` }),
    });
    const result = await outcome(runner, 'moved', (ctx) =>
      client(ctx).pr.create('create', { head: 'feature', base: 'main', title: 'T', body: 'B.' }),
    );
    expect(result.output).toMatchObject({ number: 4, state: 'open', created: false });
    const after = await state();
    expect(writes(after)).toEqual([]);
    expect(after.calls[0]?.argv.join(' ')).not.toContain('base=');
  });

  it('creates with the marker on stdin when only other bases or closed unmarked ones exist', async () => {
    const head = 'fix/a#b&c+d';
    const { runner, state } = await fake({
      pulls: {
        ...pull(4, { head, base: 'release' }),
        ...pull(5, { head, state: 'closed' }),
        ...pull(6, { head: 'other' }),
      },
      branches: { [head]: OTHER },
    });
    const result = await outcome(runner, 'new', (ctx) =>
      client(ctx).pr.create('create', {
        head,
        base: 'main',
        title: 'Title 3c9a',
        body: 'Body 3c9a.',
        draft: true,
      }),
    );
    expect(result.output).toEqual({
      number: 7,
      url: `https://github.com/${REPO}/pull/7`,
      nodeId: 'PR_7',
      state: 'open',
      created: true,
    });
    const after = await state();
    expect(writes(after)).toEqual(['POST pulls']);
    // The owner-qualified head is URL-encoded and there is no base filter: no injected parameter.
    expect(after.calls[0]?.argv).toEqual([
      'gh',
      'api',
      '--paginate',
      `repos/${REPO}/pulls?head=octo-org%3Afix%2Fa%23b%26c%2Bd&state=all&per_page=100`,
    ]);
    const post = after.calls[1];
    expect(post?.argv.join(' ')).not.toContain('3c9a');
    expect(JSON.parse(post?.stdin ?? '')).toEqual({
      title: 'Title 3c9a',
      head,
      base: 'main',
      body: `Body 3c9a.\n\n${githubMarker('new/create')}`,
      draft: true,
    });
    expect(after.pulls['7']).toMatchObject({ head, head_sha: OTHER, draft: true });
  });
});

// ---------------------------------------------------------------------------------------------
// checks.rerunFailed (a6)

describe('checks.rerunFailed', () => {
  const runs = {
    ...run(101, { name: 'CI' }),
    ...run(102, { name: 'CodeQL', run_attempt: 2 }),
    ...run(103, { name: 'Review', conclusion: 'success' }),
    ...run(104, { name: 'Pages', status: 'in_progress', conclusion: null }),
    ...run(105, { name: 'Other', head_sha: OTHER }),
  };

  it('reruns only failed runs at or below the baseline and skips those past it', async () => {
    const { runner, state } = await fake({ runs });
    const result = await outcome(runner, 'baseline', (ctx) =>
      client(ctx).checks.rerunFailed('rerun', { sha: HEAD }),
    );
    expect(result.output).toEqual({
      rerun: [{ id: 101, name: 'CI', attempt: 1 }],
      skipped: [{ id: 102, name: 'CodeQL', attempt: 2 }],
      confirmed: true,
    });
    const after = await state();
    expect(writes(after)).toEqual(['POST actions/runs/101/rerun-failed-jobs']);
    expect(after.runs['102']).toEqual(runs['102']);
    expect(after.runs['105']).toEqual(runs['105']);
    // List, rerun, one confirming list.
    expect(after.calls).toHaveLength(3);
  });

  it('reruns the runs at a second round baseline', async () => {
    const { runner, state } = await fake({ runs });
    const result = await outcome(runner, 'round-2', (ctx) =>
      client(ctx).checks.rerunFailed('rerun', { sha: HEAD, attempt: 2 }),
    );
    expect(result.output).toMatchObject({
      rerun: [
        { id: 102, name: 'CodeQL', attempt: 2 },
        { id: 101, name: 'CI', attempt: 1 },
      ],
      skipped: [],
      confirmed: true,
    });
    expect(writes(await state())).toEqual([
      'POST actions/runs/102/rerun-failed-jobs',
      'POST actions/runs/101/rerun-failed-jobs',
    ]);
  });

  it('throws IncompleteCollectionError when the list holds fewer runs than total_count', async () => {
    const { runner, state } = await fake({ runs, runsTotalCount: 150 });
    const result = await outcome(runner, 'partial', (ctx) =>
      client(ctx).checks.rerunFailed('rerun', { sha: HEAD }),
    );
    expect(result.error).toBeInstanceOf(Error);
    const cause = (result.error as Error).cause;
    expect(cause).toBeInstanceOf(IncompleteCollectionError);
    expect(cause).toMatchObject({ connection: 'actions.workflowRuns', stepId: 'rerun' });
    expect(writes(await state())).toEqual([]);
  });

  it('counts distinct runs, so a repeated page-boundary row cannot hide an omitted run', async () => {
    // Run 101 repeats across the pages and run 102 is absent: three rows, but two distinct runs of 3.
    const { runner, state } = await fake({
      runs: { ...run(101), ...run(102), ...run(103) },
      runsTotalCount: 3,
      runsPages: [[103, 101], [101]],
    });
    const result = await outcome(runner, 'duplicate-boundary', (ctx) =>
      client(ctx).checks.rerunFailed('rerun', { sha: HEAD }),
    );
    const cause = (result.error as Error).cause;
    expect(cause).toBeInstanceOf(IncompleteCollectionError);
    expect(cause).toMatchObject({ connection: 'actions.workflowRuns', stepId: 'rerun' });
    expect(writes(await state())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Arguments, requests and labels

describe('arguments and requests', () => {
  it('throw on invalid arguments before the step opens', async () => {
    const { runner, state } = await fake();
    const as = (value: unknown): never => value as never;
    const attempts: Record<string, (gh: GithubClient) => Promise<unknown>> = {
      'create fork head': (gh) =>
        gh.pr.create('w', { head: 'someone:feature', base: 'main', title: 't', body: 'b' }),
      'create base': (gh) => gh.pr.create('w', { head: 'f', base: '', title: 't', body: 'b' }),
      'create NUL title': (gh) =>
        gh.pr.create('w', { head: 'f', base: 'main', title: 'a\0', body: 'b' }),
      'create draft': (gh) =>
        gh.pr.create('w', { head: 'f', base: 'main', title: 't', body: 'b', draft: as('yes') }),
      'create length': (gh) =>
        gh.pr.create('w', { head: 'f', base: 'main', title: 't', body: 'x'.repeat(65_537) }),
      'edit nothing': (gh) => gh.pr.edit('w', { number: 9, expectHead: HEAD }),
      'edit short head': (gh) => gh.pr.edit('w', { number: 9, expectHead: 'abc1234', title: 't' }),
      'edit number': (gh) => gh.pr.edit('w', { number: 0, expectHead: HEAD, title: 't' }),
      'edit base': (gh) => gh.pr.edit('w', { number: 9, expectHead: HEAD, base: 'a:b' }),
      'merge sha': (gh) => gh.pr.merge('w', { number: 9, sha: HEAD.toUpperCase() }),
      'merge method': (gh) =>
        gh.pr.merge('w', { number: 9, sha: HEAD, method: as('fast-forward') }),
      'rerun sha': (gh) => gh.checks.rerunFailed('w', { sha: 'main' }),
      'rerun attempt': (gh) => gh.checks.rerunFailed('w', { sha: HEAD, attempt: 0 }),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      const runId = name.replace(/[^a-z]/gu, '-');
      const result = await outcome(runner, runId, (ctx) => attempt(client(ctx)));
      expect(result.error, name).toBeInstanceOf(Error);
      expect(
        (await readRun({ stateDir: join(cwd(), 'state'), runId })).steps,
        `${name} opened no step`,
      ).toEqual({});
    }
    expect((await state()).calls).toEqual([]);
  });

  it('puts --hostname after api in every command and labels each step', async () => {
    const { runner, state } = await fake({ pulls: pull(9), runs: run(101) });
    const result = await runWorkflow(
      definition(async (ctx) => {
        const gh = client(ctx, `enterprise.test/${REPO}`);
        await gh.pr.create('create', { head: 'topic', base: 'main', title: 'T', body: 'B.' });
        await gh.pr.edit('edit', { number: 9, expectHead: HEAD, title: 'New' });
        await gh.checks.rerunFailed('rerun', { sha: HEAD });
        await gh.pr.merge('merge', { number: 9, sha: HEAD });
        return null;
      }),
      { ...setup('enterprise'), processRunner: runner },
    );
    const after = await state();
    expect(writes(after)).toEqual([
      'POST pulls',
      'PATCH pulls/9',
      'POST actions/runs/101/rerun-failed-jobs',
      'PUT pulls/9/merge',
    ]);
    for (const call of after.calls) {
      expect(call.argv.slice(0, 4)).toEqual(['gh', 'api', '--hostname', 'enterprise.test']);
      expect(call.argv.indexOf('--hostname')).toBe(call.argv.lastIndexOf('--hostname'));
    }
    expect(
      Object.fromEntries(Object.entries(result.steps).map(([id, step]) => [id, step.meta])),
    ).toEqual({
      create: { integration: 'github', op: 'pr.create' },
      edit: { integration: 'github', op: 'pr.edit' },
      rerun: { integration: 'github', op: 'checks.rerunFailed' },
      merge: { integration: 'github', op: 'pr.merge' },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Pure rules

describe('pure rules', () => {
  const view = (
    overrides: Partial<{ state: 'open' | 'closed'; merged: boolean; sha: string }>,
  ) => ({
    state: overrides.state ?? ('open' as const),
    merged: overrides.merged ?? false,
    head: { ref: 'feature', sha: overrides.sha ?? HEAD },
  });

  it('decide the merge from the read', () => {
    const table: readonly (readonly [ReturnType<typeof view>, ReturnType<typeof mergePrecheck>])[] =
      [
        [view({}), 'put'],
        [view({ sha: OTHER }), 'head-moved'],
        [view({ state: 'closed' }), 'closed'],
        [view({ state: 'closed', sha: OTHER }), 'closed'],
        [view({ state: 'closed', merged: true }), 'merged'],
        [view({ state: 'closed', merged: true, sha: OTHER }), 'merged-elsewhere'],
      ];
    for (const [pullRead, expected] of table) expect(mergePrecheck(pullRead, HEAD)).toBe(expected);
  });

  it('classify a refused PUT from the re-read first, then the status', () => {
    expect(mergeFailure({ status: '405' }, view({ merged: true, state: 'closed' }), HEAD)).toBe(
      'merged',
    );
    expect(mergeFailure({ status: '405' }, view({ merged: true, sha: OTHER }), HEAD)).toBe(
      'merged-elsewhere',
    );
    expect(mergeFailure({ status: '405' }, view({ state: 'closed' }), HEAD)).toBe('closed');
    expect(mergeFailure({}, view({ sha: OTHER }), HEAD)).toBe('head-moved');
    expect(mergeFailure({ status: '409' }, view({}), HEAD)).toBe('head-moved');
    expect(mergeFailure({ status: 409 }, view({}), HEAD)).toBe('head-moved');
    expect(mergeFailure({ status: '405' }, view({}), HEAD)).toBe('not-mergeable');
    for (const status of ['403', '404', '422', undefined])
      expect(mergeFailure({ status }, view({}), HEAD)).toBe('unknown');
  });

  it('decide a create: marked in any state first, then open, else create', () => {
    const key = 'run/create';
    const main = { ref: 'main' };
    const marked = { state: 'closed', body: `x\n\n${githubMarker(key)}`, base: main };
    const open = { state: 'open', body: null, base: main };
    const closed = { state: 'closed', body: 'y', base: main };
    expect(createDecision([open, marked], key, 'main')).toEqual({
      kind: 'found-marked',
      row: marked,
    });
    expect(createDecision([closed, open], key, 'main')).toEqual({ kind: 'found-open', row: open });
    expect(createDecision([closed], key, 'main')).toEqual({ kind: 'create' });
    expect(createDecision([], key, 'main')).toEqual({ kind: 'create' });
    // A marked pull request retargeted since the POST still wins, in any state.
    const retargeted = { state: 'open', body: `x\n\n${githubMarker(key)}`, base: { ref: 'next' } };
    expect(createDecision([open, retargeted], key, 'main')).toEqual({
      kind: 'found-marked',
      row: retargeted,
    });
    expect(createDecision([{ ...retargeted, state: 'closed' }], key, 'main')).toMatchObject({
      kind: 'found-marked',
    });
    // An unmarked open pull request into another base is not this step's.
    const elsewhere = { state: 'open', body: null, base: { ref: 'release' } };
    expect(createDecision([elsewhere, closed], key, 'main')).toEqual({ kind: 'create' });
    expect(createDecision([elsewhere, open], key, 'main')).toEqual({
      kind: 'found-open',
      row: open,
    });
    expect(pullListState({ state: 'closed', merged_at: '2026-10-03T00:00:00Z' })).toBe('merged');
    expect(pullListState({ state: 'closed', merged_at: null })).toBe('closed');
    expect(pullState({ state: 'closed', merged: true })).toBe('merged');
    expect(pullState({ state: 'open', merged: false })).toBe('open');
  });

  it('compute an edit patch from the fields that differ', () => {
    const current = { title: 'T', body: null, base: { ref: 'main' } };
    expect(editChanges(current, { title: 'T', body: null, base: null })).toEqual({
      changed: [],
      patch: {},
    });
    expect(editChanges(current, { title: 'U', body: 'B', base: 'main' })).toEqual({
      changed: ['title', 'body'],
      patch: { title: 'U', body: 'B' },
    });
    expect(editChanges(current, { title: null, body: null, base: 'release' })).toEqual({
      changed: ['base'],
      patch: { base: 'release' },
    });
  });

  it('select reruns by the baseline: in-progress and successful runs never', () => {
    const row = (id: number, overrides: Partial<WorkflowRunRow>): WorkflowRunRow => ({
      id,
      name: `W${String(id)}`,
      status: 'completed',
      conclusion: 'failure',
      run_attempt: 1,
      ...overrides,
    });
    const rows = [
      row(1, {}),
      row(2, { run_attempt: 2 }),
      row(3, { conclusion: 'success' }),
      row(4, { status: 'in_progress', conclusion: null }),
      row(5, { status: 'queued', conclusion: null, run_attempt: 2 }),
      row(6, { conclusion: 'cancelled' }),
      row(7, { conclusion: 'success', run_attempt: 3 }),
    ];
    const ids = (selection: ReturnType<typeof rerunSelection>) => ({
      rerun: selection.rerun.map((entry) => entry.id),
      skipped: selection.skipped.map((entry) => entry.id),
    });
    expect(ids(rerunSelection(rows, 1))).toEqual({ rerun: [1], skipped: [2, 5] });
    expect(ids(rerunSelection(rows, 2))).toEqual({ rerun: [1, 2], skipped: [] });
    expect(ids(rerunSelection(rows, 3))).toEqual({ rerun: [1, 2], skipped: [] });
    expect(
      rerunConfirmed(
        [row(1, { status: 'queued', conclusion: null, run_attempt: 2 })],
        [{ id: 1, name: 'W1', attempt: 1 }],
      ),
    ).toBe(true);
    expect(rerunConfirmed([row(1, { run_attempt: 2 })], [{ id: 1, name: 'W1', attempt: 1 }])).toBe(
      true,
    );
    expect(rerunConfirmed([row(1, {})], [{ id: 1, name: 'W1', attempt: 1 }])).toBe(false);
    expect(rerunConfirmed([], [{ id: 1, name: 'W1', attempt: 1 }])).toBe(false);
    expect(rerunConfirmed([], [])).toBe(true);
    expect(
      uniqueRuns([
        { workflow_runs: [row(1, {}), row(2, {})] },
        { workflow_runs: [row(2, {})] },
      ]).map((entry) => entry.id),
    ).toEqual([1, 2]);
  });

  it('confirm reads until done, sleeping between reads, and reports exhaustion', async () => {
    const signal = new AbortController().signal;
    const sleep = vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(() =>
      Promise.resolve(),
    );
    let reads = 0;
    const lagged = await confirm(
      () => Promise.resolve(++reads),
      (value) => value === 3,
      { attempts: CONFIRM_ATTEMPTS, delayMs: CONFIRM_DELAY_MS, sleep, signal },
    );
    expect(lagged).toEqual({ done: true, last: 3 });
    expect(sleep.mock.calls).toEqual([
      [CONFIRM_DELAY_MS, signal],
      [CONFIRM_DELAY_MS, signal],
    ]);
    sleep.mockClear();
    reads = 0;
    const exhausted = await confirm(
      () => Promise.resolve(++reads),
      () => false,
      { attempts: CONFIRM_ATTEMPTS, delayMs: CONFIRM_DELAY_MS, sleep, signal },
    );
    expect(exhausted).toEqual({ done: false, last: CONFIRM_ATTEMPTS });
    expect(sleep).toHaveBeenCalledTimes(CONFIRM_ATTEMPTS - 1);
    await expect(
      confirm(
        () => Promise.reject(new Error('read failed')),
        () => true,
        {
          attempts: 2,
          delayMs: 1,
          sleep,
          signal,
        },
      ),
    ).rejects.toThrow('read failed');
    // The default sleep stops when the step is cancelled.
    await expect(signalSleep(60_000, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow(
      'cancelled',
    );
    await expect(signalSleep(1, signal)).resolves.toBeUndefined();
  });

  it('builds the merge and list argv', () => {
    const repo = parseGithubRepo(REPO);
    expect(mergeArgv(repo, 9, 'squash', HEAD)).toEqual([
      'gh',
      'api',
      '-X',
      'PUT',
      `repos/${REPO}/pulls/9/merge`,
      '-f',
      'merge_method=squash',
      '-f',
      `sha=${HEAD}`,
    ]);
    expect(pullListArgv(repo, 'a&base=x')[3]).toBe(
      `repos/${REPO}/pulls?head=octo-org%3Aa%26base%3Dx&state=all&per_page=100`,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Response schemas against GitHub-shaped fixtures

describe('response schemas', () => {
  const fixture = (name: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(join(repository, 'test', 'fixtures', 'github', name), 'utf8'),
    ) as Record<string, unknown>;
  const responses = fixture('write-responses.json');

  it('accept the recorded pull request reads and keep only what the writes use', () => {
    const pulls = fixture('pull.json');
    expect(pullResponseSchema.parse(pulls['view'])).toEqual({
      number: 354,
      html_url: 'https://github.com/octo-org/quiet-choir/pull/354',
      node_id: 'PR_kwDOTxycVs8AAAABGczJ7w',
      state: 'closed',
      merged: true,
      merge_commit_sha: 'c25ef328d16d1022655ea42e8dc48afec55c816c',
      title: 'Add reconciled GitHub writes: comments, threads, issues, alerts',
      body: 'Closes #161.\n\nPart of #99.\n\n<!-- quiet-choir:land/open-pr -->',
      head: {
        ref: 'epic-99/161-quiet-choir-github-slice-c1-reconciled',
        sha: '89e3c4cb26fa1bb2b96fb42c38806dd43ebd492c',
      },
      base: { ref: 'main' },
    });
    const [row] = pullListResponseSchema.parse(pulls['list']);
    expect(row).toEqual({
      number: 354,
      html_url: 'https://github.com/octo-org/quiet-choir/pull/354',
      node_id: 'PR_kwDOTxycVs8AAAABGczJ7w',
      state: 'closed',
      merged_at: '2026-10-03T16:49:05Z',
      body: 'Closes #161.\n\nPart of #99.\n\n<!-- quiet-choir:land/open-pr -->',
      base: { ref: 'main' },
    });
    expect(row && pullListState(row)).toBe('merged');
    expect(
      createDecision(pullListResponseSchema.parse(pulls['list']), 'land/open-pr', 'main'),
    ).toMatchObject({ kind: 'found-marked' });
  });

  it('accept the recorded workflow runs and fail a list shorter than total_count', () => {
    const pages = fixture('actions-runs.json')['pages'];
    const runs = uniqueRuns(runsListResponseSchema.parse(pages));
    expect(
      runs.map((entry) => [entry.name, entry.status, entry.conclusion, entry.run_attempt]),
    ).toEqual([
      ['Dependency Review', 'completed', 'success', 1],
      ['CodeQL', 'completed', 'success', 1],
      ['CI', 'completed', 'success', 1],
    ]);
    expect(Object.keys(runs[0] ?? {}).sort()).toEqual([
      'conclusion',
      'id',
      'name',
      'run_attempt',
      'status',
    ]);
    const truncated = structuredClone(pages) as { total_count: number }[];
    if (truncated[0]) truncated[0].total_count = 120;
    const parsed = runsListResponseSchema.safeParse(truncated);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('incompleteCollection');
  });

  it('count distinct workflow runs, not rows, against total_count', () => {
    const row = (id: number) => ({
      id,
      name: 'W',
      status: 'completed',
      conclusion: 'failure',
      run_attempt: 1,
    });
    const pages = [
      { total_count: 3, workflow_runs: [row(3), row(1)] },
      { total_count: 3, workflow_runs: [row(1)] },
    ];
    const parsed = runsListResponseSchema.safeParse(pages);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('incompleteCollection');
    // The same rows with the omitted run present pass, repeats included.
    expect(
      runsListResponseSchema.safeParse([
        { total_count: 3, workflow_runs: [row(3), row(1)] },
        { total_count: 3, workflow_runs: [row(1), row(2)] },
      ]).success,
    ).toBe(true);
  });

  it('accept the documented write responses', () => {
    expect(pullPostResponseSchema.parse(responses['pullPost'])).toEqual({
      number: 15,
      html_url: 'https://github.com/octo-org/quiet-choir/pull/15',
      node_id: 'PR_kwDOPexample',
    });
    expect(pullPatchResponseSchema.parse(responses['pullPatch'])).toEqual({ number: 15 });
    expect(mergeResponseSchema.parse(responses['mergeSuccess'])).toEqual({
      merged: true,
      sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e',
      message: 'Pull Request successfully merged',
    });
    expect(mergeResponseSchema.parse(responses['mergeNotMergeable'])).toEqual({
      message: 'Pull Request is not mergeable',
      status: '405',
    });
    expect(mergeResponseSchema.parse(responses['mergeHeadModified'])).toEqual({
      message: 'Head branch was modified. Review and try the merge again.',
      status: '409',
    });
    expect(responses['rerunFailedJobs']).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// The guarantees table (a7)

describe('docs/github.md guarantees table', () => {
  it('starts every op row with its class', () => {
    const docs = readFileSync(join(repository, 'docs', 'github.md'), 'utf8');
    const section = docs.slice(docs.indexOf('### Guarantees'), docs.indexOf('### Pull requests'));
    const rows = new Map(
      section
        .split('\n')
        .filter((line) => line.startsWith('| `'))
        .map((line) => {
          const [, op = '', guarantee = ''] = line.split('|').map((cell) => cell.trim());
          return [op, guarantee] as const;
        }),
    );
    expect([...rows.keys()]).toEqual([
      '`comment`',
      '`thread.reply`',
      '`issue.create`',
      '`issue.close`, `issue.reopen`',
      '`alert.dismiss`',
      '`pr.create`',
      '`pr.edit`',
      '`pr.merge`',
      '`checks.rerunFailed`',
    ]);
    for (const [op, guarantee] of rows)
      expect(guarantee, op).toMatch(
        /^(?:Reconciled|Conditional \((?:check-then-act|atomic)\)|At-least-once)[\s:]/u,
      );
  });
});

// ---------------------------------------------------------------------------------------------
// Rehearsal (a9)

/** The commands a rehearsal listed, as `STEP METHOD PATH` with the query dropped. */
const rehearsed = (commands: RehearsedCommands): string[] =>
  commands.map((command) => {
    const argv = command.command as readonly string[];
    const method = argv.includes('-X') ? (argv[argv.indexOf('-X') + 1] ?? '?') : 'GET';
    const path = (argv.find((arg) => arg.startsWith('repos/')) ?? '').split('?')[0] ?? '';
    return `${command.stepId} ${method} ${path.replace(`repos/${REPO}/`, '')}`;
  });

// Each executor run type-checks and imports a workflow module. measured: 1.4 s alone (dominated by
// the loader's type check and tsImport compile), like the write dry-run in test/github-writes.test.ts.
describe('dry-run', { timeout: 30_000 }, () => {
  it('lists every op command under its step and spawns nothing', async () => {
    await project();
    const file = join(cwd(), 'pr-writes.workflow.ts');
    await writeFile(
      file,
      `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
import { github } from ${JSON.stringify(join(repository, 'src/integrations/github.js'))};
export default defineWorkflow({
  name: 'github-pr-writes', version: '1', input: z.object({ repo: z.string(), sha: z.string() }), output: z.unknown(),
  async run(ctx, { repo, sha }) {
    const gh = github(ctx, { repo });
    return {
      create: await gh.pr.create('create', { head: 'feature', base: 'main', title: 'T', body: 'B.' }),
      edit: await gh.pr.edit('edit', { number: 9, expectHead: sha, title: 'New' }),
      merge: await gh.pr.merge('merge', { number: 9, sha }),
      rerun: await gh.checks.rerunFailed('rerun', { sha }),
    };
  },
});
`,
    );
    const result = await rehearse(file, { repo: REPO, sha: HEAD });
    expect(result.run.status).toBe('completed');
    for (const command of result.commands)
      expect(command).toMatchObject({ parentStepId: command.stepId, outputSource: 'synthesized' });
    // A synthesized list row is closed and unmarked, so create posts; a synthesized head is never
    // sha, so edit and merge stop after their read; a synthesized run is not a completed failure.
    expect(rehearsed(result.commands)).toEqual([
      'create GET pulls',
      'create POST pulls',
      'edit GET pulls/9',
      'merge GET pulls/9',
      'rerun GET actions/runs',
    ]);
    expect(result.run.output).toMatchObject({
      create: { created: true, state: 'open' },
      edit: { edited: false, reason: 'head-moved' },
      merge: { merged: false, reason: 'head-moved' },
      rerun: { rerun: [], skipped: [], confirmed: true },
    });
  });

  it('rehearses the land example from docs/github.md', async () => {
    const docs = readFileSync(join(repository, 'docs', 'github.md'), 'utf8');
    const section = docs.slice(docs.indexOf('## Land example'));
    const snippet = /```ts\n([\s\S]*?)```/u.exec(section)?.[1];
    if (snippet === undefined) throw new Error('docs/github.md has no land example');
    await project();
    const file = join(cwd(), 'land.workflow.ts');
    await writeFile(file, imports(snippet));
    for (const [gate, expected, commands] of [
      ['land', 'restart', [`${stepId('merge', HEAD)} GET pulls/7`]],
      ['fix-ci', 'blocked', [`${stepId('rerun', HEAD, 1)} GET actions/runs`]],
    ] as const) {
      const result = await rehearse(file, { repo: REPO, pr: 7, sha: HEAD, gate, round: 1 }, gate);
      expect(result.run.output, gate).toBe(expected);
      expect(rehearsed(result.commands), gate).toEqual(commands);
    }
  });
});
