// security-audit: control flow only. Code pins the audited revision and a mapper reads a snapshot
// of it. Each lens is then one pipeline item of a settled map: its auditor sweeps, code dismisses
// findings whose file or line is absent and caps the rest, and every remaining finding goes
// straight to a severity-sized panel of skeptic seats (another settled map) without waiting for the
// other lenses. Only findings a majority upheld reach the report.
import { defineWorkflow } from 'quiet-choir';
import {
  Findings,
  SecurityAuditInput,
  SecurityAuditOutput,
  Surface,
  Verdict,
} from '../contracts.js';
import { locate, pinRevision, toRoot } from '../lib/git.js';
import {
  judge,
  plainReport,
  readOnly,
  seatsOf,
  selected,
  status,
  tally,
  triage,
  whyUnlocated,
} from '../lib/policy.js';
import { prompts } from '../prompts.js';
import { roster } from '../roster.js';

// A schema-invalid answer gets one more attempt before it counts as a failed lens or seat.
const retry = { maxAttempts: 2, on: ['schema'] } as const;

export default defineWorkflow({
  name: 'security-audit',
  version: 'packaged-03',
  description:
    'Map a pinned revision, sweep it per lens, refute each located finding with a severity-sized panel, and report the survivors.',
  roster,
  prompts: [prompts],
  input: SecurityAuditInput,
  output: SecurityAuditOutput,
  async run(ctx, input) {
    const { scope, crossHarness } = input;
    const revision = await pinRevision(ctx, input.revision);
    const root = await toRoot(ctx);
    // Every reader works in its own unchanged checkout of the revision, started at its root.
    const snapshot = { worktree: { base: { commit: revision } }, ...(root ? { cwd: root } : {}) };
    const lenses = selected(input.lenses);
    const surface = readOnly(
      await ctx.roster.Mapper.object('recon', {
        schema: Surface,
        ...snapshot,
        prompt: prompts.Recon({ scope, revision, lenses }),
      }),
    );
    // No barrier between sweep and refutation, as upstream: lenses overlap too little for a
    // cross-lens dedup to pay for idling the finished ones.
    const swept = await ctx.map(
      'lenses',
      lenses,
      { concurrency: 6, key: (lens) => lens, onError: 'return', version: 'lens/1' },
      async (lens) => {
        const { findings } = readOnly(
          await ctx.roster.Auditor.object('sweep', {
            schema: Findings,
            ...snapshot,
            retry,
            prompt: prompts.Sweep({ scope, revision, lens, surface }),
          }),
        );
        const located = await locate(
          ctx,
          revision,
          findings.map((finding) => finding.file),
        );
        const { checked, unchecked, unlocated } = triage(
          findings.map((finding) => ({ ...finding, lens })),
          (finding) => whyUnlocated(finding, located),
          input.maxFindingsPerLens,
        );
        // Seats settle, so a failed skeptic is counted by judge rather than failing its lens.
        const judged = await ctx.map('panels', checked, { concurrency: 3 }, async (finding) => {
          const seats = seatsOf(finding.severity, crossHarness);
          const verdicts = await ctx.map(
            'seats',
            seats,
            {
              concurrency: 3,
              key: ({ seat }) => String(seat),
              onError: 'return',
              version: 'refute/1',
            },
            async ({ seat, harness }) => {
              const skeptic = harness === 'codex' ? ctx.roster.CodexSkeptic : ctx.roster.Skeptic;
              return readOnly(
                await skeptic.object('refute', {
                  schema: Verdict,
                  ...snapshot,
                  retry,
                  prompt: prompts.Refute({ revision, finding, seat, seats: seats.length }),
                }),
              );
            },
          );
          return judge(finding, seats, verdicts);
        });
        return { raw: findings.length, judged, unchecked, unlocated };
      },
    );
    const audit = tally(lenses, swept);
    // The reporter sees only survivors and the gaps, so it cannot resurrect a refuted claim.
    const report = audit.confirmed.length
      ? await ctx.roster.Reporter.value('report', {
          prompt: prompts.Report({
            scope,
            revision,
            summary: surface.summary,
            confirmed: audit.confirmed,
            undecided: audit.undecided,
            failedLenses: audit.failedLenses.map((failed) => failed.lens),
            unchecked: audit.unchecked.length,
          }),
        })
      : plainReport({ ...audit, scope, revision, surface });
    return { status: status(audit), revision, surface, ...audit, report };
  },
});
