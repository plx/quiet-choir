// Data only. Every entry is Codex in a read-only sandbox: an investigation that mutates the system
// contaminates its own evidence. The upstream's high-effort steps keep effort: 'high'.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Collector: {
    ...std.codex.ReadOnly,
    description: 'Collects facts for one evidence domain, without a hypothesis; never edits.',
  },
  Theorist: {
    ...std.codex.ReadOnly,
    effort: 'high',
    description: 'Generates competing, falsifiable hypotheses from the pooled evidence.',
  },
  Falsifier: {
    ...std.codex.ReadOnly,
    effort: 'high',
    description: 'Tries to falsify exactly one hypothesis by checking its predictions.',
  },
  Reporter: {
    ...std.codex.ReadOnly,
    effort: 'high',
    description: 'Writes the report from the verdicts and the confidence the workflow derived.',
  },
});
