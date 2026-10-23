// The pure rules of the execute-epic-ticket package (packages/execute-epic-ticket.quiet-choir,
// #590), ported from the native execute-epic-ticket script and its epic.mjs helper.
import { describe, expect, it, vi } from 'vitest';
import {
  branchName,
  candidates,
  closeReason,
  counts,
  fenceMask,
  firstSentence,
  homeItems,
  implementerSlot,
  insertAfter,
  isRepoPull,
  itemStatuses,
  landingNotes,
  ledgerLine,
  pickFor,
  prBody,
  SETTLED,
  shaCommits,
  slugify,
  stillHeld,
  tickBody,
  unsettled,
  waitingHeadline,
  withDependency,
  withFollowups,
  type EpicItem,
  type Selection,
} from '../packages/execute-epic-ticket.quiet-choir/lib/policy.js';

// The contracts, prompts and state renderers import `quiet-choir`, which resolves to dist/, and npm
// run check typechecks and tests before it builds. So the import maps to src/ here, and those
// modules load by a computed specifier the root typecheck does not follow; the package's own
// typecheck covers them.
vi.mock('quiet-choir', () => import('../src/index.js'));
vi.mock('quiet-choir/github', () => import('../src/integrations/github.js'));
const load = async <T>(name: string): Promise<T> => {
  const url = new URL(`../packages/execute-epic-ticket.quiet-choir/${name}.ts`, import.meta.url);
  return (await import(url.href)) as T;
};
interface Parser {
  safeParse(value: unknown): { success: boolean; error?: { issues: { message: string }[] } };
}
const { EpicTicketInput, Implemented } = await load<{
  EpicTicketInput: Parser & { parse(value: unknown): Record<string, unknown> };
  Implemented: (ids: [string, ...string[]]) => Parser;
}>('contracts');
type Render = (params: Record<string, unknown>) => { text: string };
const { prompts } = await load<{
  prompts: {
    FollowupsSection: Render;
    SplitComment: Render;
    CloseSplitComment: Render;
    DecisionComment: Render;
  };
}>('prompts');
const { renderEpic, renderItemsTable } = await load<{
  renderEpic: (
    epic: { number: number; title: string; state: string; url: string; body: string },
    items: readonly EpicItem[],
    statuses: ReadonlyMap<number, string>,
    at: string,
  ) => string;
  renderItemsTable: (items: readonly EpicItem[], statuses: ReadonlyMap<number, string>) => string;
}>('lib/state');
const { parseSplit } = await import('../src/integrations/github.js');

const repo = 'acme/widgets';
const item = (number: number, fields: Partial<EpicItem> = {}): EpicItem => ({
  number,
  repository: repo,
  title: `Ticket ${String(number)}`,
  state: 'OPEN',
  labels: [],
  checked: false,
  dependsOn: [],
  blockedBy: [],
  pullRequests: [],
  split: null,
  ...fields,
});
const items: EpicItem[] = [
  item(1, { state: 'CLOSED', checked: true }),
  item(2, { pullRequests: [{ number: 20, state: 'OPEN' }] }),
  item(3, { labels: ['needs-decision'] }),
  item(4, { dependsOn: [9] }),
  item(5),
  item(6),
  item(7, { split: [70, 71] }),
];
const selection: Selection = {
  pick: { number: 2, title: 'Ticket 2', status: 'in-flight', pullRequests: [20], openSlices: [] },
  skipped: [
    { number: 3, title: 'Ticket 3', reason: 'held' },
    { number: 4, title: 'Ticket 4', reason: 'waiting', waitingOn: [9] },
    { number: 5, title: 'Ticket 5', reason: 'ready' },
    { number: 6, title: 'Ticket 6', reason: 'ready' },
    { number: 7, title: 'Ticket 7', reason: 'split', openSlices: [71] },
    { number: 8, title: 'Ticket 8', reason: 'not-a-sub-issue' },
  ],
  done: false,
};

