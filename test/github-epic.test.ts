import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ExecError,
  readRun,
  runWorkflow,
  type ExecResult,
  type ProcessRunner,
  type ProcessRunRequest,
} from '../src/index.js';
import {
  github,
  IncompleteCollectionError,
  nextTicket,
  outsideReferences,
  parseDependencies,
  parseEpicChecklist,
  parseGithubRepo,
  parseSplit,
  type GithubEpicSnapshot,
  type NextTicketOutsideIssue,
  type NextTicketPolicy,
  type NextTicketResult,
  type RawEpicSnapshotResponse,
  type RawEpicSubIssue,
} from '../src/integrations/github.js';
import {
  EPIC_SNAPSHOT_QUERY,
  epicSnapshotRead,
  mapEpicSnapshot,
} from '../src/integrations/github-epic-model.js';
import { definition, REPO, repository, useGithubFake, VIEWER } from './github-fake.js';

const { cwd, setup, rehearse, project } = useGithubFake('choir-github-epic-');

/** Recorded `gh` stdout from read-only probes of this repository, trimmed and scrubbed. */
const fixture = (name: string): string =>
  readFileSync(join(repository, 'test', 'fixtures', 'github', name), 'utf8');

/**
 * A fresh copy of the recorded epic #99 snapshot response: 16 of its sub-issues, among them the
 * split parents #121 (slices #184-#186) and #158 (#339-#341) with the viewer's split markers,
 * closed #109 with its outside "depends on #61", and open #163, #164, #167 and #168.
 */
const recordedEpic = (): RawEpicSnapshotResponse =>
  JSON.parse(fixture('epic-snapshot.json')) as RawEpicSnapshotResponse;

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
type RawEpic = Mutable<RawEpicSnapshotResponse>;
type RawNode = Mutable<RawEpicSubIssue>;

const epicOf = (raw: RawEpic) => raw.data.repository.issue;
/** The sub-issue `number` of a mutable copy. */
function node(raw: RawEpic, number: number): RawNode {
  const found = epicOf(raw).subIssues.nodes.find((entry) => entry.number === number);
  if (!found) throw new Error(`fixture has no sub-issue #${String(number)}`);
  return found;
}
const repo = parseGithubRepo(REPO);
/** Map a (mutated) copy of the recording, as the read does after validating it. */
const snapshotOf = (mutate: (raw: RawEpic) => void = () => undefined): GithubEpicSnapshot => {
  const raw = recordedEpic() as RawEpic;
  mutate(raw);
  return mapEpicSnapshot(repo, raw);
};
const pr = (number: number, state: string) => ({
  number,
  state,
  isDraft: state === 'OPEN',
  url: `https://github.com/${REPO}/pull/${String(number)}`,
  headRefName: `epic-99/${String(number)}-work`,
});
const close =
  (...numbers: number[]) =>
  (raw: RawEpic) => {
    for (const number of numbers) node(raw, number).state = 'CLOSED';
  };
const reopen =
  (...numbers: number[]) =>
  (raw: RawEpic) => {
    for (const number of numbers) node(raw, number).state = 'OPEN';
  };
const both =
  (...steps: ((raw: RawEpic) => void)[]) =>
  (raw: RawEpic) => {
    for (const step of steps) step(raw);
  };

// ---------------------------------------------------------------------------------------------
// A ProcessRunner that answers each read from recorded JSON.

/** The read an argv performs, recognized from its query. */
function readOf(argv: readonly string[]): string {
  const query = argv.find((arg) => arg.startsWith('query=')) ?? '';
  if (query.includes('subIssues(')) return 'epic.snapshot';
  if (query.includes('viewer {')) return 'repo.info';
  if (query.includes('comments(first: 100, after')) return 'issue.comments';
  if (query.includes('issue(number')) return 'issue.view';
  return 'unknown';
}

/** `issue.view` of `number`, from the recorded comments page without its comments. */
function issueView(number: number, state: string): string {
  const [page] = JSON.parse(fixture('issue-view-comments.json')) as [
    { data: { repository: { issue: Record<string, unknown> } } },
  ];
  const issue: Record<string, unknown> = { ...page.data.repository.issue, number, state };
  delete issue['comments'];
  return JSON.stringify({ data: { repository: { issue } } });
}
/** `issue.view` of `number` with comments, from the recorded comments page. */
function issueComments(number: number, title: string): string {
  const pages = JSON.parse(fixture('issue-view-comments.json')) as {
    data: { repository: { issue: Record<string, unknown> } };
  }[];
  for (const page of pages) Object.assign(page.data.repository.issue, { number, title });
  return JSON.stringify(pages);
}
const numberOf = (argv: readonly string[]): number =>
  Number(argv.find((arg) => arg.startsWith('number='))?.slice('number='.length));

function fakeGh(
  epic: () => string = () => fixture('epic-snapshot.json'),
  states: Readonly<Record<number, string>> = {},
) {
  const seen: { readonly argv: readonly string[]; readonly request: ProcessRunRequest }[] = [];
  const runner: ProcessRunner = {
    run: (request) => {
      const argv = request.command as readonly string[];
      seen.push({ argv, request });
      const read = readOf(argv);
      const number = numberOf(argv);
      const stdout =
        read === 'epic.snapshot'
          ? epic()
          : read === 'repo.info'
            ? fixture('repo-info.json')
            : read === 'issue.view'
              ? issueView(number, states[number] ?? 'OPEN')
              : read === 'issue.comments'
                ? issueComments(number, `Ticket #${String(number)}`)
                : undefined;
      if (stdout === undefined) throw new Error(`Unexpected command ${JSON.stringify(argv)}`);
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout,
        stderr: '',
        truncated: false,
        durationMs: 1,
      } satisfies ExecResult);
    },
  };
  return { seen, runner };
}

/** Run `gh.epic.snapshot('epic', { number: 99 })` and keep the error it throws. */
async function failingSnapshot(runner: ProcessRunner): Promise<unknown> {
  let thrown: unknown;
  await expect(
    runWorkflow(
      definition(async (ctx) => {
        try {
          return await github(ctx, { repo: REPO }).epic.snapshot('epic', { number: 99 });
        } catch (error) {
          thrown = error;
          throw error;
        }
      }),
      { ...setup('epic'), processRunner: runner },
    ),
  ).rejects.toThrow();
  return thrown;
}

// ---------------------------------------------------------------------------------------------
// The read

