// The tier map as a roster (ADR 0063): the native script's models and efforts, every entry spread
// from std.tiers, with the tools and limits a headless Claude Code call needs. There is no Clerk,
// Copyist or Recopyist (every mechanical step is a durable effect) and no Verifier: the verify and
// check steps verify an implementer's report structurally.
//
// Each agent works with its cwd set to the ticket worktree and the ticket's state directory added,
// so its prompt uses plain `git`, `npx` and `npm run` commands, and the allowed shell patterns below
// are exactly what prompts/_fragments/Situation.md lists. No agent may push, and none writes to
// GitHub: the workflow publishes.
//
// A run that supplies a toolchain (#735) gets the same roles from toolchainAgents: the npm rules
// are replaced by the toolchain's, and everything else (models, efforts, limits, the git and gh
// rules, the no-push rule) is read from the entries below.
import { defineRoster, type Agent, type WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import type { Toolchain } from '../merge-down.quiet-choir/contracts.js';

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
const commit = ['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git rm:*)', 'Bash(git mv:*)'];
const change = [
  ...commit,
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

const entries = {
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
} as const;

export const roster = defineRoster(entries);

/** The roster's roles, as bound agents. */
export type Staff = Record<keyof typeof entries, Agent>;

/**
 * The roster's roles for a run with a toolchain (#735): each entry's model, effort and limits, with
 * the toolchain's shell rules in place of the npm ones. A roster entry's capabilities are fixed when
 * the package loads and a roster call cannot widen them, so the roles are bound here, from the
 * entries, rather than declared twice.
 */
export function toolchainAgents(ctx: WorkflowContext, toolchain: Toolchain): Staff {
  const reading = {
    tools: [...read, 'Bash'],
    allowedTools: [...read, ...inspect, ...toolchain.read],
  };
  const editing = {
    tools: [...edit, 'Bash'],
    allowedTools: [...edit, ...inspect, ...toolchain.read, ...commit, ...toolchain.edit],
  };
  const role = (name: keyof typeof entries, shell: typeof reading): Agent => {
    const entry = entries[name];
    return ctx.claude.bind({
      model: entry.model,
      effort: entry.effort,
      maxTurns: entry.maxTurns,
      maxBudgetUsd: entry.maxBudgetUsd,
      timeoutMs: entry.timeoutMs,
      ...shell,
      disallowedTools: noPush,
    });
  };
  return {
    Planner: role('Planner', reading),
    Skeptic: role('Skeptic', reading),
    Mechanic: role('Mechanic', editing),
    Surgeon: role('Surgeon', editing),
    Scribe: role('Scribe', reading),
  };
}