describe('pickFor', () => {
  it("takes the selector's pick without a preferred ticket", () => {
    expect(pickFor(selection, items, null)).toMatchObject({
      number: 2,
      status: 'in-flight',
      pr: 20,
    });
  });

  it('takes a preferred ready ticket that the selector skipped', () => {
    expect(pickFor(selection, items, 6)).toMatchObject({ number: 6, status: 'ready', pr: null });
  });

  it('keeps a preferred held ticket held, with its labels for the decision rule', () => {
    const held = pickFor(selection, items, 3);
    expect(held).toMatchObject({ number: 3, status: 'held', labels: ['needs-decision'] });
    expect(held && stillHeld(held, null)).toBe(true);
    expect(held && stillHeld(held, 'Use the system palette.')).toBe(false);
    expect(stillHeld({ status: 'held', labels: ['on-hold'] }, 'An answer.')).toBe(true);
    expect(stillHeld({ status: 'ready', labels: [] }, null)).toBe(false);
  });

  it('reports a preferred in-flight, waiting or split ticket with what its dispatch reads', () => {
    expect(pickFor(selection, items, 2)).toMatchObject({ status: 'in-flight', pr: 20 });
    expect(pickFor(selection, items, 4)).toMatchObject({ status: 'waiting', waitingOn: [9] });
    expect(pickFor(selection, items, 7)).toMatchObject({
      status: 'split',
      openSlices: [71],
      split: [70, 71],
    });
  });

  it('marks a preferred closed item closed, and returns null for a ticket the epic lacks', () => {
    expect(pickFor(selection, items, 1)).toMatchObject({ number: 1, status: 'closed' });
    expect(pickFor(selection, items, 99)).toBeNull();
    expect(pickFor(selection, items, 8)).toBeNull();
  });
});

describe('homeItems', () => {
  it("keeps the epic repository's items, so a foreign sub-issue's number answers for nothing", () => {
    const foreign = item(9, {
      repository: 'other/repo',
      state: 'CLOSED',
      labels: ['blocked'],
      split: [90],
    });
    const local = item(9, { repository: 'Acme/Widgets', labels: ['needs-decision'], split: [91] });
    const mixed = [foreign, local];
    const sel: Selection = {
      pick: null,
      skipped: [{ number: 9, title: 'Ticket 9', reason: 'held' }],
      done: false,
    };
    expect(homeItems(mixed, repo)).toEqual([local]);
    expect(candidates(sel, homeItems(mixed, repo), null, 3)).toEqual([]);
    expect(pickFor(sel, homeItems(mixed, repo), 9)).toMatchObject({
      number: 9,
      status: 'held',
      labels: ['needs-decision'],
      split: [91],
    });
    // Unfiltered, the foreign item answers first, which is the defect this guards against.
    expect(pickFor(sel, mixed, 9)).toMatchObject({ labels: ['blocked'], split: [90] });
    // With only the foreign item left, a named ticket 9 is not an item of the epic.
    expect(pickFor({ pick: null, skipped: [], done: false }, homeItems([foreign], repo), 9)).toBe(
      null,
    );
  });
});

describe('isRepoPull', () => {
  it("accepts only the repository's own pull request URLs", () => {
    expect(isRepoPull('https://github.com/acme/widgets/pull/20', repo)).toBe(true);
    expect(isRepoPull('https://github.com/Acme/Widgets/pull/20', repo)).toBe(true);
    expect(isRepoPull('https://github.com/other/widgets/pull/20', repo)).toBe(false);
    expect(isRepoPull('https://github.com/acme/widgets-old/pull/20', repo)).toBe(false);
    expect(isRepoPull('https://github.com/acme/widgets/issues/20', repo)).toBe(false);
    expect(isRepoPull('https://ghe.example/acme/widgets/pull/3', 'ghe.example/acme/widgets')).toBe(
      true,
    );
  });
});

describe('candidates', () => {
  it('is the pick, then later ready tickets, capped by maxCandidates', () => {
    expect(candidates(selection, items, null, 3).map((c) => c.number)).toEqual([2, 5, 6]);
    expect(candidates(selection, items, null, 2).map((c) => c.number)).toEqual([2, 5]);
    expect(candidates(selection, items, null, 1).map((c) => c.number)).toEqual([2]);
  });

  it('is only the named ticket when one is given, and empty without a pick', () => {
    expect(candidates(selection, items, 5, 3).map((c) => c.number)).toEqual([5]);
    expect(candidates({ pick: null, skipped: [], done: true }, items, null, 3)).toEqual([]);
  });
});

