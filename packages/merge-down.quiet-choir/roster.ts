// The tier map as a roster (ADR 0063): the native script's models and efforts, with the tools and
// limits a headless Claude Code call needs. Mechanic, Surgeon and Scribe spread std.tiers; Reviewer
// (opus, medium) and Judge (opus, xhigh) are local. There is no Clerk or Copyist: every mechanical
// step is a durable effect now.
//
// Each agent works with its cwd set to the PR worktree and the state directory added, so its prompt
// uses plain `git` and `npx` commands, and the allowed shell patterns below are what the prompts
// ask for. No agent may push, and none writes to GitHub: the workflow publishes.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

const read = ['Read', 'Grep', 'Glob'];
const edit = [...read, 'Edit', 'Write'];
const inspect = [
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(git status:*)',
  'Bash(git rev-parse:*)',
  'Bash(git blame:*)',
  'Bash(git ls-files:*)',
  'Bash(git grep:*)',
  'Bash(gh issue view:*)',
  'Bash(gh issue list:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr checks:*)',
  'Bash(gh run view:*)',
  'Bash(ls:*)',
  'Bash(wc:*)',
];
const verify = [
  'Bash(npx tsc:*)',
  'Bash(npx eslint:*)',
  'Bash(npx prettier:*)',
  'Bash(npx vitest:*)',
  'Bash(node --test:*)',
];
const change = [
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git rm:*)',
  'Bash(git mv:*)',
  'Bash(git checkout --ours:*)',
  'Bash(git checkout --theirs:*)',
  'Bash(git -c core.editor=true rebase --continue:*)',
  'Bash(npm install:*)',
  'Bash(npm ci:*)',
];
const noPush = ['Bash(git push:*)'];

const reader = {
  tools: [...read, 'Bash'],
  allowedTools: [...read, ...inspect, ...verify],
  disallowedTools: noPush,
};
const editor = {
  tools: [...edit, 'Bash'],
  allowedTools: [...edit, ...inspect, ...verify, ...change],
  disallowedTools: noPush,
};

export const roster = defineRoster({
  Reviewer: {
    harness: 'claude',
    model: 'opus',
    effort: 'medium',
    description: 'First-pass review against the issue and thread triage; never edits.',
    ...reader,
    maxTurns: 120,
    maxBudgetUsd: 15,
    timeoutMs: 3_600_000,
  },
  Judge: {
    harness: 'claude',
    model: 'opus',
    effort: 'xhigh',
    description: 'Escalated review only; its assessment replaces the first pass.',
    ...reader,
    maxTurns: 150,
    maxBudgetUsd: 25,
    timeoutMs: 5_400_000,
  },
  Mechanic: {
    ...std.tiers.Mechanic,
    ...editor,
    maxTurns: 200,
    maxBudgetUsd: 15,
    timeoutMs: 7_200_000,
  },
  Surgeon: {
    ...std.tiers.Surgeon,
    ...editor,
    maxTurns: 200,
    maxBudgetUsd: 25,
    timeoutMs: 7_200_000,
  },
  Scribe: {
    ...std.tiers.Scribe,
    ...reader,
    maxTurns: 60,
    maxBudgetUsd: 5,
    timeoutMs: 1_800_000,
  },
});
