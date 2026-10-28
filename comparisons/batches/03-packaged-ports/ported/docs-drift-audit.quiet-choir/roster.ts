// Data only. The librarian and the extractor work from what code puts in their prompts (the listed
// paths and headings, the doc's text), so they have no tools; the checker reads the code; only the
// Fixer edits, and only in a runtime-owned worktree, so under --require-grants a launch with fix
// grants --grant Fixer alone. The upstream's low-effort inventory, extraction and fix are the
// Copyist tier; its default-effort check is the Scribe tier.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Librarian: {
    ...std.claude.Text,
    ...std.tiers.Copyist,
    description: 'Classifies the listed docs by audience and priority from paths and headings.',
  },
  Extractor: {
    ...std.claude.Text,
    ...std.tiers.Copyist,
    description: 'Decomposes one doc, given in its prompt, into checkable quoted claims.',
  },
  Checker: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: "Verifies one doc's claims against the code at the base commit; never edits.",
  },
  Fixer: {
    ...std.claude.Edit,
    ...std.tiers.Copyist,
    description: 'Patches one drifted doc in an isolated checkout; code checks and publishes it.',
  },
});