describe('gh.epic.snapshot', () => {
  it('maps the recorded epic from exactly one labelled gh api graphql exec', async () => {
    const { seen, runner } = fakeGh();
    const run = await runWorkflow(
      definition((ctx) => github(ctx, { repo: REPO }).epic.snapshot('epic', { number: 99 })),
      { ...setup('epic'), processRunner: runner },
    );
    expect(seen).toHaveLength(1);
    const argv = seen[0]?.argv ?? [];
    expect(argv).toEqual([
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${EPIC_SNAPSHOT_QUERY}`,
      '-f',
      'owner=octo-org',
      '-f',
      'name=quiet-choir',
      '-F',
      'number=99',
    ]);
    expect(argv).toEqual(epicSnapshotRead(repo, 99).argv);
    // No environment overlay or stdin; the 8 MiB default output cap reaches the request.
    expect(seen[0]?.request).toMatchObject({
      env: {},
      input: '',
      inheritEnv: true,
      cwd: cwd(),
      maxOutputBytes: 8 * 1024 * 1024,
    });
    expect(run.steps['epic']?.meta).toEqual({ integration: 'github', op: 'epic.snapshot' });
    const snapshot = run.output as unknown as GithubEpicSnapshot;
    expect(snapshot).toMatchObject({
      repository: REPO,
      viewer: VIEWER,
      epic: { number: 99, state: 'OPEN', url: `https://github.com/${REPO}/issues/99` },
      source: 'sub-issues',
      total: 16,
    });
    // Checklist order: #121 and its slices first, as the epic body lists them.
    expect(snapshot.items.map((item) => item.number)).toEqual([
      121, 184, 185, 186, 131, 109, 156, 158, 339, 340, 341, 159, 163, 164, 167, 168,
    ]);
    expect(snapshot.checklist.every((line) => line.isItem)).toBe(true);
    expect(snapshot.items.find((item) => item.number === 121)).toMatchObject({
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      checked: true,
      split: [184, 185, 186],
      pullRequests: [],
    });
    expect(snapshot.items.find((item) => item.number === 109)).toMatchObject({
      dependsOn: [61],
      pullRequests: [expect.objectContaining({ number: 335, state: 'MERGED' })],
    });
    expect(snapshot.items.find((item) => item.number === 168)).toMatchObject({
      state: 'OPEN',
      checked: false,
      dependsOn: [156, 141],
      labels: ['enhancement'],
      blockedBy: [],
      split: null,
    });
    // Compact: no bodies or comments.
    expect(JSON.stringify(snapshot)).not.toContain('"body"');
  });

  it('lets the caller policy override the default output cap', async () => {
    const { seen, runner } = fakeGh();
    await runWorkflow(
      definition((ctx) =>
        github(ctx, { repo: REPO }).epic.snapshot(
          'epic',
          { number: 99 },
          { maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 1234 },
        ),
      ),
      { ...setup('epic'), processRunner: runner },
    );
    expect(seen[0]?.request).toMatchObject({ maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 1234 });
  });

  it('rejects an oversized response instead of shrinking it', async () => {
    const runner: ProcessRunner = {
      run: () =>
        Promise.resolve({
          code: 0,
          signal: null,
          stdout: '{',
          stderr: '',
          truncated: true,
          durationMs: 1,
        }),
    };
    const error = await failingSnapshot(runner);
    expect(error).toBeInstanceOf(ExecError);
    expect((error as ExecError).kind).toBe('output-limit');
  });

  it('rejects an invalid epic number before running gh', async () => {
    const { seen, runner } = fakeGh();
    await expect(
      runWorkflow(
        definition((ctx) => github(ctx, { repo: REPO }).epic.snapshot('epic', { number: 0 })),
        { ...setup('epic'), processRunner: runner },
      ),
    ).rejects.toThrow('epic.snapshot number must be a positive integer.');
    expect(seen).toEqual([]);
  });

  it('replays the completed snapshot after a resume without running gh', async () => {
    let fail = true;
    const workflow = definition(async (ctx) => {
      const snapshot = await github(ctx, { repo: REPO }).epic.snapshot('epic', { number: 99 });
      if (fail) throw new Error('Injected tail failure');
      return nextTicket(snapshot).pick?.number ?? null;
    });
    const first = fakeGh();
    await expect(
      runWorkflow(workflow, { ...setup('epic'), processRunner: first.runner }),
    ).rejects.toThrow('Injected tail failure');
    expect(first.seen).toHaveLength(1);
    fail = false;
    const second = fakeGh();
    const resumed = await runWorkflow(workflow, {
      ...setup('epic'),
      processRunner: second.runner,
      resume: true,
    });
    expect(second.seen).toEqual([]);
    expect(resumed.output).toBe(163);
  });
});

describe('gh.epic.snapshot complete-or-throw', () => {
  const truncate =
    (number: number, connection: keyof RawNode & `${string}${'s' | 'By' | 'References'}`) =>
    (raw: RawEpic) => {
      (node(raw, number)[connection] as { pageInfo: { hasNextPage: boolean } }).pageInfo = {
        hasNextPage: true,
      };
    };
  it.each<[string, (raw: RawEpic) => void, string]>([
    [
      'a truncated sub-issue page',
      (raw) => {
        epicOf(raw).subIssues.pageInfo.hasNextPage = true;
      },
      'epic.subIssues',
    ],
    ['truncated comments', truncate(121, 'comments'), 'epic.subIssues[121].comments'],
    ['truncated labels', truncate(163, 'labels'), 'epic.subIssues[163].labels'],
    ['truncated assignees', truncate(164, 'assignees'), 'epic.subIssues[164].assignees'],
    ['truncated blocked-by relations', truncate(168, 'blockedBy'), 'epic.subIssues[168].blockedBy'],
    [
      'truncated linked pull requests',
      truncate(109, 'closedByPullRequestsReferences'),
      'epic.subIssues[109].closedByPullRequestsReferences',
    ],
    [
      'fewer sub-issues listed than subIssuesSummary.total',
      (raw) => {
        epicOf(raw).subIssues.nodes.pop();
      },
      'epic.subIssues',
    ],
  ])(
    'throws IncompleteCollectionError for %s and never completes the read',
    async (_name, mutate, connection) => {
      const raw = recordedEpic() as RawEpic;
      mutate(raw);
      const { runner } = fakeGh(() => JSON.stringify(raw));
      const error = await failingSnapshot(runner);
      expect(error).toBeInstanceOf(IncompleteCollectionError);
      expect(error).toMatchObject({ connection, stepId: 'epic' });
      expect((error as IncompleteCollectionError).cause).toBeInstanceOf(ExecError);
      const record = await readRun(setup('epic'));
      expect(record.steps['epic']).toMatchObject({ status: 'failed', output: null });
      expect(record.rootCause).toMatchObject({ stepId: 'epic', errorKind: 'schema' });
    },
  );

  it('names both counts when fewer sub-issues are listed than GitHub counts', async () => {
    const raw = recordedEpic() as RawEpic;
    epicOf(raw).subIssuesSummary.total = 17;
    const error = await failingSnapshot(fakeGh(() => JSON.stringify(raw)).runner);
    expect(error).toBeInstanceOf(IncompleteCollectionError);
    expect(String((error as IncompleteCollectionError).cause)).toContain(
      'epic.subIssues lists 16 sub-issues but subIssuesSummary.total is 17.',
    );
  });

  it('accepts more sub-issues listed than counted: only a shortfall can hide an item', async () => {
    const raw = recordedEpic() as RawEpic;
    epicOf(raw).subIssuesSummary.total = 3;
    const { runner } = fakeGh(() => JSON.stringify(raw));
    const run = await runWorkflow(
      definition((ctx) => github(ctx, { repo: REPO }).epic.snapshot('epic', { number: 99 })),
      { ...setup('epic'), processRunner: runner },
    );
    expect((run.output as unknown as GithubEpicSnapshot).items).toHaveLength(16);
  });
});

