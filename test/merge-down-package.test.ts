// The pure decision rules of the merge-down package (packages/merge-down.quiet-choir/lib/policy.ts,
// #589), ported from the native merge-down-pr script and its helper CLI.
import { describe, expect, it } from 'vitest';
import {
  canonicalizeKeys,
  checkItem,
  ciItem,
  deferrable,
  ensureClosesBody,
  escalationReasons,
  failedStep,
  fallbackHeadline,
  itemsFrom,
  keepOpenBody,
  laterInStack,
  latestMajor,
  linkedIssue,
  majorBump,
  needsCommit,
  plain,
  publishPlan,
  replyFor,
  reviewFindings,
  underLimit,
  unfixed,
  unregisteredRequired,
  type FindingDecision,
  type FixReport,
  type ThreadDecision,
  type WorkItem,
} from '../packages/merge-down.quiet-choir/lib/policy.js';

const repo = 'acme/widgets';
const pr = (
  body: string,
  headRefName = 'feature/x',
  closingIssues: { number: number; repository: string }[] = [],
) => ({
  body,
  headRefName,
  closingIssues,
});

describe('linkedIssue', () => {
  it('takes GitHub closing references first', () => {
    expect(linkedIssue(pr('Refs #9', 'epic/8-x', [{ number: 7, repository: repo }]), repo)).toEqual(
      {
        number: 7,
        keyword: 'closes',
        closes: true,
        alsoCloses: [],
      },
    );
  });

  it('prefers a closing keyword anywhere in the body over an earlier Refs', () => {
    const link = linkedIssue(pr('Refs #3 for context.\n\nFixes #5.'), repo);
    expect(link).toMatchObject({ number: 5, keyword: 'fixes', closes: true });
  });

  it('accepts a reference qualified with this repository, case-insensitively', () => {
    expect(linkedIssue(pr('Resolves Acme/Widgets#12'), repo)).toMatchObject({
      number: 12,
      closes: true,
    });
  });

  it('falls back to Refs, then to the branch number', () => {
    expect(linkedIssue(pr('Refs #4'), repo)).toMatchObject({
      number: 4,
      keyword: 'refs',
      closes: false,
    });
    expect(linkedIssue(pr('No reference.', 'epic-576/589-port'), repo)).toMatchObject({
      number: 589,
      keyword: 'branch',
      closes: false,
    });
    expect(linkedIssue(pr('No reference.', 'main-work'), repo)).toBeNull();
  });

  it('reports every other closing reference in alsoCloses', () => {
    const link = linkedIssue(
      pr('Closes #5 and closes #6. Also fixes other/repo#2.', 'b', [
        { number: 5, repository: repo },
        { number: 9, repository: 'other/repo' },
      ]),
      repo,
    );
    expect(link?.number).toBe(5);
    expect(link?.alsoCloses).toEqual(['other/repo#9', 6, 'other/repo#2']);
  });
});

describe('closing keywords', () => {
  it('keep-open rewrites closing keywords for the issue, bare or qualified, to Refs', () => {
    expect(keepOpenBody('Closes #41.\nFixes acme/widgets#41 too. Closes #410.', 41, repo)).toBe(
      'Refs #41.\nRefs #41 too. Closes #410.',
    );
    expect(keepOpenBody('Refs #41.', 41, repo)).toBeNull();
  });

  it('ensure-closes appends Closes #N. only when no keyword names the issue', () => {
    expect(ensureClosesBody('Adds the widget.\n\n', 41)).toBe('Adds the widget.\n\nCloses #41.\n');
    expect(ensureClosesBody('Resolves #41', 41)).toBeNull();
    expect(ensureClosesBody('Closes #410', 41)).toBe('Closes #410\n\nCloses #41.\n');
  });
});

describe('publishPlan', () => {
  const [checked, seen, other] = ['c'.repeat(40), 'e'.repeat(40), 'f'.repeat(40)];

  it('pushes the checked head over the head this run last saw', () => {
    expect(publishPlan({ sha: checked, head: checked, remote: seen, expected: seen })).toEqual({
      action: 'push',
    });
  });

  it('skips a push that already happened', () => {
    expect(publishPlan({ sha: checked, head: checked, remote: checked, expected: seen })).toEqual({
      action: 'skip',
    });
  });

  it('refuses when the worktree HEAD drifted from the checked head', () => {
    expect(publishPlan({ sha: checked, head: other, remote: seen, expected: seen })).toHaveProperty(
      'refused',
      `worktree HEAD drifted from the checked head (HEAD ${other}, checked ${checked})`,
    );
    // Even when the remote already holds the drifted HEAD.
    expect(
      publishPlan({ sha: checked, head: other, remote: other, expected: seen }),
    ).toHaveProperty('refused');
  });

  it('refuses when someone else pushed', () => {
    expect(
      publishPlan({ sha: checked, head: checked, remote: other, expected: seen }),
    ).toHaveProperty(
      'refused',
      `remote head moved to ${other} (expected ${seen}); someone else pushed`,
    );
  });
});