describe('counts and headlines', () => {
  it('counts the items by state and status', () => {
    expect(counts(items, selection)).toEqual({
      total: 7,
      open: 6,
      closed: 1,
      ready: 2,
      inFlight: 1,
      waiting: 1,
      held: 1,
      split: 1,
    });
  });

  it('lists every skipped item and its open dependencies in the stalled headline', () => {
    expect(
      waitingHeadline(10, {
        pick: null,
        skipped: [
          { number: 4, title: 'x', reason: 'waiting', waitingOn: [9, 11] },
          { number: 3, title: 'y', reason: 'held' },
        ],
        done: false,
      }),
    ).toBe('Nothing in #10 is ready: #4 waiting on #9, #11; #3 held.');
  });

  it('gives the first sentence of a rationale and the close reason of a verdict', () => {
    expect(firstSentence('Already done in #8. Tests cover it.')).toBe('Already done in #8');
    expect(closeReason('already-done')).toBe('completed');
    expect(closeReason('no-longer-applies')).toBe('not_planned');
  });
});

describe('slugify and branchName', () => {
  it('matches the native epic.mjs slugify on a table of titles', async () => {
    const native = (await import(
      new URL('../.claude/workflows/execute-epic-ticket/epic.mjs', import.meta.url).href
    )) as { slugify: (title: string, max?: number) => string };
    const titles = [
      'Add the widget',
      "runner.ts: replace effect()'s 15 positional parameters with an EffectSpec",
      'Port execute-epic-ticket from a native Workflow script to a quiet-choir package',
      '  --leading and trailing--  ',
      '!!!',
      '',
      'abcdefghij-abcdefghij-abcdefghij-abcdefgh-xyz',
      'abcdefghijabcdefghijabcdefghijabcdefghijabcdefghij',
      'Ünïcödé títle with 日本語',
    ];
    for (const title of titles) expect(slugify(title)).toBe(native.slugify(title));
  });

  it('names a new ticket branch epic-E/N-slug, the native convention', () => {
    expect(
      branchName(
        576,
        590,
        'Port execute-epic-ticket from a native Workflow script to a quiet-choir package',
      ),
    ).toBe('epic-576/590-port-execute-epic-ticket-from-a-native');
  });
});

describe('implementerSlot', () => {
  it('picks the surgeon for subtle or large plans and honors the override', () => {
    expect(implementerSlot({ complexity: 'mechanical', size: 'small' }, 'auto')).toBe('mechanic');
    expect(implementerSlot({ complexity: 'mechanical', size: 'medium' }, 'auto')).toBe('mechanic');
    expect(implementerSlot({ complexity: 'mechanical', size: 'large' }, 'auto')).toBe('surgeon');
    expect(implementerSlot({ complexity: 'subtle', size: 'small' }, 'auto')).toBe('surgeon');
    expect(implementerSlot({ complexity: 'subtle', size: 'large' }, 'mechanic')).toBe('mechanic');
    expect(implementerSlot({ complexity: 'mechanical', size: 'small' }, 'surgeon')).toBe('surgeon');
  });
});

describe('unsettled and shaCommits', () => {
  const criterion = (id: string, status: string, commit = '') => ({
    id,
    status,
    commit,
    evidence: `evidence for ${id}`,
  });

  it('settles done, verify-on-pr and deviation only', () => {
    expect([...SETTLED].sort()).toEqual(['deviation', 'done', 'verify-on-pr']);
    expect(
      unsettled(
        ['a1', 'a2', 'a3', 'a4', 'a5'],
        [
          criterion('a1', 'done'),
          criterion('a2', 'verify-on-pr'),
          criterion('a3', 'deviation'),
          criterion('a4', 'partial'),
        ],
      ),
    ).toEqual([
      { id: 'a4', status: 'partial', evidence: 'evidence for a4' },
      { id: 'a5', status: 'not reported', evidence: '' },
    ]);
  });

  it('verifies commit-shaped values only, once each', () => {
    expect(
      shaCommits([
        criterion('a1', 'done', 'abc1234'),
        criterion('a2', 'done', ' abc1234 '),
        criterion('a3', 'done', 'already on main (#138)'),
        criterion('a4', 'done', ''),
        criterion('a5', 'done', '0123456789abcdef0123456789abcdef01234567'),
      ]),
    ).toEqual(['abc1234', '0123456789abcdef0123456789abcdef01234567']);
  });

  it('constrains reported criterion ids to the plan', () => {
    const schema = Implemented(['a1', 'a2']);
    const report = (id: string) => ({
      criteria: [{ id, status: 'done', commit: '', evidence: '' }],
      deviations: [],
      followups: [],
      notes: [],
    });
    expect(schema.safeParse(report('a2')).success).toBe(true);
    expect(schema.safeParse(report('a3')).success).toBe(false);
  });
});

