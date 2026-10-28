// Data only. Code reads the PRD, lists the codebase and writes the spec, so nothing here edits: the
// grounder and the lens writers read the code, while the merger, auditors and repairer work from
// their prompts alone (std.claude.Text) and borrow the ReadOnly fragment's spend and time limits
// for a whole spec. The upstream's high-effort merge is the Planner tier and its high-effort
// verifiers the Skeptic tier at high effort. Reader and CodexReader are delegation ceilings for the
// design-tournament child under --require-grants (lib/policy.ts maps its entries onto them).
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

const long = {
  maxBudgetUsd: std.claude.ReadOnly.maxBudgetUsd,
  timeoutMs: std.claude.ReadOnly.timeoutMs,
};

export const roster = defineRoster({
  Grounder: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description:
      'Maps the architecture, conventions and constraints the spec must fit; never edits.',
  },
  LensWriter: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Drafts one technical lens of the spec and its contested decisions; never edits.',
  },
  Merger: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    ...long,
    description: 'Merges the lenses into one spec and decides every contested item; uses no tools.',
  },
  Auditor: {
    ...std.claude.Text,
    ...std.tiers.Skeptic,
    ...long,
    effort: 'high',
    description: 'Audits the spec for implementability or PRD fidelity; uses no tools.',
  },
  Repairer: {
    ...std.claude.Text,
    ...std.tiers.Scribe,
    ...long,
    description: 'Fixes the audited gaps in place, deferring to open questions; uses no tools.',
  },
  Reader: {
    ...std.claude.ReadOnly,
    description: 'Delegation ceiling for the tournament child Claude roles; never called directly.',
  },
  CodexReader: {
    ...std.codex.ReadOnly,
    description: 'Delegation ceiling for the tournament child Codex judge; never called directly.',
  },
});
