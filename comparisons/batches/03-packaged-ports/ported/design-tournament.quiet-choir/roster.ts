// Data only. Proposers and judges read, since the context may name repository paths, and never
// edit; the synthesizer works from its prompt alone and code writes the document, so nothing here
// writes. The upstream's high-effort judges are the Skeptic tier at high effort and its high-effort
// synthesis the Planner tier, which borrows the ReadOnly fragment's spend and time limits for a
// long document. CodexJudge takes every second seat when crossHarness is set. A composing parent
// under requireGrants must map it to a Codex ceiling even when crossHarness is off, since
// delegation checks every declared entry when the child starts.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Proposer: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Designs for the brief in character, as one assigned philosophy; never edits.',
  },
  Judge: {
    ...std.claude.ReadOnly,
    ...std.tiers.Skeptic,
    effort: 'high',
    description: 'Scores every anonymized proposal on the rubric as one seat; never edits.',
  },
  CodexJudge: {
    ...std.codex.ReadOnly,
    effort: 'high',
    description: 'A judge seat on the other harness, so agreement spans two models; never edits.',
  },
  Synthesizer: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    maxBudgetUsd: std.claude.ReadOnly.maxBudgetUsd,
    timeoutMs: std.claude.ReadOnly.timeoutMs,
    description: 'Builds the design on the winner and decides every losing idea; uses no tools.',
  },
});