describe('reviewFindings', () => {
  it('counts the [P0] to [P3] tags', () => {
    expect(reviewFindings('[P1] a\n[P2] b\n[P1] c\n[P3] d\n[P4] not a tag\nP0 bare')).toEqual({
      findings: 4,
      priorities: { P0: 0, P1: 2, P2: 1, P3: 1 },
    });
    expect(reviewFindings('No findings.').findings).toBe(0);
  });
});

const thread = (action: ThreadDecision['action'], id = 'T1'): ThreadDecision => ({
  id,
  title: `Thread ${id}`,
  verdict: 'valid',
  action,
  severity: 'major',
  complexity: 'mechanical',
  plan: 'Do it.',
  reply: '  Will do.  ',
});
const finding = (disposition: FindingDecision['disposition'], id = 'F1'): FindingDecision => ({
  id,
  title: `Finding ${id}`,
  severity: 'minor',
  disposition,
  complexity: 'subtle',
  detail: 'Detail.',
  plan: 'Plan.',
  files: ['a.ts'],
});

describe('work items', () => {
  it('maps thread fix and defer and finding fix and follow-up to keyed items', () => {
    const work = itemsFrom(
      [thread('fix', 'T1'), thread('defer', 'T2'), thread('reject', 'T3'), thread('none', 'T4')],
      [finding('fix', 'F1'), finding('follow-up', 'F2'), finding('note', 'F3')],
    );
    expect(work.fix.map((i) => i.key)).toEqual(['thread:T1', 'finding:F1']);
    expect(work.followup.map((i) => i.key)).toEqual(['thread:T2', 'finding:F2']);
    expect(work.fix[0]).toMatchObject({
      source: 'review thread',
      detail: '  Will do.  ',
      files: [],
    });
    expect(work.fix[1]).toMatchObject({ source: 'merge-down review', files: ['a.ts'] });
    expect(work.recorded).toEqual([
      { id: 'F1', title: 'Finding F1', severity: 'minor', disposition: 'fix' },
      { id: 'F2', title: 'Finding F2', severity: 'minor', disposition: 'follow-up' },
      { id: 'F3', title: 'Finding F3', severity: 'minor', disposition: 'note' },
    ]);
  });

  it('turns a failed check into a check: item, subtle after a conflicted rebase', () => {
    const failed = {
      passed: false,
      failedStep: 'lint',
      log: '/s/check-0.log',
      excerptFile: '/s/x.txt',
    };
    expect(checkItem({ ...failed, passed: true }, 'check-0', false)).toEqual([]);
    const [mechanical] = checkItem(failed, 'check-0', false);
    expect(mechanical).toMatchObject({
      key: 'check:check-0',
      title: 'Local check fails at "lint"',
      complexity: 'mechanical',
      detail: 'Failure excerpt: /s/x.txt',
    });
    expect(mechanical?.plan).toContain('/s/check-0.log');
    expect(checkItem(failed, 'check-0', true)[0]?.complexity).toBe('subtle');
  });

  it('turns red CI into a ci: item that says when it survived a rerun', () => {
    const item = ciItem({ round: 2, failed: ['test (22)'], pr: 9, repo, rerun: true });
    expect(item).toMatchObject({ key: 'ci:2', title: 'CI failed: test (22)', severity: 'major' });
    expect(item.plan).toContain('survived one re-run');
  });
});

describe('unregisteredRequired', () => {
  it('blocks a no-checks wait that has required checks, naming the unregistered ones', () => {
    expect(unregisteredRequired({ status: 'no-checks', pending: ['e2e'] }, ['test', 'e2e'])).toBe(
      'required check(s) never registered: e2e',
    );
    expect(unregisteredRequired({ status: 'no-checks', pending: [] }, ['e2e'])).toBe(
      'required check(s) never registered: e2e',
    );
  });

  it('lets no-checks pass without required checks, and other statuses through', () => {
    expect(unregisteredRequired({ status: 'no-checks', pending: [] }, [])).toBeNull();
    expect(unregisteredRequired({ status: 'success', pending: [] }, ['e2e'])).toBeNull();
    expect(unregisteredRequired({ status: 'failure', pending: ['e2e'] }, ['e2e'])).toBeNull();
  });
});

