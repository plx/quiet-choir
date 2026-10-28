// Data only. The Planner reads; the Builder and Fixer edit, always in runtime-owned worktrees, so
// under --require-grants a launch grants --grant Builder --grant Fixer. Reader is the delegation
// ceiling of every prd-decompose and deep-code-review entry (lib/stages.ts): none of them writes.
// The upstream's high-effort planner is the Planner tier; its builders and repairers, which set
// no effort, are the Mechanic tier.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Planner: {
    ...std.claude.ReadOnly,
    ...std.tiers.Planner,
    description: 'Groups the backlog into disjoint, ordered modules; never edits.',
  },
  Builder: {
    ...std.claude.Edit,
    ...std.tiers.Mechanic,
    description: 'Implements one module inside its file areas, in an isolated checkout.',
  },
  Fixer: {
    ...std.claude.Edit,
    ...std.tiers.Mechanic,
    description: 'Fixes one module’s confirmed review findings, in an isolated checkout.',
  },
  Reader: {
    ...std.claude.ReadOnly,
    description: 'Delegation ceiling for the children’s read-only roles; never called directly.',
  },
});
