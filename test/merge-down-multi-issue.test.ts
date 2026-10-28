// A pull request that closes several issues (#736): merge-down reviews it against all of them, so
// the Situation fragment names the others and points at issue.md, and a one-issue PR reads as before.
import { describe, expect, it } from 'vitest';
import { linkedIssue } from '../packages/merge-down.quiet-choir/lib/policy.js';
import { prompts } from '../packages/merge-down.quiet-choir/prompts.js';

const situation = {
  repo: 'acme/widgets',
  pr: 27,
  title: 'Audit',
  url: 'https://github.com/acme/widgets/pull/27',
  issue: { number: 20, title: 'Audit' },
  base: 'main',
  worktree: '/w',
  branch: 'b',
  dir: '/d',
  upstreamDelta: false,
  toolchain: null,
};
const review = (alsoCloses: { number: number; title: string }[]) =>
  prompts.ReviewChange({
    situation: { ...situation, alsoCloses },
    rebase: { status: 'clean', upstreamDelta: '', resolutions: '[]', concerns: '[]' },
    standingNotes: [],
    laterInStack: 0,
    parentEpic: 4,
    unresolvedThreads: 0,
  }).text;

describe('several closed issues', () => {
  it('lists every other closing reference of this repository after the primary one', () => {
    const link = linkedIssue(
      {
        body: 'Fixes #20. Closes #10, closes #11 and fixes other/repo#3.',
        headRefName: 'x',
        closingIssues: [],
      },
      'acme/widgets',
    );
    expect(link).toMatchObject({ number: 20, closes: true, alsoCloses: [10, 11, 'other/repo#3'] });
  });

  it('names the other issues in the Situation and asks for a review against all of them', () => {
    const text = review([
      { number: 10, title: 'Raw providing' },
      { number: 11, title: 'Handle names' },
    ]);
    expect(text).toContain(
      'which implements issue #20\n"Audit" and also closes #10 "Raw providing", #11 "Handle names" (judge it against every one of them: issue.md holds them all).',
    );
  });

  it('reads as before for a one-issue PR', () => {
    expect(review([])).toContain('which implements issue #20\n"Audit". The PR is checked');
  });
});