describe('task-list fallback', () => {
  const body = [
    'Intro naming #5 outside any checklist.',
    '',
    '- [x] #10 Done already',
    '- [ ] `#11` is code; #12 is the real item',
    '* [ ] #13 Star bullet',
    '+ [X] #14 Plus bullet, capital X',
    '- [ ] other-org/other-repo#15 Another repository',
    '- [ ] See page#16, an anchor',
    '- [ ] OCTO-ORG/QUIET-CHOIR#17 Qualified, in any case',
    '- [ ] #99 The epic itself',
    '- [ ] #10 A duplicate: the first line wins',
    '```',
    '- [ ] #20 Inside a backtick fence',
    '```',
    '~~~md',
    '- [ ] #21 Inside a tilde fence',
    '~~~',
    '````',
    '- [ ] #22 Inside a longer fence',
    '```',
    '- [ ] #23 Still inside: that closing fence was shorter',
    '````',
    '```ts',
    '- [ ] #24 Inside a fence that never closes',
  ].join('\n');

  it('reads the checklist outside code when the epic has no sub-issues', async () => {
    const raw = recordedEpic() as RawEpic;
    Object.assign(epicOf(raw), {
      body,
      subIssuesSummary: { total: 0, completed: 0 },
      subIssues: { pageInfo: { hasNextPage: false }, nodes: [] },
    });
    const { seen, runner } = fakeGh(() => JSON.stringify(raw));
    const run = await runWorkflow(
      definition((ctx) => github(ctx, { repo: REPO }).epic.snapshot('epic', { number: 99 })),
      { ...setup('epic'), processRunner: runner },
    );
    expect(seen).toHaveLength(1);
    const snapshot = run.output as unknown as GithubEpicSnapshot;
    expect(snapshot).toMatchObject({ source: 'task-list', total: 5 });
    expect(snapshot.items.map(({ number, state, checked }) => [number, state, checked])).toEqual([
      [10, 'CLOSED', true],
      [12, 'OPEN', false],
      [13, 'OPEN', false],
      [14, 'CLOSED', true],
      [17, 'OPEN', false],
    ]);
    expect(snapshot.items[1]).toEqual({
      number: 12,
      title: 'is code; #12 is the real item',
      state: 'OPEN',
      stateReason: null,
      url: null,
      repository: REPO,
      labels: [],
      assignees: [],
      checked: false,
      dependsOn: [],
      blockedBy: [],
      pullRequests: [],
      split: null,
    });
    expect(nextTicket(snapshot)).toEqual({
      pick: {
        number: 12,
        title: 'is code; #12 is the real item',
        url: null,
        status: 'ready',
        pullRequests: [],
        openSlices: [],
      },
      skipped: [
        { number: 13, title: '#13 Star bullet', reason: 'ready' },
        { number: 17, title: 'OCTO-ORG/QUIET-CHOIR#17 Qualified, in any case', reason: 'ready' },
      ],
      done: false,
    });
  });

  it('reads the checklist after a fence opener indented four columns, which is indented code', () => {
    const snapshot = snapshotOf((raw) => {
      Object.assign(epicOf(raw), {
        body: 'Example:\n\n    ```\n- [ ] #12 The real item',
        subIssuesSummary: { total: 0, completed: 0 },
        subIssues: { pageInfo: { hasNextPage: false }, nodes: [] },
      });
    });
    expect(snapshot).toMatchObject({ source: 'task-list', total: 1 });
    expect(nextTicket(snapshot)).toMatchObject({
      pick: { number: 12, status: 'ready' },
      skipped: [],
      done: false,
    });
  });

  it('reports an epic with no checklist and no sub-issues as done', () => {
    const snapshot = snapshotOf((raw) => {
      Object.assign(epicOf(raw), {
        body: 'Nothing listed yet.',
        subIssuesSummary: { total: 0, completed: 0 },
        subIssues: { pageInfo: { hasNextPage: false }, nodes: [] },
      });
    });
    expect(snapshot).toMatchObject({ source: 'task-list', total: 0, items: [] });
    expect(nextTicket(snapshot)).toEqual({ pick: null, skipped: [], done: true });
  });
});

// ---------------------------------------------------------------------------------------------
// The selector

/** `[number, reason]` of every skipped item. */
const reasons = (result: NextTicketResult) =>
  result.skipped.map(({ number, reason }) => [number, reason]);

