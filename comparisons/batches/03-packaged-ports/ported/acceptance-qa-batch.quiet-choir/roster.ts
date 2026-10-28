// Data only. Every role reads; none edits or runs commands. Probes are code effects: a human
// approves each agent-written list before code runs it, so under --require-grants no grant beyond
// read access is needed. The upstream's low-effort ingest is the Copyist tier, since it copies
// criteria verbatim; its high-effort demonstrator and breaker are the Skeptic tier at high effort.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Ingester: {
    ...std.claude.ReadOnly,
    ...std.tiers.Copyist,
    description:
      'Copies tickets and criteria exactly and notes how probes can exercise the project.',
  },
  Demonstrator: {
    ...std.claude.ReadOnly,
    ...std.tiers.Skeptic,
    effort: 'high',
    description:
      'Writes one probe per acceptance criterion against the pinned checkout; never edits.',
  },
  Breaker: {
    ...std.claude.ReadOnly,
    ...std.tiers.Skeptic,
    effort: 'high',
    description: 'Writes attack probes against a demonstrated feature; code keeps what reproduces.',
  },
});
