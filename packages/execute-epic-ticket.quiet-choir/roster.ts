// The tier map as a roster (ADR 0063): the native script's models and efforts, every entry spread
// from std.tiers, with the tools and limits a headless Claude Code call needs. There is no Clerk,
// Copyist or Recopyist (every mechanical step is a durable effect) and no Verifier: the verify and
// check steps verify an implementer's report structurally.
//
// Each agent works with its cwd set to the ticket worktree and the ticket's state directory added,
// so its prompt uses plain `git`, `npx` and `npm run` commands, and the allowed shell patterns below
// are exactly what prompts/_fragments/Situation.md lists. No agent may push, and none writes to
// GitHub: the workflow publishes.
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
  'Bash(gh pr list:*)',
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
  'Bash(npm ci:*)',
  'Bash(npm install:*)',
  'Bash(npm run build:*)',
  'Bash(npm run typecheck:*)',
  'Bash(npm run lint:*)',
  'Bash(npm run packages:rehearse:*)',
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
  Planner: {
    ...std.tiers.Planner,
    ...reader,
    description: 'Decides whether a ticket is ready, and plans it; never edits.',
    maxTurns: 150,
    maxBudgetUsd: 20,
    timeoutMs: 5_400_000,
  },
  Skeptic: {
    ...std.tiers.Skeptic,
    ...reader,
    description: 'Tries to prove an obsolete verdict wrong before a ticket is closed.',
    maxTurns: 100,
    maxBudgetUsd: 10,
    timeoutMs: 3_600_000,
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
