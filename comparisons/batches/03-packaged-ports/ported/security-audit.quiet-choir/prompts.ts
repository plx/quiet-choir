// The prompt index: every agent prompt as a markdown template with typed parameters. Snapshot.md,
// Evidence.md and Defensive.md are fragments under prompts/_fragments/ that the read-only stages
// include; the reporter gets the confirmed findings and the audit's gaps, never a refuted claim.
import { definePrompts, z } from 'quiet-choir';
import { Judged, Lens, LensFinding, Surface } from './contracts.js';

const audit = { scope: z.string(), revision: z.string() };

export const prompts = definePrompts(import.meta.dirname + '/prompts', {
  Recon: {
    file: 'Recon.md',
    description: 'Map the attack surface of the snapshot for the lenses that follow; no audit.',
    params: z.object({ ...audit, lenses: z.array(Lens).min(1) }),
  },
  Sweep: {
    file: 'Sweep.md',
    description: 'Audit the snapshot through one lens, armed with the recon map.',
    params: z.object({ ...audit, lens: Lens, surface: Surface }),
  },
  Refute: {
    file: 'Refute.md',
    description: 'One independent panel seat trying to refute a located finding.',
    params: z.object({
      revision: z.string(),
      finding: LensFinding,
      seat: z.int().min(1),
      seats: z.int().min(1),
    }),
  },
  Report: {
    file: 'Report.md',
    description: 'Write the remediation report from the confirmed findings and the gaps.',
    params: z.object({
      ...audit,
      summary: z.string(),
      confirmed: z.array(Judged).min(1),
      undecided: z.array(Judged),
      failedLenses: z.array(Lens),
      unchecked: z.int().nonnegative(),
    }),
  },
});
