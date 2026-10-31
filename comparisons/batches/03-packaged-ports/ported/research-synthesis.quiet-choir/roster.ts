// Data only. Nothing edits, and no role holds both the repository's file tools and a web channel.
// The web roles (Scout, Reader, Hunter) replace std.claude.ReadOnly's tools with WebSearch and
// WebFetch, keeping its limits, so a fetched page that tells its reader to send a local file
// somewhere has no file to send. The local roles keep the file tools, have no web tools, and run in
// a snapshot of the pinned commit; code, not a lead's kind, decides which leads they read. The
// split is per call: the tool-less Synthesizer and Critic see every source's findings, local ones
// included, and the Critic's hunt instructions reach the web Hunter, so the Critique prompt forbids
// quoting local content in a web hunt. The upstream's low-effort sweeps and reads are the Copyist
// tier, its unspecified-effort hunts the Scribe tier, its high-effort synthesis the Planner tier and
// its high-effort critic the Skeptic tier at high effort.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

const web = ['WebSearch', 'WebFetch'] as const;

export const roster = defineRoster({
  Scout: {
    ...std.claude.ReadOnly,
    ...std.tiers.Copyist,
    tools: web,
    description: 'Finds leads through one web modality; reads nothing in depth, no file tools.',
  },
  LocalScout: {
    ...std.claude.ReadOnly,
    ...std.tiers.Copyist,
    description: 'Finds leads in a snapshot of this repository; no web tools, never edits.',
  },
  Reader: {
    ...std.claude.ReadOnly,
    ...std.tiers.Copyist,
    tools: web,
    description: 'Deep-reads one remote lead into claim and support pairs; no file tools.',
  },
  LocalReader: {
    ...std.claude.ReadOnly,
    ...std.tiers.Copyist,
    description: 'Deep-reads one repository file at the pinned commit; no web tools, never edits.',
  },
  Synthesizer: {
    ...std.claude.Text,
    ...std.tiers.Planner,
    description: 'Writes the cited answer from the keyed readings alone; uses no tools.',
  },
  Critic: {
    ...std.claude.Text,
    ...std.tiers.Skeptic,
    effort: 'high',
    description: "Finds the answer's gaps and writes a targeted hunt for each; uses no tools.",
  },
  Hunter: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    tools: web,
    description: 'Runs one targeted web hunt for a critic gap; no file tools.',
  },
  LocalHunter: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Runs one targeted hunt in the pinned repository snapshot; no web tools.',
  },
});
