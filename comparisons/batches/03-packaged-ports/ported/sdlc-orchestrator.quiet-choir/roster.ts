// Data only. A roster cannot be subset, so each workflow of the package gets its own inventory.
// Reader and Writer are delegation ceilings: under --require-grants the children's entries map
// onto them (lib/stages.ts), so one --grant Writer covers every isolated writer in the lifecycle.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const documentRoster = defineRoster({
  Author: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Drafts one lifecycle document from the goal and prior artifacts; never edits.',
  },
  Reviewer: {
    ...std.claude.ReadOnly,
    ...std.tiers.Skeptic,
    effort: 'high',
    description: 'Gates one lifecycle document before the next stage builds on it.',
  },
});

export const implementationRoster = defineRoster({
  Implementer: {
    ...std.claude.Edit,
    ...std.tiers.Mechanic,
    description: 'Implements the goal in an isolated checkout; code runs verification.',
  },
});

export const orchestratorRoster = defineRoster({
  Intake: {
    ...std.claude.ReadOnly,
    ...std.tiers.Planner,
    description: 'Tailors the ordered stage plan to the goal and the repository; never edits.',
  },
  Gatekeeper: {
    decider: 'jev',
    description: 'Screens a stage whose gate passed when autoApprove is set.',
  },
  Reader: {
    ...std.claude.ReadOnly,
    description: 'Delegation ceiling for read-only child roles; never called directly.',
  },
  Writer: {
    ...std.claude.Edit,
    description: 'Delegation ceiling for isolated child writers; never called directly.',
  },
});