describe('nextTicket over the recorded #99 snapshot', () => {
  it('picks #163 as recorded and explains every other open item', () => {
    const snapshot = snapshotOf();
    expect(nextTicket(snapshot)).toEqual({
      pick: {
        number: 163,
        title: 'quiet-choir/github slice D: epic snapshot and a pure next-ticket selector',
        url: `https://github.com/${REPO}/issues/163`,
        status: 'ready',
        pullRequests: [],
        openSlices: [],
      },
      skipped: [
        { number: 164, title: expect.any(String) as string, reason: 'ready' },
        { number: 167, title: expect.any(String) as string, reason: 'ready' },
        { number: 168, title: expect.any(String) as string, reason: 'waiting', waitingOn: [141] },
      ],
      done: false,
    });
    // #141 is a dependency of #168 that the trimmed epic does not hold.
    expect(outsideReferences(snapshot)).toEqual([141]);
  });

  it.each<[string, (raw: RawEpic) => void, NextTicketPolicy, number | null, (string | number)[][]]>(
    [
      [
        'blocked by an open issue (blocked_by relation)',
        (raw) => {
          node(raw, 163).blockedBy.nodes.push({
            number: 164,
            state: 'OPEN',
            repository: { nameWithOwner: REPO },
          });
          node(raw, 167).blockedBy.nodes.push({
            number: 131,
            state: 'CLOSED',
            repository: { nameWithOwner: REPO },
          });
        },
        {},
        164,
        [
          [163, 'waiting'],
          [167, 'ready'],
          [168, 'waiting'],
        ],
      ],
      [
        'waiting on an open item by a "Depends on" line',
        (raw) => {
          node(raw, 163).body += '\n\nDepends on #167.';
        },
        {},
        164,
        [
          [163, 'waiting'],
          [167, 'ready'],
          [168, 'waiting'],
        ],
      ],
      [
        'waiting on an open item named after an unclosed fence on an item continuation line',
        (raw) => {
          node(raw, 163).body += '\n\n- example\n\n  ```\n- Depends on #167';
        },
        {},
        164,
        [
          [163, 'waiting'],
          [167, 'ready'],
          [168, 'waiting'],
        ],
      ],
      [
        'waiting on an open item named by a marker on an HTML comment line after a lone backtick',
        (raw) => {
          node(raw, 163).body += '\n\nExample `x\n<!-- epic:depends-on 167 -->\n`';
        },
        {},
        164,
        [
          [163, 'waiting'],
          [167, 'ready'],
          [168, 'waiting'],
        ],
      ],
      [
        'an open linked pull request: in flight, picked before an earlier ready item',
        (raw) => {
          node(raw, 167).closedByPullRequestsReferences.nodes.push(pr(400, 'OPEN'));
          node(raw, 168).closedByPullRequestsReferences.nodes.push(pr(401, 'OPEN'));
          node(raw, 163).closedByPullRequestsReferences.nodes.push(pr(402, 'MERGED'));
        },
        {},
        167,
        [
          [163, 'ready'],
          [164, 'ready'],
          [168, 'in-flight'],
        ],
      ],
      [
        'a hold label in any case',
        (raw) => {
          node(raw, 163).labels.nodes.push({ name: 'On-Hold' });
        },
        {},
        164,
        [
          [163, 'held'],
          [167, 'ready'],
          [168, 'waiting'],
        ],
      ],
      [
        'custom hold labels',
        () => undefined,
        { holdLabels: ['ENHANCEMENT'] },
        164,
        [
          [163, 'held'],
          [167, 'ready'],
          [168, 'held'],
        ],
      ],
      [
        'a split parent with an open slice: split, and its slice is ready',
        reopen(121, 186),
        {},
        186,
        [
          [121, 'split'],
          [163, 'ready'],
          [164, 'ready'],
          [167, 'ready'],
          [168, 'waiting'],
        ],
      ],
      [
        'a split parent whose slices are all closed: close-split, picked before ready',
        reopen(121),
        {},
        121,
        [
          [163, 'ready'],
          [164, 'ready'],
          [167, 'ready'],
          [168, 'waiting'],
        ],
      ],
      [
        'in-flight before close-split',
        both(reopen(121), (raw) => {
          node(raw, 168).closedByPullRequestsReferences.nodes.push(pr(401, 'OPEN'));
        }),
        {},
        168,
        [
          [121, 'close-split'],
          [163, 'ready'],
          [164, 'ready'],
          [167, 'ready'],
        ],
      ],
      [
        'a split marker by someone other than the viewer is ignored',
        both(reopen(121), (raw) => {
          for (const comment of node(raw, 121).comments.nodes)
            comment.author = { login: 'human-author' };
        }),
        {},
        121,
        [
          [163, 'ready'],
          [164, 'ready'],
          [167, 'ready'],
          [168, 'waiting'],
        ],
      ],
      [
        'a split marker inside inline code is ignored',
        both(reopen(121), (raw) => {
          for (const comment of node(raw, 121).comments.nodes)
            comment.body = 'Use `<!-- epic:split 184,185,186 -->` to split.';
        }),
        {},
        121,
        [
          [163, 'ready'],
          [164, 'ready'],
          [167, 'ready'],
          [168, 'waiting'],
        ],
      ],
      [
        // #167 depends on #131, so it waits once #131 reopens.
        'listing order: the checklist decides',
        reopen(184, 131),
        {},
        184,
        [
          [131, 'ready'],
          [163, 'ready'],
          [164, 'ready'],
          [167, 'waiting'],
          [168, 'waiting'],
        ],
      ],
      [
        'number order',
        reopen(184, 131),
        { order: 'number' },
        131,
        [
          [163, 'ready'],
          [164, 'ready'],
          [167, 'waiting'],
          [168, 'waiting'],
          [184, 'ready'],
        ],
      ],
      [
        'a sub-issue of another repository, and checklist lines that are not sub-issues',
        (raw) => {
          const other = structuredClone(node(raw, 164));
          Object.assign(other, {
            number: 500,
            repository: { nameWithOwner: 'octo-org/other-repo' },
          });
          epicOf(raw).subIssues.nodes.push(other);
          epicOf(raw).subIssuesSummary.total += 1;
          epicOf(raw).body +=
            '\n- [ ] #600 Listed but not a sub-issue\n- [x] #601 Checked, so done';
        },
        {},
        163,
        [
          [164, 'ready'],
          [167, 'ready'],
          [168, 'waiting'],
          [500, 'other-repository'],
          [600, 'not-a-sub-issue'],
        ],
      ],
    ],
  )('%s', (_name, mutate, policy, pick, skipped) => {
    const result = nextTicket(snapshotOf(mutate), policy);
    expect(result.pick?.number ?? null).toBe(pick);
    expect(reasons(result)).toEqual(skipped);
    expect(result.done).toBe(false);
  });

  it('reports detail fields: waitingOn, openSlices and open pull requests', () => {
    const result = nextTicket(
      snapshotOf(
        both(reopen(121, 186), (raw) => {
          node(raw, 167).closedByPullRequestsReferences.nodes.push(pr(400, 'OPEN'));
          node(raw, 164).closedByPullRequestsReferences.nodes.push(pr(401, 'OPEN'));
          node(raw, 163).blockedBy.nodes.push({
            number: 7,
            state: 'OPEN',
            repository: { nameWithOwner: 'octo-org/elsewhere' },
          });
        }),
      ),
    );
    expect(result.pick).toMatchObject({ number: 164, status: 'in-flight', pullRequests: [401] });
    expect(result.skipped).toEqual([
      { number: 121, title: expect.any(String) as string, reason: 'split', openSlices: [186] },
      { number: 186, title: expect.any(String) as string, reason: 'ready' },
      { number: 163, title: expect.any(String) as string, reason: 'waiting', waitingOn: [7] },
      {
        number: 167,
        title: expect.any(String) as string,
        reason: 'in-flight',
        pullRequests: [400],
      },
      { number: 168, title: expect.any(String) as string, reason: 'waiting', waitingOn: [141] },
    ]);
  });

  it('keeps closed and merged linked pull requests, which do not make an item in flight', () => {
    // GitHub omits closed pull requests from this connection unless the query asks for them.
    expect(EPIC_SNAPSHOT_QUERY).toContain(
      'closedByPullRequestsReferences(first: 100, includeClosedPrs: true)',
    );
    const snapshot = snapshotOf((raw) => {
      node(raw, 163).closedByPullRequestsReferences.nodes.push(
        pr(402, 'CLOSED'),
        pr(403, 'MERGED'),
      );
    });
    expect(
      snapshot.items.find((item) => item.number === 163)?.pullRequests.map((p) => p.state),
    ).toEqual(['CLOSED', 'MERGED']);
    expect(nextTicket(snapshot).pick).toMatchObject({
      number: 163,
      status: 'ready',
      pullRequests: [],
    });
  });

  it('resolves an outside dependency from policy.outside, and counts an unknown one as open', () => {
    const snapshot = snapshotOf(close(163, 164, 167));
    expect(outsideReferences(snapshot)).toEqual([141]);
    // Unknown: not known to be done, so #168 waits and nothing is ready (stalled, not done).
    expect(nextTicket(snapshot)).toEqual({
      pick: null,
      skipped: [
        { number: 168, title: expect.any(String) as string, reason: 'waiting', waitingOn: [141] },
      ],
      done: false,
    });
    expect(nextTicket(snapshot, { outside: [{ number: 141, state: 'OPEN' }] }).pick).toBeNull();
    expect(nextTicket(snapshot, { outside: [{ number: 141, state: 'CLOSED' }] })).toMatchObject({
      pick: { number: 168, status: 'ready' },
      skipped: [],
      done: false,
    });
    // A snapshot item's own state wins over policy.outside.
    expect(
      nextTicket(snapshotOf(reopen(156)), { outside: [{ number: 156, state: 'CLOSED' }] }).skipped,
    ).toContainEqual(expect.objectContaining({ number: 168, waitingOn: [156, 141] }));
  });

  it('resolves split slices outside the snapshot through policy.outside', () => {
    const snapshot = snapshotOf(
      both(reopen(158), (raw) => {
        epicOf(raw).subIssues.nodes = epicOf(raw).subIssues.nodes.filter(
          (entry) => ![339, 340, 341].includes(entry.number),
        );
        epicOf(raw).subIssuesSummary.total -= 3;
      }),
    );
    expect(outsideReferences(snapshot)).toEqual([141, 339, 340, 341]);
    expect(reasons(nextTicket(snapshot))).toContainEqual([158, 'split']);
    const outside = [339, 340, 341].map((number) => ({ number, state: 'CLOSED' }));
    expect(nextTicket(snapshot, { outside }).pick).toMatchObject({
      number: 158,
      status: 'close-split',
    });
  });

  it('reports done when every item is closed', () => {
    const result = nextTicket(snapshotOf(close(163, 164, 167, 168)));
    expect(result).toEqual({ pick: null, skipped: [], done: true });
    expect(outsideReferences(snapshotOf(close(163, 164, 167, 168)))).toEqual([]);
  });

  it('throws for an empty but incomplete snapshot instead of reporting done', () => {
    const snapshot: GithubEpicSnapshot = { ...snapshotOf(), items: [] };
    expect(() => nextTicket(snapshot)).toThrow(
      'The epic snapshot of #99 holds 0 items but counts 16; it is incomplete, so no ticket is picked.',
    );
    expect(() => nextTicket({ ...snapshotOf(), items: snapshotOf().items.slice(1) })).toThrow(
      'holds 15 items but counts 16',
    );
  });

  it.each<[string, NextTicketPolicy]>([
    ['order', { order: 'random' as 'listing' }],
    ['holdLabels', { holdLabels: 'blocked' as unknown as string[] }],
    ['outside', { outside: [{ number: 1 }] as unknown as readonly NextTicketOutsideIssue[] }],
  ])('rejects an invalid policy %s', (_name, policy) => {
    expect(() => nextTicket(snapshotOf(), policy)).toThrow(/^nextTicket /u);
  });
});

