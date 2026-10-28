// Data only. Only the Setter can write, and it always works in a runtime-owned worktree; under
// --require-grants a launch grants it alone (--grant Setter). The upstream's high-effort plan is
// the Planner tier.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Surveyor: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Inventories existing setup against the specification; never edits.',
  },
  Planner: {
    ...std.claude.ReadOnly,
    ...std.tiers.Planner,
    description: 'Plans disjoint setup concerns and argv verification commands; never edits.',
  },
  Setter: {
    ...std.claude.Edit,
    ...std.tiers.Mechanic,
    description: 'Applies one approved concern to the files it owns, in an isolated checkout.',
  },
});
