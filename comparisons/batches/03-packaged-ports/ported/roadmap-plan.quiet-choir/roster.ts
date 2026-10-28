// Data only. Code reads the spec, checks every plan against the graph and writes the roadmap, so no
// role needs a tool: every entry is std.claude.Text. The upstream ran every call at high effort:
// the decomposer, strategists and finalizer are the Planner tier, the judge and the critic the
// Skeptic tier at high effort. Each reads a whole spec or plan set at Opus, so they borrow the
// ReadOnly fragment's spend and time limits; Text's suit short answers.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

const long = {
  maxBudgetUsd: std.claude.ReadOnly.maxBudgetUsd,
  timeoutMs: std.claude.ReadOnly.timeoutMs,
};

export const roster = defineRoster({
  Decomposer: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    ...long,
    description: 'Decomposes the spec into sized, rated capabilities and their dependency graph.',
  },
  Strategist: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    ...long,
    description: 'Sequences the capabilities into gated milestones under one strategy.',
  },
  Judge: {
    ...std.claude.Text,
    ...std.tiers.Skeptic,
    ...long,
    effort: 'high',
    description: 'Scores the competing plans against the priorities and picks the winner.',
  },
  Critic: {
    ...std.claude.Text,
    ...std.tiers.Skeptic,
    ...long,
    effort: 'high',
    description: 'Stress-tests the winning plan for the ways roadmaps fail.',
  },
  Finalizer: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    ...long,
    description: 'Revises the winning plan with the graft and resolves every stress-test problem.',
  },
});