// ---------------------------------------------------------------------------------------------
// Parsers

describe('parseEpicChecklist', () => {
  it.each<[string, string, [number, boolean][]]>([
    [
      'bullets and checkbox states',
      '- [ ] #1 a\n* [x] #2 b\n+ [X] #3 c',
      [
        [1, false],
        [2, true],
        [3, true],
      ],
    ],
    [
      'indented and CRLF lines',
      '  - [ ] #4 nested\r\n\t- [x] #5 tab',
      [
        [4, false],
        [5, true],
      ],
    ],
    ['the first own reference on a line', '- [ ] #6 then #7', [[6, false]]],
    ['inline code removed first', '- [ ] `#8` and ``#9 `x` `` then #10', [[10, false]]],
    [
      'other repositories skipped',
      '- [ ] a/b#11 only elsewhere\n- [ ] a/b#12 then #13',
      [[13, false]],
    ],
    ['own repository qualified in any case', '- [ ] Octo-Org/Quiet-Choir#14', [[14, false]]],
    ['anchors are not references', '- [ ] docs/page#15 and x#16', []],
    ['no reference or no checkbox', '- [ ] plain\n- #17 no box\n-[ ] #18 no space', []],
    ['the epic itself skipped', '- [ ] #99 self\n- [ ] #19', [[19, false]]],
    ['#0 is not an issue', '- [ ] #0 title\n- [ ] #0 then #34', [[34, false]]],
    ['a number beyond the safe range is not an issue', '- [ ] #99999999999999999999 title', []],
    ['the first line wins', '- [x] #20 first\n- [ ] #20 again', [[20, true]]],
    ['backtick fence', '```\n- [ ] #21\n```\n- [ ] #22', [[22, false]]],
    ['tilde fence with info string', '~~~md\n- [ ] #23\n~~~\n- [ ] #24', [[24, false]]],
    [
      'a shorter or different fence does not close',
      '````\n```\n~~~~\n- [ ] #25\n````\n- [ ] #26',
      [[26, false]],
    ],
    ['an unclosed fence runs to the end', '- [ ] #27\n```ts\n- [ ] #28', [[27, false]]],
    [
      'a fence in a block quote or list item',
      '> ~~~\n- [ ] #35\n> ~~~\n- ```\n  - [ ] #36\n  ```\n- [ ] #37',
      [
        [35, false],
        [37, false],
      ],
    ],
    ['an unclosed fence ends with its list item', '- ```\n- [ ] #38', [[38, false]]],
    ['an unclosed fence ends with its quoted list item', '> 1. ~~~\n- [ ] #39', [[39, false]]],
    [
      'a closer indented four columns stays in the fence',
      '~~~\n    ~~~\n- [ ] #40\n~~~\n- [ ] #41',
      [[41, false]],
    ],
    ['a closer indented three columns closes', '~~~\n   ~~~\n- [ ] #42', [[42, false]]],
    ['an opener indented four columns is indented code', '    ```\n- [ ] #43', [[43, false]]],
    [
      'an opener four columns deep on an item continuation line opens a fence',
      '1. foo\n\n    ```\n    - [ ] #45\n    ```\n- [ ] #46',
      [[46, false]],
    ],
    [
      'an opener five columns deep after a two-digit marker opens a fence',
      '10. foo\n\n     ```\n     - [ ] #47\n     ```\n- [ ] #48',
      [[48, false]],
    ],
    [
      'an unclosed fence on an item continuation line ends with the item',
      '- [ ] #49 a\n\n  ```\n- [ ] #50 b',
      [
        [49, false],
        [50, false],
      ],
    ],
    ['inline code on a fence-like line is not a fence', '```a` b\n- [ ] #29', [[29, false]]],
    ['an unmatched backtick stays literal', '- [ ] ` #30 then ``#31``', [[30, false]]],
    [
      'a span does not continue onto the next line',
      '- [ ] `#32\n- [ ] #33`',
      [
        [32, false],
        [33, false],
      ],
    ],
  ])('%s', (_name, body, expected) => {
    expect(
      parseEpicChecklist(body, REPO, 99).map(({ number, checked }) => [number, checked]),
    ).toEqual(expected);
  });

  it('keeps the line text without inline code as the title', () => {
    expect(parseEpicChecklist('- [ ] #3 Fix `a` and b  ', REPO)).toEqual([
      { number: 3, checked: false, title: '#3 Fix  and b' },
    ]);
  });
});