describe('replyFor', () => {
  const fixed: FixReport[] = [
    { key: 'thread:T1', status: 'fixed', commit: 'abc1234', summary: 'Done' },
    { key: 'thread:T2', status: 'partly', commit: 'def5678', summary: '' },
    { key: 'thread:T3', status: 'not-fixed', commit: '', summary: 'No' },
    { key: 'thread:T4', status: 'fixed', commit: ' ', summary: 'Without a commit' },
  ];

  it('appends Addressed in <sha> only to fixed or partly fixed threads with a commit', () => {
    expect(replyFor(thread('fix', 'T1'), fixed, null)).toEqual({
      threadId: 'T1',
      body: 'Will do.\n\nAddressed in abc1234: Done',
    });
    expect(replyFor(thread('fix', 'T2'), fixed, null)?.body).toBe(
      'Will do.\n\nAddressed in def5678.',
    );
    expect(replyFor(thread('fix', 'T3'), fixed, null)).toBeNull();
    expect(replyFor(thread('fix', 'T4'), fixed, null)).toBeNull();
    expect(replyFor(thread('fix', 'T5'), fixed, null)).toBeNull();
  });

  it('names the follow-up of a deferred thread and dismisses rejected or deferred alerts', () => {
    expect(replyFor(thread('defer', 'T6'), null, [{ key: 'thread:T6', number: 77 }])).toEqual({
      threadId: 'T6',
      body: 'Will do.\n\nTracked in #77.',
      dismiss: 'defer',
    });
    expect(replyFor(thread('reject', 'alert:3'), null, null)).toEqual({
      threadId: 'alert:3',
      body: 'Will do.',
      dismiss: 'reject',
    });
    expect(replyFor(thread('none', 'T7'), null, null)).toEqual({
      threadId: 'T7',
      body: 'Will do.',
    });
  });
});

describe('canonicalizeKeys', () => {
  const items = [
    { key: 'finding:F1' },
    { key: 'thread:F1x' },
    { key: 'finding:A' },
    { key: 'thread:A' },
  ];

  it('maps a prefix-less key only when exactly one item ends with it', () => {
    const reported = canonicalizeKeys(items, [
      { key: 'F1' },
      { key: 'A' },
      { key: 'finding:F1' },
      { key: 'Z' },
    ]);
    expect(reported.map((r) => r.key)).toEqual(['finding:F1', 'A', 'finding:F1', 'Z']);
  });
});

describe('fix round rules', () => {
  const work: WorkItem[] = [
    {
      key: 'finding:M',
      source: 's',
      title: 't',
      severity: 'minor',
      complexity: 'mechanical',
      plan: '',
      detail: '',
      files: [],
    },
    {
      key: 'finding:J',
      source: 's',
      title: 't',
      severity: 'major',
      complexity: 'mechanical',
      plan: '',
      detail: '',
      files: [],
    },
    {
      key: 'thread:T',
      source: 's',
      title: 't',
      severity: 'minor',
      complexity: 'mechanical',
      plan: '',
      detail: '',
      files: [],
    },
  ];
  const report = (key: string, status: FixReport['status'], commit = ''): FixReport => ({
    key,
    status,
    commit,
    summary: key,
  });

  it('defers only unfinished minor findings of the workflow review', () => {
    expect(deferrable(report('finding:M', 'partly'), work)).toBe(true);
    expect(deferrable(report('finding:M', 'not-fixed'), work)).toBe(true);
    expect(deferrable(report('finding:M', 'fixed'), work)).toBe(false);
    expect(deferrable(report('finding:J', 'partly'), work)).toBe(false);
    expect(deferrable(report('thread:T', 'not-fixed'), work)).toBe(false);
  });

  it('exempts check: and ci: items from needing a commit', () => {
    expect(needsCommit('check:check-0')).toBe(false);
    expect(needsCommit('ci:3')).toBe(false);
    expect(needsCommit('finding:F1')).toBe(true);
    expect(needsCommit('thread:T1')).toBe(true);
  });

  it('blocks on unfinished work and on fixed items without a commit', () => {
    const open = unfixed(
      [
        report('finding:M', 'partly'),
        report('finding:J', 'fixed', 'abc'),
        report('thread:T', 'fixed'),
        report('check:check-0', 'fixed'),
      ],
      work,
    );
    expect(open.map((i) => i.key)).toEqual(['thread:T']);
  });
});

