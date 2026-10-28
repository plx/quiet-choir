// Data only. The Researcher reads the web and nothing else; the Analyst and the Triager read the
// repository; the Planner works from its prompt. Only the Upgrader and the Fixer write, each in a
// runtime-owned worktree, so under --require-grants a launch grants --grant Upgrader --grant Fixer.
// The upstream's high-effort plan is the Planner tier; its other calls set no effort.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Researcher: {
    ...std.claude.ReadOnly,
    tools: ['WebSearch', 'WebFetch'],
    ...std.tiers.Scribe,
    description: 'Reads the changelog and migration guide on the web; sees no repository file.',
  },
  Analyst: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Maps which files use which APIs of the package; never edits.',
  },
  Planner: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    description: 'Joins the breaking changes with the usage map into a plan; uses no tools.',
  },
  Upgrader: {
    ...std.claude.Edit,
    ...std.tiers.Mechanic,
    description: 'Applies the approved plan in an isolated checkout; code installs and verifies.',
  },
  Triager: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Clusters code-run failures by root cause in the verified checkout; never edits.',
  },
  Fixer: {
    ...std.claude.Edit,
    ...std.tiers.Mechanic,
    description: 'Fixes one failure cluster in the files it owns, in an isolated checkout.',
  },
});