describe('parseDependencies', () => {
  it.each<[string, string[], number[]]>([
    ['depends on', ['Depends on #3.'], [3]],
    ['blocked by a list', ['Blocked by: #4, #5 and #6'], [4, 5, 6]],
    ['requires with & and spaces', ['requires #7 & #8 #9'], [7, 8, 9]],
    ['own qualified reference', [`Depends on ${REPO}#10`], [10]],
    ['other repository skipped', ['Depends on other/repo#11 and #12'], [12]],
    ['marker', ['<!-- epic:depends-on 13, 14 -->'], [13, 14]],
    ['template marker is not one', ['<!-- epic:depends-on a,b -->'], []],
    ['invalid issue numbers dropped', ['Depends on #0 and #99999999999999999999 and #31'], [31]],
    [
      'invalid marker numbers dropped',
      ['<!-- epic:depends-on 0, 99999999999999999999, 32 -->'],
      [32],
    ],
    ['inline code ignored', ['`Depends on #15`'], []],
    ['a double-backtick span holding a backtick', ['``Depends on `#22` `` and #23'], []],
    ['an unmatched backtick stays literal', ['` Depends on #24'], [24]],
    ['unmatched runs of different lengths stay literal', ['``a` Depends on #25'], [25]],
    ['a span across a line ending', ['See `x\nDepends on #26` here'], []],
    ['a span does not cross a blank line', ['See `x\n\nDepends on #27 `'], [27]],
    ['a span does not cross a fence', ['See `x\n```\ncode\n```\nDepends on #28 `'], [28]],
    ['a span does not cross into a list item', ['Example `x\n- Depends on #43`'], [43]],
    ['a span does not cross into a block quote', ['Example `x\n> Depends on #44`'], [44]],
    ['a span does not cross into a heading', ['Example `x\n# Depends on #45`'], [45]],
    ['a heading is one line', ['## Example `x\nDepends on #46`'], [46]],
    ['a span does not cross a thematic break', ['Example `x\n* * *\nDepends on #47`'], [47]],
    ['a span does not cross a setext heading', ['Example `x\n===\nDepends on #65`'], [65]],
    ['a span does not cross a - underline', ['Example `x\n---\nDepends on #66`'], [66]],
    ['a setext heading in a block quote', ['> Example `x\n>  == \t\n> Depends on #67`'], [67]],
    ['a heading keeps its own spans', ['`Depends on #68`\n==='], []],
    ['a lone = line starts a paragraph', ['===\nSee `x\nDepends on #69`'], []],
    ['an indented = line continues a paragraph', ['Example `x\n    ===\nDepends on #70`'], []],
    ['a lazy = line continues a quoted paragraph', ['> Example `x\n===\nDepends on #71`'], []],
    ['a span does not cross into an item numbered 1', ['Example `x\n1) Depends on #48`'], [48]],
    ['an item numbered 2 continues a paragraph', ['Example `x\n2. Depends on #49`'], []],
    ['a sibling item of any number', ['1. Example `x\n2. Depends on #50`'], [50]],
    ['a span does not cross a one-hyphen underline', ['Example `x\n-\nDepends on #51`'], [51]],
    ['a span does not cross a two-hyphen underline', ['Example `x\n--\nDepends on #79`'], [79]],
    ['an indented underline with trailing blanks', ['Example `x\n   -- \t\nDepends on #84`'], [84]],
    ['a lone - line starts a paragraph', ['-\nSee `x\nDepends on #80`'], []],
    ['a lone -- line starts a paragraph', ['--\nSee `x\nDepends on #81`'], []],
    ['a - item is not an underline', ['Example `x\n - Depends on #82`'], [82]],
    ['an indented - line continues a paragraph', ['Example `x\n    -\nDepends on #83`'], []],
    ['indented code continues a paragraph', ['Example `x\n    - Depends on #52`'], []],
    ['a span across lines of one block quote', ['> See `x\n> Depends on #53`'], []],
    ['a span across a lazy continuation line', ['> See `x\nDepends on #54`'], []],
    ['a span across lines of one list item', ['- See `x\n  Depends on #55`'], []],
    [
      'a span does not cross an HTML comment line',
      ['Example `x\n<!-- epic:depends-on 97 -->\n`'],
      [97],
    ],
    [
      'a span does not cross a multi-line HTML comment',
      ['Example `x\n<!--\n  epic:depends-on 98\n-->\n`'],
      [98],
    ],
    [
      'a span does not cross a quoted HTML comment line',
      ['> Example `x\n> <!-- epic:depends-on 100 -->\n> `'],
      [100],
    ],
    [
      'an inline marker in a paragraph is code',
      ['Intro\nsee `<!-- epic:depends-on 99 -->` here'],
      [],
    ],
    [
      'a line opening with code is not an HTML comment',
      ['Intro\n`<!-- epic:depends-on 99 -->`'],
      [],
    ],
    ['an HTML comment has no inline code', ['<!-- `x\nDepends on #101 ` -->'], [101]],
    ['an HTML comment ends at its closer', ['<!--\n`x\n-->\nDepends on #103 `'], [103]],
    [
      'an HTML comment ends with its block quote',
      ['> <!-- open\nExample `x\nDepends on #102`'],
      [],
    ],
    ['a colon after the phrase', ['Depends on: #29', 'requires :#30'], [29, 30]],
    ['fenced code ignored', ['```\nDepends on #16\n```\nDepends on #17'], [17]],
    ['a fence in a block quote', ['> ~~~\n> Depends on #33\n>\n> ~~~\n> Depends on #34'], [34]],
    ['a fence in nested block quotes', ['> > ```md\n>> Depends on #35\n> > ```'], []],
    ['a quoted fence ends with its block quote', ['> ~~~\n> code\n\nDepends on #36'], [36]],
    ['a quoted fence line is not a closer outside it', ['~~~\n> ~~~\nDepends on #37\n~~~'], []],
    ['a > indented four columns opens no fence', ['    > ~~~\n> Depends on #104'], [104]],
    ['a > indented a tab opens no fence', ['\t> ~~~\n> Depends on #105'], [105]],
    ['a > indented three columns opens a fence', ['   > ~~~\n> Depends on #106'], []],
    [
      'a nested > four columns past its parent opens no fence',
      ['>     > ~~~\n> > Depends on #107'],
      [107],
    ],
    [
      'a nested > three columns past its parent opens a fence',
      ['>    > ~~~\n> > Depends on #108'],
      [],
    ],
    ['a fence ends at a > indented four columns', ['> ~~~\n    > ~~~\n> Depends on #109'], [109]],
    ['a > indented four columns is no deeper quote', ['Example `x\n    > Depends on #110`'], []],
    ['a > indented three columns is a deeper quote', ['Example `x\n   > Depends on #111`'], [111]],
    [
      'a fence in a list item',
      ['- ~~~\n  Depends on #38\n  ~~~\n1. ```\n   Depends on #39\n   ```\n- Depends on #40'],
      [40],
    ],
    ['a fence in a list item in a block quote', ['> - ~~~\n>   Depends on #41\n>   ~~~'], []],
    ['a fence ends with its list item', ['- ```\n- Depends on #56'], [56]],
    ['a fence continues in its list item', ['- ```\n  Depends on #57\n\n  x'], []],
    ['a fence ends at a dedent after a blank line', ['1. ~~~\n\n   x\nDepends on #58'], [58]],
    ['a fence takes the spaces after its marker', ['-   ```\n  Depends on #59'], [59]],
    ['a fence in a nested list item', ['- - ```\n    x\n  Depends on #60'], [60]],
    ['a quoted fence ends with its list item', ['> - ```\n> - Depends on #61'], [61]],
    ['a quoted fence continues in its list item', ['> - ```\n>   Depends on #62'], []],
    ['a quoted fence ends at a dedent', ['> 1. ~~~\n>\n>    x\n> Depends on #63'], [63]],
    // A tab after a list marker advances to the next multiple of four, so `-\t` puts the content at
    // column 4 and `1. -\t` at column 8.
    ['a fence ends left of a tab-padded bullet item', ['-\t~~~\n   Depends on #112'], [112]],
    ['a fence continues in a tab-padded bullet item', ['-\t~~~\n    Depends on #113'], []],
    ['a fence ends left of a tab-padded ordered item', ['1.\t~~~\n   Depends on #114'], [114]],
    ['a fence continues in a tab-padded ordered item', ['1.\t~~~\n    Depends on #115'], []],
    ['a fence ends left of a tab-padded nested item', ['- -\t~~~\n   Depends on #116'], [116]],
    ['a fence continues in a tab-padded nested item', ['- -\t~~~\n    Depends on #117'], []],
    ['a fence ends left of tab-padded nested items', ['-\t-\t~~~\n       Depends on #118'], [118]],
    ['a fence continues in tab-padded nested items', ['-\t-\t~~~\n        Depends on #119'], []],
    ['a fence ends left of a tab past column 4', ['1. -\t~~~\n       Depends on #120'], [120]],
    ['a fence continues past a tab past column 4', ['1. -\t~~~\n        Depends on #121'], []],
    ['five columns after a marker make indented code', ['-\t\t~~~\n  Depends on #122'], [122]],
    ['a dedented fence line is not a closer in the item', ['- ```\n```\nDepends on #64'], []],
    [
      'a closer indented four columns stays in the fence',
      ['```\n    ```\nDepends on #74\n```'],
      [],
    ],
    ['a closer indented three columns closes', ['```\n   ```\nDepends on #75'], [75]],
    ['a closer three columns past its item closes', ['1. ```\n      ```\n   Depends on #76'], [76]],
    ['a closer four columns past its item does not', ['- ```\n      ```\n  Depends on #77'], []],
    [
      'a fence on an item continuation line closes at its own indentation',
      ['- a\n\n    ```\n    x\n    ```\nDepends on #78'],
      [78],
    ],
    [
      'an opener indented four columns is indented code',
      ['Example:\n\n    ```\nDepends on #85'],
      [85],
    ],
    [
      'a quoted opener indented four columns is indented code',
      ['> Example:\n>\n>     ```\n> Depends on #86'],
      [86],
    ],
    [
      'a quoted opener four columns deep on an item continuation line opens a fence',
      ['> 1. foo\n>\n>     ```\n>     Depends on #87\n>     ```\n> Depends on #88'],
      [88],
    ],
    [
      'an opener more than three columns past its item is indented code',
      ['- a\n\n      ```\n- Depends on #96'],
      [96],
    ],
    [
      'a continuation-line fence ends with its item',
      ['- example\n\n  ```\n- Depends on #89'],
      [89],
    ],
    [
      'a nested continuation-line fence ends at the outer sibling',
      ['- a\n  - b\n\n    ```\n  - Depends on #90'],
      [90],
    ],
    [
      'a lazy continuation line keeps the item open',
      ['- a\nlazy\n\n  ```\n  x\n- Depends on #91'],
      [91],
    ],
    [
      'a blank line inside a continuation-line fence does not end it',
      ['- a\n\n  ```\n\n  Depends on #92\n- x'],
      [],
    ],
    [
      'a quoted continuation-line fence ends with its item',
      ['> - a\n>\n>   ```\n> - Depends on #93'],
      [93],
    ],
    [
      'a dedent after a blank line closes the item before the fence',
      ['- a\n\nb\n\n  ```\n- Depends on #94'],
      [],
    ],
    ['a thematic break opens no item', ['* * *\n\n  ```\n- Depends on #95'], []],
    ['a word between the phrase and the reference', ['depends on the #18 fix'], []],
    ['indented code is still read', ['Example:\n\n    Depends on #72'], [72]],
    ['an indented marker is still read', ['    <!-- epic:depends-on 73 -->'], [73]],
    ['self excluded', ['Depends on #42 and #19'], [19]],
    [
      'unique across body and comments, in order',
      ['Depends on #20', 'Requires #21, #20'],
      [20, 21],
    ],
  ])('%s', (_name, texts, expected) => {
    expect(parseDependencies(texts, REPO, 42)).toEqual(expected);
  });
});