describe('escalation', () => {
  const review = {
    escalate: false,
    escalateReason: '',
    findings: [] as {
      severity: FindingDecision['severity'];
      disposition: FindingDecision['disposition'];
    }[],
    alignment: { verdict: 'complete' },
  };

  it('stands without a reason', () => {
    expect(escalationReasons(review)).toEqual([]);
  });

  it('escalates on the flag, blockers, partial or misaligned alignment, and three major fixes', () => {
    expect(escalationReasons({ ...review, escalate: true })).toEqual([
      'reviewer requested escalation',
    ]);
    expect(
      escalationReasons({ ...review, escalate: true, escalateReason: 'Check the lock.' }),
    ).toEqual(['Check the lock.']);
    expect(
      escalationReasons({ ...review, findings: [{ severity: 'blocker', disposition: 'note' }] }),
    ).toEqual(['1 blocker finding(s)']);
    expect(escalationReasons({ ...review, alignment: { verdict: 'partial' } })).toEqual([
      'alignment is partial',
    ]);
    expect(escalationReasons({ ...review, alignment: { verdict: 'misaligned' } })).toEqual([
      'alignment is misaligned',
    ]);
    const major = { severity: 'major', disposition: 'fix' } as const;
    expect(escalationReasons({ ...review, findings: [major, major] })).toEqual([]);
    expect(escalationReasons({ ...review, findings: [major, major, major] })).toEqual([
      '3 major fixes planned',
    ]);
  });
});

describe('Codex round policy', () => {
  it('always reviews again under maxCodexRounds', () => {
    expect(underLimit({ requests: 2, maxCodexRounds: 3, hardCap: 5, latestMajor: false })).toBe(
      true,
    );
  });

  it('continues past it only while a valid major or blocker remains, up to the hard cap', () => {
    expect(underLimit({ requests: 3, maxCodexRounds: 3, hardCap: 5, latestMajor: false })).toBe(
      false,
    );
    expect(underLimit({ requests: 4, maxCodexRounds: 3, hardCap: 5, latestMajor: true })).toBe(
      true,
    );
    expect(underLimit({ requests: 5, maxCodexRounds: 3, hardCap: 5, latestMajor: true })).toBe(
      false,
    );
  });

  it('counts only valid or partly valid majors and blockers as major', () => {
    expect(latestMajor([{ severity: 'major', verdict: 'valid' }])).toBe(true);
    expect(latestMajor([{ severity: 'blocker', verdict: 'partly-valid' }])).toBe(true);
    expect(latestMajor([{ severity: 'major', verdict: 'invalid' }])).toBe(false);
    expect(latestMajor([{ severity: 'minor', verdict: 'valid' }])).toBe(false);
  });
});

describe('small rules', () => {
  it('detects a major Dependabot bump', () => {
    expect(majorBump('Bump vitest from v1.2 to v2.0')).toBe(true);
    expect(majorBump('Bump zod from 4.1.0 to 4.2.0')).toBe(false);
    expect(majorBump('Update docs')).toBe(false);
  });

  it('undoes HTML escapes in ledger text', () => {
    expect(plain('a &lt;b&gt; &quot;c&quot; &amp;amp;')).toBe('a <b> "c" &amp;');
    expect(plain(null)).toBeNull();
  });

  it('names the last npm script a check log started', () => {
    expect(failedStep('> quiet-choir@0.0.0 lint\nok\n> quiet-choir@0.0.0 typecheck\nerror')).toBe(
      'typecheck',
    );
    expect(failedStep('no scripts')).toBeNull();
  });

  it('walks the stack above a branch bottom-up', () => {
    const child = {
      number: 11,
      title: 'Child',
      body: '',
      baseRefName: 'a',
      headRefName: 'epic/2-b',
    };
    const open = [
      { number: 12, title: 'Grandchild', body: 'Refs #3', baseRefName: 'b', headRefName: 'c' },
      child,
      { number: 10, title: 'Other', body: '', baseRefName: 'main', headRefName: 'x' },
    ];
    expect(laterInStack(open, 'a')).toEqual([{ pr: 11, title: 'Child', issue: 2 }]);
    expect(
      laterInStack([...open, { ...child, number: 13, headRefName: 'b' }], 'a').map((e) => e.pr),
    ).toEqual([11, 13, 12]);
  });

  it('writes the native fallback headlines', () => {
    expect(
      fallbackHeadline({
        kind: 'change',
        fixes: [],
        threads: [],
        codexRequests: 0,
        lead: 'Adds the widget',
      }),
    ).toBe('Adds the widget. Merged with no changes needed.');
    expect(
      fallbackHeadline({
        kind: 'change',
        fixes: [{ status: 'fixed', summary: '' }],
        threads: [{ round: 1 }],
        codexRequests: 1,
        lead: '',
      }),
    ).toBe(
      'Merged with 1 fix(es) during merge-down; 1 review thread(s) triaged; Codex re-review raised findings that were handled.',
    );
    expect(
      fallbackHeadline({ kind: 'dependency', fixes: [], threads: [], codexRequests: 0, lead: '' }),
    ).toBe('Merged as-is.');
  });
});
