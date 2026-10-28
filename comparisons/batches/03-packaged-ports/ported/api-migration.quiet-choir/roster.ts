// Data only. The Discoverer reads and the Triager works from its prompt alone; only the Migrator
// and the Repairer write, and only in runtime-owned worktrees, so under --require-grants a launch
// grants --grant Migrator --grant Repairer. The upstream sets no effort on any call: readers are
// the Scribe tier and editors the Mechanic tier.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Discoverer: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Finds every call site of the old API and groups them by file; never edits.',
  },
  Migrator: {
    ...std.claude.Edit,
    ...std.tiers.Mechanic,
    description: 'Migrates one approved file group in an isolated checkout; code verifies it.',
  },
  Triager: {
    ...std.claude.Text,
    ...std.tiers.Scribe,
    description: 'Clusters code-run verification failures by root cause; uses no tools.',
  },
  Repairer: {
    ...std.claude.Edit,
    ...std.tiers.Mechanic,
    description: 'Fixes one failure cluster within the approved files, in an isolated checkout.',
  },
});