// Inputs that made the regex-based code stripping and checklist line backtrack polynomially
// (CodeQL js/polynomial-redos). The linear scanner finishes them well within the default timeout.
describe('parsers on adversarial input', () => {
  const runs = (count: number, length: (index: number) => number): string =>
    Array.from({ length: count }, (_, index) => '`'.repeat(length(index))).join('a');

  it.each<[string, string]>([
    ['one long backtick run', 'x' + '`'.repeat(200_000)],
    ['runs of distinct lengths', runs(440, (index) => index + 1)],
    ['alternating run lengths', runs(40_000, (index) => (index % 2) + 1)],
    ['a long run after an opener', '`a' + '`'.repeat(100_000)],
  ])('reads a dependency after %s', (_name, prefix) => {
    expect(parseDependencies([`${prefix} Depends on #7`], REPO, 42)).toEqual([7]);
  });

  it('reads no dependency inside a code span that holds a long run of another length', () => {
    expect(parseDependencies(['` ' + '``'.repeat(50_000) + ' Depends on #7`'], REPO, 42)).toEqual(
      [],
    );
  });

  it('reads a checklist title made of backtick runs', () => {
    const title = '`'.repeat(100_000);
    expect(
      parseEpicChecklist(`- [ ] #7 ${title}\n- [ ] ${runs(440, (i) => i + 1)} #8`, REPO),
    ).toEqual([
      { number: 7, checked: false, title: `#7 ${title}` },
      { number: 8, checked: false, title: `${runs(440, (i) => i + 1)} #8` },
    ]);
  });

  it('rejects a checkbox line with a long run of whitespace and a line separator', () => {
    expect(parseEpicChecklist(`* [ ]${'\t'.repeat(100_000)}x #5\u2028`, REPO)).toEqual([]);
  });

  it('reads no dependency from a phrase followed by a long run of whitespace', () => {
    expect(parseDependencies([`Depends on${' '.repeat(100_000)}x`], REPO, 42)).toEqual([]);
  });

  it('reads long runs of container markers in linear time', () => {
    for (const marker of ['> ', '- ', '1. ', ' \t', '#', '-', '_ ', '='])
      expect(
        parseDependencies(
          [`${marker.repeat(100_000)}x\n${marker.repeat(100_000)}Depends on #7`],
          REPO,
          42,
        ),
      ).toEqual([7]);
  });

  it('reads fence lines made of long backtick runs', () => {
    const run = '`'.repeat(100_000);
    // A backtick after the run makes the line inline code, not a fence.
    expect(parseEpicChecklist(`${run} x\`\n- [ ] #9`, REPO)).toEqual([
      { number: 9, checked: false, title: '#9' },
    ]);
    // Any other info string opens a fence, which a run at least as long closes.
    expect(parseEpicChecklist(`${run}\u2028\n- [ ] #9\n${run}\n- [ ] #10`, REPO)).toEqual([
      { number: 10, checked: false, title: '#10' },
    ]);
  });
});