describe('PR and issue bodies', () => {
  const footer = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
  const section = prompts.FollowupsSection({
    epic: 50,
    items: [
      { number: 51, title: 'Theme the widget' },
      { number: 52, title: null },
    ],
  }).text;

  it('renders the follow-up section', () => {
    expect(section).toBe('Follow-ups filed under #50:\n\n- #51 Theme the widget\n- #52\n');
  });

  it('places the follow-ups before the footer, or appends them without one', () => {
    expect(withFollowups(`Closes #9.\n\nBody.\n\n${footer}\n`, section, footer)).toBe(
      `Closes #9.\n\nBody.\n\nFollow-ups filed under #50:\n\n- #51 Theme the widget\n- #52\n\n${footer}\n`,
    );
    expect(withFollowups('Closes #9.\n\nBody.\n', section, footer)).toBe(
      'Closes #9.\n\nBody.\n\nFollow-ups filed under #50:\n\n- #51 Theme the widget\n- #52',
    );
    expect(withFollowups('Body.', '', footer)).toBe('Body.');
  });

  it('makes a PR body close exactly its ticket and name the epic', () => {
    expect(prBody('Closes #9.\nPart of #7.\n\nBody.', 9, 7, repo)).toBe(
      'Closes #9.\nPart of #7.\n\nBody.',
    );
    expect(prBody('Fixes #3 and closes #9.', 9, 7, repo)).toBe(
      'Refs #3 and closes #9.\n\nPart of #7.\n',
    );
    expect(prBody('Body only.', 9, 7, repo)).toBe('Body only.\n\nCloses #9.\n\nPart of #7.\n');
  });

  it('normalizes qualified and URL closing references by repository', () => {
    // Another repository's #9 is not this ticket, and its closing keyword becomes Refs.
    expect(prBody('Fixes other/repo#9. Part of #7.', 9, 7, repo)).toBe(
      'Refs other/repo#9. Part of #7.\n\nCloses #9.\n',
    );
    // A qualified own reference closes the ticket; one naming the epic counts as a mention.
    expect(prBody('Closes Acme/Widgets#9. Part of acme/widgets#7.', 9, 7, repo)).toBe(
      'Closes Acme/Widgets#9. Part of acme/widgets#7.',
    );
    expect(prBody('Fixes acme/widgets#10 and closes #9. Part of #7.', 9, 7, repo)).toBe(
      'Refs acme/widgets#10 and closes #9. Part of #7.',
    );
    expect(
      prBody('Resolves https://github.com/acme/widgets/issues/10. Part of #7.', 9, 7, repo),
    ).toBe('Refs https://github.com/acme/widgets/issues/10. Part of #7.\n\nCloses #9.\n');
    expect(prBody('Fixes: https://github.com/acme/widgets/issues/9\n\nBody.', 9, 7, repo)).toBe(
      'Fixes: https://github.com/acme/widgets/issues/9\n\nBody.\n\nPart of #7.\n',
    );
  });

  it('adds the dependency line to a slice that depends on the previous one', () => {
    expect(withDependency('## Summary\n\nA loader.\n', 21)).toBe(
      '## Summary\n\nA loader.\n\nDepends on #21.',
    );
    expect(withDependency('Body', undefined)).toBe('Body');
  });

  it('writes a split marker at column 0 that parseSplit reads back', () => {
    const text = prompts.SplitComment({
      issueComment: 'Too large for one PR.',
      slices: [21, 22],
      rationale: 'The loader needs the registry.',
    }).text;
    expect(text).toContain('Slices: #21, #22. This ticket closes when they have all landed.');
    expect(text).toMatch(/^<!-- epic:split 21,22 -->$/m);
    expect(parseSplit([{ author: 'epic-bot', body: text }], 'epic-bot', 9)).toEqual([21, 22]);
    expect(parseSplit([{ author: 'someone', body: text }], 'epic-bot', 9)).toBeNull();
  });

  it('renders the close-split and decision comments on one line', () => {
    expect(prompts.CloseSplitComment({ slices: [21, 22] }).text).toBe(
      'All slices of this ticket have landed (#21, #22); closing.',
    );
    expect(prompts.DecisionComment({ decision: 'Use the system palette.' }).text).toBe(
      '**Decision** (from the maintainer): Use the system palette.',
    );
  });
});

