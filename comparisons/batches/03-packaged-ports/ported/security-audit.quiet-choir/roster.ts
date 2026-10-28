// Data only. Nobody edits: the Mapper, Auditor and Skeptic read per-call snapshots of the pinned
// revision, and the Reporter works from its prompt alone. The upstream's recon and sweeps (no
// effort set) are the Scribe tier, its high-effort refutation the Skeptic tier at high effort, and
// its low-effort report the Copyist tier. CodexSkeptic takes the second seat of every three-seat
// panel when crossHarness is set.
import { defineRoster } from 'quiet-choir';
import * as std from 'quiet-choir/std';

export const roster = defineRoster({
  Mapper: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Maps entry points, trust boundaries, secrets and dependencies; never edits.',
  },
  Auditor: {
    ...std.claude.ReadOnly,
    ...std.tiers.Scribe,
    description: 'Sweeps the snapshot through one security lens for attackable flaws; never edits.',
  },
  Skeptic: {
    ...std.claude.ReadOnly,
    ...std.tiers.Skeptic,
    effort: 'high',
    description: 'Tries to refute one finding as one panel seat; never edits.',
  },
  CodexSkeptic: {
    ...std.codex.ReadOnly,
    effort: 'high',
    description:
      'A panel seat on the other harness, so a severe claim faces two models; never edits.',
  },
  Reporter: {
    ...std.claude.Text,
    ...std.tiers.Copyist,
    description: 'Writes the remediation report from the confirmed findings alone; uses no tools.',
  },
});