describe('parseSplit', () => {
  const by = (author: string | null, body: string) => ({ author, body });
  it.each<[string, { author: string | null; body: string }[], number[] | null]>([
    ['the viewer marker', [by(VIEWER, 'Split.\n\n<!-- epic:split 1,2, 3 -->')], [1, 2, 3]],
    ['the viewer in any case', [by('OCTO-BOT', '<!-- epic:split 4 -->')], [4]],
    ['another author', [by('human-author', '<!-- epic:split 5 -->')], null],
    ['a deleted author', [by(null, '<!-- epic:split 6 -->')], null],
    [
      'the last marker wins',
      [by(VIEWER, '<!-- epic:split 7 -->'), by(VIEWER, '<!-- epic:split 8,9 -->')],
      [8, 9],
    ],
    [
      'a later marker by someone else does not replace it',
      [by(VIEWER, '<!-- epic:split 10 -->'), by('human-author', '<!-- epic:split 11 -->')],
      [10],
    ],
    ['a template is not a marker', [by(VIEWER, '<!-- epic:split a,b -->')], null],
    ['inline code', [by(VIEWER, '`<!-- epic:split 12 -->`')], null],
    ['a two-line code span', [by(VIEWER, 'Like `\nsee <!-- epic:split 5,6 -->\n` this')], null],
    [
      'an HTML comment line ends a code span',
      [by(VIEWER, 'Like `\n<!-- epic:split 5,6 -->\n` this')],
      [5, 6],
    ],
    [
      'a code span does not cross a blank line',
      [by(VIEWER, 'Like `\n\n<!-- epic:split 5,6 -->\n\n` this')],
      [5, 6],
    ],
    ['fenced code', [by(VIEWER, '~~~\n<!-- epic:split 13 -->\n~~~')], null],
    [
      'a quoted reply of a fenced example',
      [by(VIEWER, '> ~~~\n> <!-- epic:split 1,2 -->\n> ~~~\n\nThanks.')],
      null,
    ],
    [
      'a fenced example in a list item',
      [by(VIEWER, '- ```\n  <!-- epic:split 1 -->\n  ```')],
      null,
    ],
    ['indented code', [by(VIEWER, 'Like this:\n\n    <!-- epic:split 1,2 -->')], null],
    ['an indented marker after text', [by(VIEWER, 'Split.\n    <!-- epic:split 1,2 -->')], null],
    ['a tab-indented marker', [by(VIEWER, '\t<!-- epic:split 1 -->')], null],
    ['indented code in a block quote', [by(VIEWER, '>     <!-- epic:split 1,2 -->')], null],
    ['a > indented four columns', [by(VIEWER, '    > <!-- epic:split 1 -->')], null],
    ['a > indented a tab', [by(VIEWER, '\t> <!-- epic:split 1 -->')], null],
    ['a > indented three columns', [by(VIEWER, '   > <!-- epic:split 17 -->')], [17]],
    [
      'a nested > four columns past its parent',
      [by(VIEWER, '>     > <!-- epic:split 1 -->')],
      null,
    ],
    [
      'a nested > three columns past its parent',
      [by(VIEWER, '>    > <!-- epic:split 18 -->')],
      [18],
    ],
    [
      'a fence behind a > indented four columns',
      [by(VIEWER, '    > ~~~\n> <!-- epic:split 19 -->')],
      [19],
    ],
    [
      'a closer indented four columns stays in the fence',
      [by(VIEWER, '```\n    ```\n<!-- epic:split 1,2 -->\n```')],
      null,
    ],
    [
      'a closer indented three columns closes',
      [by(VIEWER, '```\n   ```\n<!-- epic:split 1,2 -->')],
      [1, 2],
    ],
    [
      'a closer three columns past its bullet item closes',
      [by(VIEWER, '- ```\n     ```\n  <!-- epic:split 3 -->')],
      [3],
    ],
    [
      'a closer four columns past its bullet item does not',
      [by(VIEWER, '- ```\n      ```\n  <!-- epic:split 3 -->')],
      null,
    ],
    [
      'a closer three columns past its ordered item closes',
      [by(VIEWER, '1. ```\n      ```\n   <!-- epic:split 4 -->')],
      [4],
    ],
    [
      'a closer four columns past its ordered item does not',
      [by(VIEWER, '1. ```\n       ```\n   <!-- epic:split 4 -->')],
      null,
    ],
    [
      'a fence on an item continuation line closes at its own indentation',
      [by(VIEWER, '- a\n\n    ```\n    x\n    ```\n<!-- epic:split 6 -->')],
      [6],
    ],
    ['a marker after indented text', [by(VIEWER, '    see <!-- epic:split 1 -->')], null],
    [
      'a column-0 marker after an indented one',
      [by(VIEWER, '    <!-- epic:split 1 -->\n\n<!-- epic:split 2,3 -->')],
      [2, 3],
    ],
    ['a marker indented less than four', [by(VIEWER, '   <!-- epic:split 15 -->')], [15]],
    ['a block-quoted column-0 marker', [by(VIEWER, '> <!-- epic:split 16 -->')], [16]],
    ['self excluded and duplicates removed', [by(VIEWER, '<!-- epic:split 42, 14, 14 -->')], [14]],
    ['only self', [by(VIEWER, '<!-- epic:split 42 -->')], null],
    ['invalid numbers dropped', [by(VIEWER, '<!-- epic:split 0,3 -->')], [3]],
    ['only invalid numbers', [by(VIEWER, '<!-- epic:split 0, 99999999999999999999 -->')], null],
  ])('%s', (_name, comments, expected) => {
    expect(parseSplit(comments, VIEWER, 42)).toEqual(expected);
  });

  it('counts no marker when the viewer is unknown', () => {
    expect(parseSplit([by('', '<!-- epic:split 1 -->')], '', 42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The example and the dry run

describe('examples/patterns/next-ticket.workflow.ts', () => {
  it('composes repo.info, epic.snapshot, issue.view and nextTicket, and replays without gh', async () => {
    const example = (await import('../examples/patterns/next-ticket.workflow.js')).default;
    let fail = true;
    const wrapped: typeof example = {
      ...example,
      async run(ctx, input) {
        const output = await example.run(ctx, input);
        if (fail) throw new Error('Injected tail failure');
        return output;
      },
    };
    const input = { repo: REPO, epic: 99, round: 1 };
    const first = fakeGh(undefined, { 141: 'CLOSED' });
    await expect(
      runWorkflow(wrapped, { ...setup('example'), input, processRunner: first.runner }),
    ).rejects.toThrow('Injected tail failure');
    expect(first.seen.map(({ argv }) => `${readOf(argv)} ${String(numberOf(argv))}`)).toEqual([
      'repo.info NaN',
      'epic.snapshot 99',
      'issue.view 141',
      'issue.comments 163',
    ]);
    fail = false;
    const second = fakeGh();
    const resumed = await runWorkflow(wrapped, {
      ...setup('example'),
      input,
      processRunner: second.runner,
      resume: true,
    });
    expect(second.seen).toEqual([]);
    expect(resumed.output).toEqual({
      repository: REPO,
      pick: 163,
      title: 'Ticket #163',
      comments: 1,
      skipped: [
        { number: 164, reason: 'ready' },
        { number: 167, reason: 'ready' },
        // #141 read as closed, so #168 is ready too.
        { number: 168, reason: 'ready' },
      ],
      done: false,
    });
    expect(Object.keys((await readRun(setup('example'))).steps)).toEqual(
      expect.arrayContaining(['repo', 'epic/99/1', 'outside/141/1', 'ticket/163/1']),
    );
  });
});

// One executor run type-checks and imports a workflow module. measured: 1.5 s alone; the same
// executor run as test/github.test.ts's dry run, measured there at 4.3 s in the full coverage run
// (dominated by the loader's type check and tsImport compile).
describe('dry-run', { timeout: 30_000 }, () => {
  it('lists the snapshot as exactly one synthesized command and spawns nothing', async () => {
    await project();
    const file = join(cwd(), 'epic.workflow.ts');
    await writeFile(
      file,
      `import { defineWorkflow, z } from ${JSON.stringify(join(repository, 'src/index.js'))};
import { github, nextTicket } from ${JSON.stringify(join(repository, 'src/integrations/github.js'))};
export default defineWorkflow({
  name: 'epic-dry', version: '1', input: z.object({ repo: z.string() }), output: z.unknown(),
  async run(ctx, input) {
    const snapshot = await github(ctx, { repo: input.repo }).epic.snapshot('epic', { number: 99 });
    return { snapshot, next: nextTicket(snapshot) };
  },
});
`,
    );
    const { run, commands } = await rehearse(file, { repo: REPO });
    expect(run.status).toBe('completed');
    expect(commands.map((command) => [command.stepId, command.outputSource])).toEqual([
      ['epic', 'synthesized'],
    ]);
    expect(commands[0]?.command).toEqual(epicSnapshotRead(repo, 99).argv);
    // The synthesized response passed the schema, its completeness checks, the mapper and the
    // selector: one synthesized sub-issue of another repository, with a total of 0.
    const output = run.output as unknown as {
      snapshot: GithubEpicSnapshot;
      next: NextTicketResult;
    };
    expect(output.snapshot).toMatchObject({ source: 'sub-issues', total: 0 });
    expect(output.snapshot.items).toHaveLength(1);
    expect(output.next.pick).toBeNull();
  });
});