describe('tickBody', () => {
  const body = [
    '## Items',
    '',
    '- [x] #1 Done',
    '- [ ] #2 Next',
    '  - [ ] #3 Nested',
    '```',
    '- [ ] #4 In a fence',
    '```',
    '- [ ] `#5` code then #6 real',
  ].join('\n');

  it('ticks only the unchecked line of the ticket, keeping everything else', () => {
    expect(tickBody(body, 2, repo)).toBe(body.replace('- [ ] #2', '- [x] #2'));
    expect(tickBody(body, 3, repo)).toBe(body.replace('- [ ] #3', '- [x] #3'));
    expect(tickBody(body, 6, repo)).toBe(body.replace('- [ ] `#5`', '- [x] `#5`'));
  });

  it('returns null when the ticket is already ticked, unlisted or only in a fence', () => {
    expect(tickBody(body, 1, repo)).toBeNull();
    expect(tickBody(body, 4, repo)).toBeNull();
    expect(tickBody(body, 5, repo)).toBeNull();
    expect(tickBody(body, 99, repo)).toBeNull();
  });

  it('keeps CRLF line endings and honors same-repository qualified references', () => {
    const crlf = '- [ ] acme/widgets#2 Next\r\n- [ ] other/repo#3 Other\r\n';
    expect(tickBody(crlf, 2, repo)).toBe(
      '- [x] acme/widgets#2 Next\r\n- [ ] other/repo#3 Other\r\n',
    );
    expect(tickBody(crlf, 3, repo)).toBeNull();
  });

  it('masks fenced code, including an unclosed fence', () => {
    expect(fenceMask(['a', '~~~', 'b', '~~~', 'c', '```js', 'd'])).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
      true,
    ]);
  });
});

describe('insertAfter', () => {
  const body = '## Items\n\n- [x] #1 Done\n- [ ] #2 Parent\n  - [ ] #3 Nested\n- [ ] #4 Later\n';
  const slices = [
    { number: 21, title: 'First slice' },
    { number: 22, title: 'Second\nslice' },
  ];

  it('places the slices after the parent and its nested items, in order', () => {
    expect(insertAfter(body, 2, slices, repo)).toBe(
      '## Items\n\n- [x] #1 Done\n- [ ] #2 Parent\n  - [ ] #3 Nested\n- [ ] #21 First slice\n- [ ] #22 Second slice\n- [ ] #4 Later\n',
    );
  });

  it('is idempotent, and finishes an insert an earlier attempt left partial', () => {
    const once = insertAfter(body, 2, slices, repo) ?? '';
    expect(insertAfter(once, 2, slices, repo)).toBeNull();
    const partial = body.replace('- [ ] #4', '- [ ] #21 First slice\n- [ ] #4');
    expect(insertAfter(partial, 2, slices, repo)).toBe(once);
  });

  it('appends after the last outer item, or under an Items heading, without the parent', () => {
    expect(insertAfter('- [ ] #4 Later\n  - [ ] #5 Nested\n', 2, slices.slice(0, 1), repo)).toBe(
      '- [ ] #4 Later\n  - [ ] #5 Nested\n- [ ] #21 First slice\n',
    );
    expect(insertAfter('Intro.\n\n## Items\n', 2, slices.slice(0, 1), repo)).toBe(
      'Intro.\n\n## Items\n\n- [ ] #21 First slice\n',
    );
    expect(insertAfter('Intro.', 2, slices.slice(0, 1), repo)).toBe(
      'Intro.\n\n## Items\n\n- [ ] #21 First slice\n',
    );
  });
});

describe('landingNotes and ledgerLine', () => {
  const facts = {
    standingNotes: ['Keep the API frozen.'],
    ticket: 9,
    epic: 7,
    planFile: '/state/epic-7/issue-9/plan.json',
    verifyOnPr: [],
    deviations: [],
  };

  it('adds the ticket note, and the verify-on-pr and deviation notes only when present', () => {
    const plain = landingNotes(facts);
    expect(plain).toHaveLength(2);
    expect(plain[0]).toBe('Keep the API frozen.');
    expect(plain[1]).toContain(
      'This PR implements #9 of epic #7 and was written by the execute-epic-ticket workflow from the plan in /state/epic-7/issue-9/plan.json.',
    );
    const full = landingNotes({
      ...facts,
      planFile: null,
      verifyOnPr: [{ id: 'a2', check: 'CI job\nunder 10 minutes' }],
      deviations: [{ id: 'a3', reason: 'Measured 900 lines.' }],
    });
    expect(full).toHaveLength(4);
    expect(full[1]).not.toContain('from the plan');
    expect(full[2]).toContain('[a2] CI job under 10 minutes');
    expect(full[3]).toContain('[a3] Measured 900 lines.');
    for (const note of full) expect(note).not.toContain('\n');
  });

  it('writes one JSON line per landing', () => {
    const line = ledgerLine({
      ticket: 9,
      title: 'Add a widget',
      pr: 42,
      mergeCommit: '9e8d7c6',
      implementer: 'mechanic',
      landing: { threads: 0, fixes: 1 },
      followups: [51],
      at: '2026-10-22T00:00:00.000Z',
    });
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      ticket: 9,
      title: 'Add a widget',
      pr: 42,
      mergeCommit: '9e8d7c6',
      implementer: 'mechanic',
      landing: { threads: 0, fixes: 1 },
      followups: [51],
      at: '2026-10-22T00:00:00.000Z',
    });
  });
});

