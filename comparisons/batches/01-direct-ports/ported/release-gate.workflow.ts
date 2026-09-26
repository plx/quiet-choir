// Direct port of hesreallyhim/ultracode-workflows; MIT, see ../LICENSE.
// Source snapshot: 9b5404d11b885b28380d3eb17471ef7b17601b5e.
import { defineWorkflow, z, type WorkflowContext } from 'quiet-choir';
import { createPort, executionInput, normalize } from './support.js';

export const meta = {
  name: 'release-gate',
  description:
    'Check every release-readiness dimension with evidence (running the checks), render an evidence-based go/no-go/conditional decision, and adversarially confirm blockers',
  whenToUse:
    'The go/no-go gate before shipping — tests, coverage-on-diff, breaking changes, security, migrations/rollback, and perf, decided from evidence not vibes',
  phases: [
    { title: 'Assess', detail: 'six readiness dimensions, with evidence' },
    { title: 'Confirm', detail: 'adversarially confirm each blocker' },
    { title: 'Decide', detail: 'go / no-go / conditional under the rubric' },
  ],
};
export const input = z.object({
  ...executionInput,
  range: z.string().optional(),
  policy: z.string().optional(),
  blockOn: z.array(z.string()).optional(),
});
async function run(ctx: WorkflowContext, args: z.infer<typeof input>) {
  const port = createPort(ctx);
  return normalize(await execute());
  async function execute() {
    const DIMENSION_SCHEMA = z
      .object({
        dimension: z.string(),
        status: z.enum(['pass', 'concern', 'blocker', 'not-applicable', 'cannot-check']),
        evidence: z
          .string()
          .describe('what was RUN/read and what it showed — command output, diff facts'),
        findings: z.array(z.string()).optional(),
      })
      .catchall(z.json());

    const CONFIRM_SCHEMA = z
      .object({
        confirmed: z.boolean().describe('true if this really should block the release'),
        reasoning: z.string(),
        downgradeTo: z
          .enum(['concern', 'not-a-problem'])
          .describe('if not confirmed, what it really is')
          .optional(),
      })
      .catchall(z.json());

    const DECISION_SCHEMA = z
      .object({
        decision: z.enum(['go', 'no-go', 'conditional-go']),
        conditions: z
          .array(z.string())
          .describe('for conditional-go: what must be true before shipping')
          .optional(),
        rationale: z.string(),
      })
      .catchall(z.json());

    const range = (args && args.range) || 'changes since the most recent release tag';
    const policy =
      (args && args.policy) ||
      'Default: tests must pass; no unaddressed high-severity security findings; breaking changes must be documented; migrations must have a rollback.';
    const blockOn = (args && args.blockOn) || ['tests', 'security'];

    // ---------------------------------------------------------------------------
    // Phase 1: Assess — six dimensions, each producing EVIDENCE by actually
    // running/reading, not by asserting. Barrier justified: the gatekeeper decides
    // from the full evidence set, and blocker confirmation needs it gathered.
    // ---------------------------------------------------------------------------

    port.phase('Assess');

    const DIMENSIONS = [
      {
        key: 'tests',
        prompt: `Run the full test suite for ${range} (find the command). Report pass/fail counts and any failing test names. status "blocker" if anything fails, "pass" if green, "cannot-check" if the suite won't run (say why).`,
      },
      {
        key: 'coverage-on-diff',
        prompt: `Assess test coverage of the CHANGED lines in ${range} specifically (not whole-repo coverage). Did the diff add untested logic, especially on error paths? status "concern" for notable gaps, "blocker" only if critical paths shipped untested.`,
      },
      {
        key: 'breaking-changes',
        prompt: `Scan the diff of ${range} for breaking changes: removed/renamed public API, changed defaults, altered response shapes, migration-requiring schema changes. Cross-check each against the changelog/release notes. status "blocker" for UNDOCUMENTED breaking changes, "pass" if none or all documented.`,
      },
      {
        key: 'security',
        prompt: `Check ${range} for security regressions: new unsanitized inputs at trust boundaries, new secrets in code, new vulnerable dependencies, weakened authz. status "blocker" for a real reachable issue, "concern" for hardening gaps. Evidence must name the code.`,
      },
      {
        key: 'migrations-rollback',
        prompt: `If ${range} includes data or schema migrations: is each reversible or paired with a rollback plan? Are they ordered safely (expand-contract)? status "blocker" for an irreversible destructive migration with no rollback, "not-applicable" if there are no migrations.`,
      },
      {
        key: 'performance',
        prompt: `Scan ${range} for likely performance regressions: new N+1 queries, unbounded loops on request paths, removed caching, sync work added to hot paths. status "concern" for plausible regressions (we rarely have prod numbers here), "blocker" only for an obvious catastrophe.`,
      },
    ];

    const assessments = (
      await port.parallel(
        'parallel-1',
        DIMENSIONS.map(
          (d) => () =>
            ctx.claude
              .object(port.id('agent-1', `assess:${d.key}`), {
                ...args.$claude,
                prompt: `Release-readiness check. Dimension: ${d.key}.
     ${d.prompt}
     House policy: ${policy}
     Ground your status in EVIDENCE — run the checks, read the diff, quote
     output. "cannot-check" (honestly) beats a guessed pass.`,
                schema: DIMENSION_SCHEMA,
                // Original effort: 'high' — no matching ClaudeOptions control.
              })
              .then((result) => result.output),
        ),
      )
    ).filter(Boolean);

    const blockers = assessments.filter((a) => a.status === 'blocker');
    const concerns = assessments.filter((a) => a.status === 'concern');
    port.log(
      `Assessed ${assessments.length} dimensions: ${blockers.length} raw blockers, ${concerns.length} concerns`,
    );

    // ---------------------------------------------------------------------------
    // Phase 2: Confirm — every blocker faces a skeptic, so the gate doesn't block
    // a release on a false alarm. A downgraded blocker becomes a concern.
    // ---------------------------------------------------------------------------

    port.phase('Confirm');

    const confirmed = (
      await port.parallel(
        'parallel-2',
        blockers.map(
          (b) => () =>
            ctx.claude
              .object(port.id('agent-2', `confirm:${b.dimension}`), {
                ...args.$claude,
                prompt: `A release-gate dimension flagged a BLOCKER. Confirm whether it truly should
     stop the release. Dimension: ${b.dimension}. Evidence: ${b.evidence}
     Findings: ${JSON.stringify(b.findings)}
     Policy: ${policy}
     Verify against the actual code/output: is it real, reachable, and in scope
     for THIS release? A flaky test, a pre-existing issue not introduced here, or
     a documented-and-accepted risk is not a blocker. confirmed=true only if
     shipping with this is genuinely wrong.`,
                schema: CONFIRM_SCHEMA,
                // Original effort: 'high' — no matching ClaudeOptions control.
              })
              .then((result) => result.output)
              .then((c) => ({ dimension: b, confirm: c })),
        ),
      )
    ).filter(Boolean);

    const realBlockers = confirmed
      .filter((c) => c.confirm && c.confirm.confirmed)
      .map((c) => c.dimension);
    const downgraded = confirmed.filter((c) => c.confirm && !c.confirm.confirmed);
    port.log(
      `${realBlockers.length}/${blockers.length} blockers confirmed, ${downgraded.length} downgraded`,
    );

    // ---------------------------------------------------------------------------
    // Phase 3: Decide — structural pre-verdict in code (confirmed blocker on a
    // blockOn dimension => no-go), then the gatekeeper writes the rationale and
    // any conditions. Code owns the gate logic; the agent owns the explanation.
    // ---------------------------------------------------------------------------

    port.phase('Decide');

    const hardBlock = realBlockers.some(
      (b) => blockOn.includes(b.dimension) || blockOn.some((k) => b.dimension.includes(k)),
    );
    const allConcerns = [...concerns, ...downgraded.map((d) => d.dimension)];

    const decision = await ctx.claude
      .object(port.id('agent-3', 'gatekeeper'), {
        ...args.$claude,
        prompt: `Render the release go/no-go decision and rationale.
   Confirmed blockers: ${JSON.stringify(
     realBlockers.map((b) => ({ dimension: b.dimension, evidence: b.evidence })),
     null,
     2,
   )}
   Concerns (non-blocking but real): ${JSON.stringify(
     allConcerns.map((c) => ({ dimension: c.dimension, findings: c.findings })),
     null,
     2,
   )}
   Hard-block dimensions (policy): ${blockOn.join(', ')}
   Structural pre-verdict from code: ${hardBlock ? 'NO-GO (a confirmed blocker hits a hard-block dimension)' : realBlockers.length ? 'confirmed blockers exist but none on hard-block dimensions — conditional-go likely' : 'no confirmed blockers — go or conditional-go on concerns'}
   Honor the pre-verdict for the decision; use conditional-go when shipping is
   OK provided named conditions are met first. Write a rationale a release
   manager can forward. Return decision + conditions + rationale.`,
        schema: DECISION_SCHEMA,
        // Original effort: 'high' — no matching ClaudeOptions control.
      })
      .then((result) => result.output);

    const finalDecision = decision
      ? decision.decision
      : hardBlock
        ? 'no-go'
        : realBlockers.length
          ? 'conditional-go'
          : 'go';

    return {
      decision: finalDecision,
      blockers: realBlockers.map((b) => ({ dimension: b.dimension, evidence: b.evidence })),
      warnings: allConcerns.map((c) => ({ dimension: c.dimension, findings: c.findings })),
      dimensions: assessments.map((a) => ({ dimension: a.dimension, status: a.status })),
      rationale: decision
        ? decision.rationale
        : `${finalDecision}: ${realBlockers.length} confirmed blockers.`,
      ...(decision && decision.conditions && decision.conditions.length
        ? { conditions: decision.conditions }
        : {}),
    };
  }
}
export default defineWorkflow({
  name: meta.name,
  version: 'ultracode-direct-01',
  input,
  output: z.json() as unknown as z.ZodType<Awaited<ReturnType<typeof run>>>,
  run,
});