describe('epic.md', () => {
  it('renders the epic body and the native item table', () => {
    const statuses = itemStatuses(selection);
    const table = renderItemsTable(
      [
        items[0] ?? item(1),
        item(4, {
          title: 'Pipe | in title',
          dependsOn: [1, 9],
          blockedBy: [{ number: 12, state: 'CLOSED' }],
        }),
        item(2, { pullRequests: [{ number: 20, state: 'OPEN' }], checked: null }),
      ],
      statuses,
    );
    expect(table.split('\n').slice(2, 5)).toEqual([
      '| #1 | Ticket 1 | closed | x | - | - |',
      '| #4 | Pipe \\| in title | waiting |   | #1, #9 (open), #12 | - |',
      '| #2 | Ticket 2 | in-flight | - | - | #20 |',
    ]);
    const epic = renderEpic(
      { number: 7, title: 'Epic', state: 'OPEN', url: 'https://x/7', body: 'Body.' },
      [],
      statuses,
      '2026-10-22T00:00:00.000Z',
    );
    expect(epic).toContain(
      '# #7 Epic\n\nState: OPEN · https://x/7\n\nBody.\n\n## Items as of the last survey (2026-10-22T00:00:00.000Z)',
    );
  });

  it('escapes backslashes so a title cannot break out of its cell', () => {
    const table = renderItemsTable(
      [item(5, { title: 'Back\\|slash' }), item(6, { title: 'Trailing\\' })],
      itemStatuses(selection),
    );
    const rows = table.split('\n').slice(2, 4);
    expect(rows).toEqual([
      '| #5 | Back\\\\\\|slash | ready |   | - | - |',
      '| #6 | Trailing\\\\ | ready |   | - | - |',
    ]);
    // Drop escaped characters, as GFM does, and count the column breaks left.
    for (const row of rows) expect(row.replace(/\\./g, '').split('|').length - 2).toBe(6);
  });
});

describe('EpicTicketInput', () => {
  it('keeps the native defaults', () => {
    expect(EpicTicketInput.parse({ epic: 7 })).toMatchObject({
      epic: 7,
      until: 'land',
      followupEpicTitle: 'Epic: enhancements, wave 3',
      standingNotes: [],
      maxCandidates: 3,
      implementer: 'auto',
      mergeDown: {},
      commitTrailer: '',
      checkCommand: 'npm run check',
    });
  });

  it('refuses a decision without a ticket and an unknown until', () => {
    const refused = EpicTicketInput.safeParse({ epic: 7, decision: 'Use the system palette.' });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((i) => i.message)).toEqual([
      'decision needs ticket (the ticket it answers)',
    ]);
    expect(EpicTicketInput.safeParse({ epic: 7, ticket: 9, decision: 'Yes.' }).success).toBe(true);
    expect(EpicTicketInput.safeParse({ epic: 7, until: 'merge' }).success).toBe(false);
  });

  it('passes merge-down overrides through without filling in their defaults', () => {
    expect(EpicTicketInput.parse({ epic: 7, mergeDown: { codexMode: 'github' } })).toMatchObject({
      mergeDown: { codexMode: 'github' },
    });
    expect(
      Object.keys(
        EpicTicketInput.parse({ epic: 7, mergeDown: { maxCodexRounds: 2 } })['mergeDown'] as object,
      ),
    ).toEqual(['maxCodexRounds']);
    // The child's pr, epics and notes come from the run, so an override of them is dropped.
    expect(EpicTicketInput.parse({ epic: 7, mergeDown: { pr: 3 } })['mergeDown']).toEqual({});
  });
});
